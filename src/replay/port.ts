/**
 * ReplayPort implementation (m03-owned): one isolated, deterministic
 * validation invocation of an exact repository revision.
 *
 * The run is one `runReplay` call: a disposable task scratch clone of the
 * configured source (never the shared source working directory), an exact
 * requested revision verified by `rev-parse` + `git rev-parse HEAD`, the
 * trusted sanitized fixture bundle materialized at its fixed safe paths in
 * the scratch checkout (missing entries only; an existing entry is accepted
 * only when byte-identical to the trusted bundle and never rewritten), and
 * then one configured target command executed as direct argv with a complete
 * credential-free environment and a deadline spanning the whole subprocess
 * + captured-stream lifetime. The repair module orchestrates the
 * before/after pair with the same bundle and owns ReplayResultV1
 * composition.
 *
 * Command authority: `request.commandId` resolves against the trusted
 * configured `RepositoryConfigV1` command registry (own-property lookup
 * only). Request/model-supplied argv, shell strings and interpolations are
 * never executed. The targeted command is the target's own code, so it is
 * target-controlled: this port refuses to run any target command unless the
 * caller injected a trusted isolation capability/attestation from a
 * restricted execution host. `clearEnv` removes inherited credentials but is
 * NOT an OS sandbox — the attestation is the boundary, and local toy tests
 * construct an explicitly trusted fixture-mode capability (never a live
 * config bypass).
 *
 * Failure semantics: spawn failure, missing executable, wrong revision,
 * timeout, unsettled descendants (uncertain cleanup — the scratch is
 * preserved for inspection, never deleted), truncated/unparseable proof and
 * unrelated non-zero exits are `unavailable` or `failed` with
 * `intended: false` — never a valid original regression. An intended failure
 * additionally requires the exact trusted matcher AND the expected executed
 * test identity from the bounded output; a pass requires exit code 0 AND the
 * expected executed test identity, so a no-op command that exits 0 without
 * executing the expected tests is never accepted as a passing regression.
 */

import {
  asFixtureDigest,
  isCommandId,
  isFixtureDigest,
  isGitSha,
  isWorkItemId,
} from "../contracts/brands.ts";
import type { FixtureDigest } from "../contracts/brands.ts";
import { portError, portOk, SystemClock } from "../contracts/ports.ts";
import type {
  Clock,
  IsolatedReplayResultV1,
  PortResultV1,
  ReplayPort,
  ReplayRunRequestV1,
} from "../contracts/ports.ts";
import type { ReplayLimitationV1 } from "../contracts/replay-result.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import { expectRestrictedRef } from "../contracts/shared.ts";
import { checkResolvedFixture, computeReplayFixtureDigest } from "./fixture.ts";
import type {
  ExpectedFailureV1,
  FixtureResolverV1,
  ReplayFixtureEntryV1,
  ReplayPolicyV1,
  ResolvedFixtureV1,
} from "./fixture.ts";
import { DenoReplayRuntime } from "./runtime.ts";
import type { ReplayCommandResultV1, ReplayRuntimeV1 } from "./runtime.ts";

// ---------------------------------------------------------------------------
// Constructor capability types
// ---------------------------------------------------------------------------

/**
 * Trusted isolation capability/attestation for the restricted execution host
 * that actually runs target-controlled commands. The production host wiring
 * injects this object; a target command is never run without it. This is the
 * smallest constructor capability Wave C needs.
 */
export interface ReplayIsolationAttestationV1 {
  version: "v1";
  /** Identity of the restricted execution host. */
  host: string;
  /**
   * True only when the host provides a real OS restricted execution boundary
   * (sandbox/container) around command execution. clearEnv is NOT a sandbox.
   */
  restrictedExecution: boolean;
  /** Non-secret description of the boundary (sandbox type, memory/FS scope). */
  boundary: string;
  /** Deterministic restricted reference to the host attestation record. */
  attestationRef: string;
}

export interface ReplayIsolationCapabilityV1 {
  attestation: ReplayIsolationAttestationV1;
}

/** Trusted, read-only source of the repository to validate. */
export type ReplaySourceV1 =
  | { kind: "local"; path: string }
  | { kind: "remote"; url: string };

export interface ReplayPortOptions {
  /** The complete trusted repository configuration (frozen contract). */
  config: RepositoryConfigV1;
  /** Explicit source the checkout is cloned from (never guessed). */
  source: ReplaySourceV1;
  /** Scratch directory for disposable per-run clones and homes. */
  scratchDir: string;
  /** Injected trusted sanitized-fixture resolver. */
  fixtures: FixtureResolverV1;
  /** Trusted bundle/test policy (scopes, bounds, proof parser). */
  policy: ReplayPolicyV1;
  /**
   * Trusted restricted-execution-host capability; required. Without it the
   * port refuses to construct, because a target-controlled command may read
   * workstation files even with clearEnv.
   */
  isolation: ReplayIsolationCapabilityV1;
  /** Process runtime; defaults to the concrete DenoReplayRuntime. */
  runtime?: ReplayRuntimeV1;
  /** Clock for run timestamps; defaults to SystemClock. */
  clock?: Clock;
}

const GIT_TIMEOUT_MS = 60_000;
const GIT_OUTPUT_BYTES = 64 * 1024;
const MAX_TEST_IDS = 64;
const TEST_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const LOCAL_SOURCE_RE = /^https?:\/\/[^\s/@]+(?::\d+)?(?:\/[^\s]*)?$/;
const FILE_SOURCE_RE = /^file:\/\/[^\s/@]+(?:\/[^\s]*)?$/;

export class ReplayPortImpl implements ReplayPort {
  private readonly runtime: ReplayRuntimeV1;
  private readonly clock: Clock;
  private readonly path: string;
  private lastUnavailableDetailText = "";

  constructor(private readonly options: ReplayPortOptions) {
    const isolation = options.isolation;
    const attestation = isolation?.attestation;
    if (
      attestation === null || attestation === undefined ||
      attestation.version !== "v1" ||
      attestation.restrictedExecution !== true ||
      typeof attestation.host !== "string" || attestation.host.length === 0 ||
      typeof attestation.boundary !== "string" ||
      attestation.boundary.length === 0 ||
      typeof attestation.attestationRef !== "string" ||
      attestation.attestationRef.length === 0
    ) {
      throw new TypeError(
        "ReplayPort requires an injected trusted isolation capability " +
          "attesting restricted execution on the host (clearEnv is not a " +
          "sandbox; target-controlled commands need the restricted host)",
      );
    }
    if (options.source.kind === "local") {
      if (
        typeof options.source.path !== "string" ||
        !options.source.path.startsWith("/")
      ) {
        throw new TypeError(
          "ReplayPort local source must be an absolute path (read-only source)",
        );
      }
    } else if (options.source.kind === "remote") {
      if (
        typeof options.source.url !== "string" ||
        (!LOCAL_SOURCE_RE.test(options.source.url) &&
          !FILE_SOURCE_RE.test(options.source.url))
      ) {
        throw new TypeError(
          "ReplayPort remote source must be an http(s)/file URL without userinfo",
        );
      }
    } else {
      throw new TypeError("ReplayPort source must be local or remote");
    }
    for (const scope of options.policy.bundleScopes) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/$/.test(scope)) {
        throw new TypeError(
          "ReplayPort policy bundle scopes must be relative scopes with a " +
            'trailing slash (e.g. "tests/")',
        );
      }
    }
    this.path = Deno.env.get("PATH") ?? "/usr/bin:/bin";
    this.runtime = options.runtime ?? new DenoReplayRuntime(this.path);
    this.clock = options.clock ?? new SystemClock();
  }

  async runReplay(
    request: ReplayRunRequestV1,
  ): Promise<PortResultV1<IsolatedReplayResultV1>> {
    const invalid = this.validateRequest(request);
    if (invalid !== null) return portError("invalid", invalid);

    // Own-property lookup only: an id like "constructor" or "toString" in a
    // registry that does not contain it must never resolve to an inherited
    // Object.prototype member and be mistaken for a configured command.
    const registry = this.options.config.commandRegistry.commands;
    if (!Object.hasOwn(registry, request.commandId)) {
      return portError(
        "invalid",
        `command ${request.commandId} is not in the trusted command registry`,
      );
    }
    const spec = registry[request.commandId];

    const resolvedResult = await this.options.fixtures.resolveFixture(
      request.fixtureRef,
    );
    if (!resolvedResult.ok) return resolvedResult;
    const resolved = resolvedResult.value;

    // Digest the actual bytes BEFORE any command runs and compare exactly.
    const actualDigest = await computeReplayFixtureDigest(resolved.entries);
    if (actualDigest !== request.fixtureDigest) {
      return portError(
        "invalid",
        `fixture digest mismatch: bundle bytes do not match the request digest ` +
          `(expected ${request.fixtureDigest}, computed ${actualDigest})`,
      );
    }
    if (!sameTestIds(request.testIds, resolved.testIds)) {
      return portError(
        "invalid",
        "request test identity does not match the trusted fixture identity",
      );
    }
    const check = checkResolvedFixture(
      resolved,
      this.options.policy,
      this.options.config.protectedPaths,
    );
    if (!check.ok) {
      return portError("invalid", check.reason);
    }

    const startedAt = this.clock.now();
    let taskDir: string | null = null;
    let preserveScratch = false;
    try {
      await Deno.mkdir(this.options.scratchDir, { recursive: true });
      taskDir = await Deno.makeTempDir({
        prefix: "sentinel-replay-",
        dir: this.options.scratchDir,
      });
      const checkoutDir = `${taskDir}/checkout`;
      const homeDir = `${taskDir}/home`;
      await Deno.mkdir(homeDir);

      // Clone the configured read-only source into the disposable scratch.
      // --no-local forces a full object copy (no hardlinks/alternates to the
      // shared source), and core.hooksPath is pinned to /dev/null per call.
      const clone = await this.runGit(homeDir, {
        cwd: taskDir,
        args: ["clone", "-q", "--no-local", this.sourceValue(), checkoutDir],
      });
      if (!clone.settled) {
        preserveScratch = true;
        return this.unavailable(
          startedAt,
          resolved,
          `git clone could not be proved settled on the owned process group; ` +
            `scratch preserved at ${taskDir}`,
        );
      }
      if (!exitedOk(clone)) {
        return this.unavailable(
          startedAt,
          resolved,
          clone.detail,
        );
      }

      // Exact full revision: the object must exist, the checkout must be the
      // exact requested commit, and HEAD must verify to the same identity.
      const verify = await this.runGit(homeDir, {
        cwd: checkoutDir,
        args: ["rev-parse", "--verify", `${request.revision}^{commit}`],
      });
      if (!verify.settled) {
        preserveScratch = true;
        return this.unavailable(
          startedAt,
          resolved,
          `git rev-parse could not be proved settled on the owned process ` +
            `group; scratch preserved at ${taskDir}`,
        );
      }
      if (!exitedOk(verify)) {
        return this.unavailable(
          startedAt,
          resolved,
          `requested revision ${request.revision} is not present in the source`,
        );
      }
      const checkout = await this.runGit(homeDir, {
        cwd: checkoutDir,
        args: ["checkout", "-q", "--detach", request.revision],
      });
      if (!checkout.settled) {
        preserveScratch = true;
        return this.unavailable(
          startedAt,
          resolved,
          `git checkout could not be proved settled on the owned process ` +
            `group; scratch preserved at ${taskDir}`,
        );
      }
      if (!exitedOk(checkout)) {
        return this.unavailable(
          startedAt,
          resolved,
          `could not check out revision ${request.revision}`,
        );
      }
      const head = await this.runGit(homeDir, {
        cwd: checkoutDir,
        args: ["rev-parse", "HEAD"],
      });
      if (!head.settled) {
        preserveScratch = true;
        return this.unavailable(
          startedAt,
          resolved,
          `git rev-parse HEAD could not be proved settled on the owned ` +
            `process group; scratch preserved at ${taskDir}`,
        );
      }
      if (
        !exitedOk(head) ||
        decodeText(head.stdout).trim() !== request.revision
      ) {
        return this.unavailable(
          startedAt,
          resolved,
          "checked out HEAD does not match the requested revision",
        );
      }

      const materialized = await this.materializeBundle(
        checkoutDir,
        resolved.entries,
      );
      if (!materialized.ok) {
        return portError("invalid", materialized.reason);
      }

      // Run the one configured target command with direct argv and the
      // bounded process environment; enforce the existing spec caps.
      const outputLimit = Math.min(
        spec.maxOutputBytes,
        request.outputLimitBytes,
      );
      const runResult = await this.runtime.run({
        executable: spec.executable,
        args: spec.args,
        cwd: checkoutDir,
        env: this.commandEnv(homeDir),
        maxDurationMs: spec.maxDurationMs,
        maxOutputBytes: outputLimit,
      });
      if (!runResult.settled) {
        // Uncertain cleanup: no proof that an owned descendant is gone, so
        // the scratch must stay for inspection instead of being deleted.
        preserveScratch = true;
        return this.unavailable(
          startedAt,
          resolved,
          `target command settlement could not be proven (` +
            `${runResult.detail}); scratch preserved at ${taskDir}`,
        );
      }
      const endedAt = this.clock.now();
      return this.finish(runResult, resolved, startedAt, endedAt);
    } catch (error) {
      return portError(
        "unavailable",
        `replay run failed: ${boundedDetail(error)}`,
      );
    } finally {
      if (taskDir !== null && !preserveScratch) {
        try {
          await Deno.remove(taskDir, { recursive: true });
        } catch {
          // Disposable scratch; the run result above is authoritative.
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal pipeline helpers
  // -------------------------------------------------------------------------

  private sourceValue(): string {
    return this.options.source.kind === "local"
      ? this.options.source.path
      : this.options.source.url;
  }

  private runGit(
    homeDir: string,
    input: { cwd: string; args: string[] },
  ): Promise<ReplayCommandResultV1> {
    return this.runtime.run({
      executable: "git",
      args: input.args,
      cwd: input.cwd,
      env: this.gitEnv(homeDir),
      maxDurationMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_OUTPUT_BYTES,
    });
  }

  /**
   * Credential-free git environment: PATH, disposable HOME and explicit
   * config isolation (no global/system config, no credential helpers or
   * hooks, no terminal prompt). These variables go only to git children.
   */
  private gitEnv(homeDir: string): Record<string, string> {
    return {
      PATH: this.path,
      HOME: homeDir,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
    };
  }

  /**
   * Target-command environment: trusted runtime PATH plus a disposable HOME
   * (and its DENO_DIR) and NO_COLOR for stable output. No host/model
   * credentials or workstation configuration reach the child.
   */
  private commandEnv(homeDir: string): Record<string, string> {
    return {
      PATH: this.path,
      HOME: homeDir,
      DENO_DIR: `${homeDir}/.cache/deno`,
      NO_COLOR: "1",
    };
  }

  /**
   * Materialize the trusted bundle at its fixed safe paths.
   *
   * Missing entries are written only. A safe existing target is accepted
   * ONLY when its bytes are byte-identical to the trusted attested bundle —
   * an actual candidate that already contains the permanent regression
   * and recorded fixture must replay without rewriting them. Different
   * bytes, directories, symlinks and unsafe (symlink/non-directory)
   * ancestors are rejected before any target command runs.
   */
  private async materializeBundle(
    checkoutDir: string,
    entries: readonly ReplayFixtureEntryV1[],
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const sorted = [...entries].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    );
    const existing: string[] = [];
    for (const entry of sorted) {
      const conflict = await bundleTargetConflict(
        checkoutDir,
        entry.path,
        entry.bytes,
      );
      if (conflict !== null) return { ok: false, reason: conflict };
      const target = `${checkoutDir}/${entry.path}`;
      if (await targetExists(target)) existing.push(entry.path);
    }
    // Materialize ONLY the missing safe entries; already-present entries are
    // byte-identical (verified above) and are deliberately NOT rewritten.
    for (const entry of sorted) {
      if (existing.includes(entry.path)) continue;
      const target = `${checkoutDir}/${entry.path}`;
      const parent = target.slice(0, target.lastIndexOf("/"));
      await Deno.mkdir(parent, { recursive: true });
      await Deno.writeFile(target, entry.bytes);
    }
    return { ok: true };
  }

  private async finish(
    runResult: ReplayCommandResultV1,
    resolved: ResolvedFixtureV1,
    startedAt: number,
    endedAt: number,
  ): Promise<PortResultV1<IsolatedReplayResultV1>> {
    const limitations: ReplayLimitationV1[] = [];
    if (runResult.truncated) limitations.push("output_truncated");
    if (resolved.provenance.redacted) limitations.push("fixture_redacted");

    if (
      runResult.outcome === "spawn_failed" || runResult.outcome === "timed_out"
    ) {
      this.lastUnavailableDetailText = boundedDetail(runResult.detail);
      return portOk({
        outcome: "unavailable",
        exitCode: null,
        output: null,
        failure: null,
        limitations,
        startedAt,
        endedAt,
      });
    }

    const stdoutDigest = runResult.stdout.byteLength === 0
      ? null
      : sha256Hex(runResult.stdout);
    const stderrDigest = runResult.stderr.byteLength === 0
      ? null
      : sha256Hex(runResult.stderr);
    const output = {
      stdoutDigest: await stdoutDigest,
      stderrDigest: await stderrDigest,
      truncated: runResult.truncated,
    };

    const text = decodeText(runResult.stdout) + decodeText(runResult.stderr);
    const proof = this.options.policy.proof.parse(text);
    const executedExpected = proof.parsed &&
      resolved.testIds.every((id) => proof.testIds.includes(id));

    if (runResult.exitCode === 0) {
      // A pass needs the expected executed test identity and untruncated
      // output: an exit-0 no-op that never ran the expected tests is
      // unavailable, never a passing regression.
      if (!executedExpected || runResult.truncated) {
        return portOk({
          outcome: "unavailable",
          exitCode: null,
          output: null,
          failure: null,
          limitations,
          startedAt,
          endedAt,
        });
      }
      return portOk({
        outcome: "passed",
        exitCode: 0,
        output,
        failure: null,
        limitations,
        startedAt,
        endedAt,
      });
    }

    // Non-zero exit: intended only with exact matcher + test identity and no
    // truncation; anything else is an unrelated failure.
    const intended = !runResult.truncated && executedExpected &&
      matchesExpected(text, resolved.expectedFailure);
    return portOk({
      outcome: "failed",
      exitCode: runResult.exitCode,
      output,
      failure: intended
        ? { intended: true, reason: resolved.expectedFailure.reason }
        : {
          intended: false,
          reason: `command exited with code ${runResult.exitCode}; ` +
            (runResult.truncated
              ? "output was truncated"
              : "expected failure signature not matched"),
        },
      limitations,
      startedAt,
      endedAt,
    });
  }

  private unavailable(
    startedAt: number,
    resolved: ResolvedFixtureV1,
    detail: string,
  ): PortResultV1<IsolatedReplayResultV1> {
    // The frozen port interface records an unavailable run as outcome only
    // (no durable detail field); the bounded diagnostic detail is kept on the
    // concrete instance for the orchestrator's local logs and never persisted
    // into a ReplayResultV1.
    this.lastUnavailableDetailText = boundedDetail(detail);
    const limitations: ReplayLimitationV1[] = [];
    if (resolved.provenance.redacted) limitations.push("fixture_redacted");
    return portOk({
      outcome: "unavailable",
      exitCode: null,
      output: null,
      failure: null,
      limitations,
      startedAt,
      endedAt: this.clock.now(),
    });
  }

  /**
   * Bounded diagnostic detail of the most recent unavailable run (empty when
   * the last run was not unavailable). Local diagnostics only — the durable
   * ReplayResultV1 carries no such field (reporting dependency: the frozen
   * interface has no bounded unavailable-reason field).
   */
  lastUnavailableDetail(): string {
    return this.lastUnavailableDetailText;
  }

  private validateRequest(
    request: ReplayRunRequestV1,
  ): string | null {
    if (!isWorkItemId(request.taskId)) {
      return "invalid work item id";
    }
    const repo = request.repository;
    const configRepo = this.options.config.repository;
    if (
      repo.owner !== configRepo.owner || repo.name !== configRepo.name ||
      repo.installationId !== configRepo.installationId
    ) {
      return "replay request repository does not match the configured repository";
    }
    if (!isGitSha(request.revision)) {
      return "invalid revision (expected an exact 40-hex Git SHA)";
    }
    if (!isCommandId(request.commandId)) {
      return "invalid command id";
    }
    if (
      typeof request.fixtureRef !== "string" ||
      request.fixtureRef.length === 0
    ) {
      return "invalid fixture reference";
    }
    try {
      expectRestrictedRef(request.fixtureRef, "$.fixtureRef");
    } catch {
      return "fixture reference must be an opaque restricted storage reference";
    }
    if (!isFixtureDigest(request.fixtureDigest)) {
      return "invalid fixture digest";
    }
    if (
      !Array.isArray(request.testIds) || request.testIds.length === 0 ||
      request.testIds.length > MAX_TEST_IDS
    ) {
      return "invalid test identity";
    }
    const seen = new Set<string>();
    for (const id of request.testIds) {
      if (typeof id !== "string" || !TEST_ID_RE.test(id)) {
        return `invalid test id: ${testIdForMessage(id)}`;
      }
      if (seen.has(id)) return "duplicate test id in request";
      seen.add(id);
    }
    if (
      typeof request.outputLimitBytes !== "number" ||
      !Number.isSafeInteger(request.outputLimitBytes) ||
      request.outputLimitBytes <= 0
    ) {
      return "invalid output limit";
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Free helpers (no external dependencies; no shell anywhere)
// ---------------------------------------------------------------------------

function exitedOk(result: ReplayCommandResultV1): boolean {
  return result.outcome === "exited" && result.exitCode === 0;
}

function sameTestIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

async function sha256Hex(bytes: Uint8Array): Promise<FixtureDigest> {
  // Copy to a plain ArrayBuffer view: crypto.subtle demands a non-shared
  // ArrayBuffer, and the retained bytes may be a subarray of a larger chunk.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return asFixtureDigest(hex);
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function matchesExpected(
  text: string,
  expected: ExpectedFailureV1,
): boolean {
  if (expected.match.kind === "contains") {
    return text.includes(expected.match.text);
  }
  try {
    return new RegExp(expected.match.source, "m").test(text);
  } catch {
    return false;
  }
}

/**
 * Fail-closed materialization guard. Every ancestor is lstat-checked — a
 * symlink ancestor or an existing file/dir at the target is rejected (the
 * bundle must never rewrite existing repository content or escape through a
 * checked-out symlink). An existing REGULAR FILE target is accepted only
 * when byte-identical to the trusted bundle bytes ("the actual candidate
 * already contains the permanent regression"), and is never rewritten;
 * different bytes and any non-regular target are rejected.
 */
async function bundleTargetConflict(
  checkoutRoot: string,
  relativePath: string,
  expectedBytes: Uint8Array,
): Promise<string | null> {
  const segments = relativePath.split("/");
  let current = checkoutRoot;
  for (let i = 0; i < segments.length; i++) {
    const candidate = `${current}/${segments[i]}`;
    let info: Deno.FileInfo | null = null;
    try {
      info = await Deno.lstat(candidate);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      return `could not inspect bundle target path: ${relativePath}`;
    }
    if (info.isSymlink) {
      return `bundle target resolves through a symlink: ${relativePath}`;
    }
    if (i === segments.length - 1) {
      if (info.isFile) {
        const existing = await Deno.readFile(candidate);
        if (!bytesEqual(existing, expectedBytes)) {
          return `bundle target exists with different bytes and will not be ` +
            `rewritten: ${relativePath}`;
        }
        return null;
      }
      if (info.isDirectory) {
        return `bundle target is a directory: ${relativePath}`;
      }
      return `bundle target is not a regular file: ${relativePath}`;
    }
    if (!info.isDirectory) {
      return `bundle target path component is not a directory: ${relativePath}`;
    }
    current = candidate;
  }
  return null;
}

async function targetExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function testIdForMessage(value: unknown): string {
  if (typeof value !== "string") return "non-string";
  if (value.length > 40) return `${value.slice(0, 40)}…`;
  return value;
}

function boundedDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const single = text.replace(/[\r\n\t]+/g, " ").trim();
  return single.length === 0 ? "unknown error" : single.slice(0, 240);
}
