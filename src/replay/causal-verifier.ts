/**
 * Concrete trusted causal verifier (plan 01): one fixed local Deno consumer
 * execution protocol over the SAME original Git revision.
 *
 * The boundary is concrete, not an oracle: the verifier materializes TWO
 * independent exact-original-SHA source snapshots from the configured local
 * Git source (never the shared working directory, never the model/candidate
 * checkout), writes the private original request/upstream into ONE disposable
 * restricted verifier scratch snapshot and the exact composed sanitized
 * bundle into the other, and then executes the SAME committed trusted
 * consumer script in both snapshots by invoking the installed Deno binary
 * DIRECTLY under the macOS sandbox-exec seatbelt profile embedded below,
 * with the fixed no-prompt/no-config/no-remote protocol and read permission
 * confined to that snapshot — no env/network/run/ffi/write permissions, no
 * `deno task`, no target- or request-supplied argv, permissions or matchers.
 * A proof is returned ONLY when BOTH executions are exited and settled,
 * untruncated, exit with code 1, keep stderr empty and print on stdout the
 * EXACT supported safe failure protocol: one `sentinel-replay-test:<id>\n`
 * line per trusted id in trusted order, followed by exactly one fixed
 * `sentinel-causal-failure:stream terminated unexpectedly\n` line. Nothing
 * more, nothing less: any extra/private/unrelated diagnostic line, any
 * duplicate, reordered, missing or extra id, any nonzero stderr stream or
 * any other exit code is NO evidence.
 *
 * The protocol is exact bytes, never a matcher over arbitrary output: the
 * proof carries per-execution OBSERVED evidence (exit code 1, the trusted
 * test identity actually printed, the digest over EXACTLY those validated
 * safe fixed protocol bytes) plus the fixed safe expected-failure identity
 * label. Raw private request/upstream bytes, the private snapshot paths and
 * raw consumer output never leave this module: they stay in a disposable
 * restricted task directory, and the proof carries only digests/
 * classification over the fixed safe protocol. The private original files
 * are never exported, never logged and never placed in the model/candidate
 * checkout. The output digest is an observed-execution binding for
 * already-classified intended failures ONLY over the exact validated safe
 * protocol bytes — arbitrary or private diagnostics are never accepted and
 * never hashed.
 *
 * The OS boundary profile is the FIXED deny-by-default seatbelt profile that
 * the host acceptance receipts validated (byte-copy of the immutable
 * /tmp/sentinel-deno-import-boundary-profile-v3-20260909.sb): it allows the
 * installed Deno binary, its dyld support, the ONE snapshot directory of the
 * current run and that run's OWN cache directory, plus /dev/urandom|null,
 * localtime, sysctl and mach-lookup — nothing else. Network, fork (process
 * execution of anything but the Deno binary), writes outside the cache and
 * reads outside the snapshot/cache are denied by the kernel. Deno's own
 * permissions remain ADDITIONAL restrictions on top of the OS boundary.
 * Cwd is the current snapshot so relative Deno reads resolve inside it.
 *
 * On a non-macOS host, a missing sandbox-exec, an unresolved realpath or any
 * sandbox/policy failure the verifier returns NO proof. There is NO
 * Deno-only fallback and NO import-scanner substitute: the OS boundary is
 * the requirement, not an optimization.
 *
 * Scope: this is a REAL Deno permission boundary for the supported local
 * consumer (read confined to the snapshot, everything else denied), not a
 * production OS sandbox for arbitrary target commands — the ReplayPort's
 * injected restricted-execution attestation remains the production isolation
 * gate and is untouched here.
 */

import { isGitSha } from "../contracts/brands.ts";
import type {
  CommandId,
  EncryptedArtifactDigest,
  FixtureDigest,
  GitSha,
} from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { RetainedGatewayCaptureV1 } from "../adapters/gateway/decrypt.ts";
import {
  CAUSAL_CONSUMER_COMMAND_ID,
  deriveExpectedFailureIdentity,
  GATEWAY_CAUSAL_VERIFIER_ID,
  gatewayCausalProofRef,
} from "./causal-proof.ts";
import type {
  CausalExecutionObservationV1,
  GatewayCausalProofV1,
} from "./causal-proof.ts";
import { computeReplayFixtureDigest, isSafeBundlePath } from "./fixture.ts";
import type { ExpectedFailureV1, ReplayFixtureEntryV1 } from "./fixture.ts";
import { DenoReplayRuntime } from "./runtime.ts";
import type { ReplayCommandResultV1, ReplayRuntimeV1 } from "./runtime.ts";

// ---------------------------------------------------------------------------
// Verifier port types (consumed by the trusted gateway composition)
// ---------------------------------------------------------------------------

/**
 * Trusted causal-proof verifier input. The private capture is consumed in
 * trusted process memory; `fixtureEntries` are the EXACT composed sanitized
 * bundle bytes at their fixed paths. Callers must never persist, log or
 * return the raw request/upstream or private sentinel data.
 */
export interface GatewayCausalVerifierInputV1 {
  /** Private authenticated capture (restricted; process memory only). */
  capture: RetainedGatewayCaptureV1;
  repository: RepositoryIdentityV1;
  incidentId: string;
  captureId: string;
  /** Authenticated encrypted-artifact digest of the retained artifact. */
  artifactDigest: EncryptedArtifactDigest;
  fixtureRef: string;
  bundleDigest: FixtureDigest;
  replayCommandId: CommandId;
  testCommandId: CommandId;
  testIds: readonly string[];
  expectedFailure: ExpectedFailureV1;
  /**
   * The exact composed sanitized bundle entries (paths + bytes). Only the
   * entries at the verifier's fixed consumer paths are accepted; the bytes
   * are written verbatim into the sanitized snapshot.
   */
  fixtureEntries: readonly ReplayFixtureEntryV1[];
}

/** Trusted verifier capability: a fully bound proof or no proof at all. */
export interface GatewayCausalVerifierV1 {
  verify(
    input: GatewayCausalVerifierInputV1,
  ): Promise<GatewayCausalProofV1 | null>;
}

// ---------------------------------------------------------------------------
// Trusted constructor inputs (fixed host config; never capture/model argv)
// ---------------------------------------------------------------------------

export interface GatewayLocalCausalVerifierOptionsV1 {
  /** Exact local source repository (read-only; absolute path). */
  sourcePath: string;
  /** Disposable restricted scratch root (absolute). */
  scratchDir: string;
  /** Root-relative fixed trusted consumer script (exists at the original SHA). */
  consumerPath: string;
  /** Root-relative fixed request fixture path the trusted consumer reads. */
  consumerRequestPath: string;
  /** Root-relative fixed upstream fixture path the trusted consumer reads. */
  consumerUpstreamPath: string;
  /** Installed Deno binary (absolute path; trusted host input). */
  denoPath: string;
  /** Wall-clock bound for one consumer execution. */
  maxDurationMs: number;
  /** Combined retained output bound for one consumer execution. */
  maxOutputBytes: number;
  /**
   * Installed sandbox-exec binary (absolute path). The production value is
   * the fixed /usr/bin/sandbox-exec; injectable only for the missing-sandbox
   * negative path.
   */
  sandboxExecPath?: string;
  /**
   * Platform override for deterministic tests; defaults to Deno.build.os.
   * The sandbox boundary exists ONLY on macOS (darwin), never elsewhere.
   */
  osName?: string;
  /** Process runtime; defaults to the concrete DenoReplayRuntime. */
  runtime?: ReplayRuntimeV1;
}

// ---------------------------------------------------------------------------
// Constants and limits
// ---------------------------------------------------------------------------

/**
 * The ONLY consumer path bound to the fixed trusted-consumer command
 * identity (`CAUSAL_CONSUMER_COMMAND_ID`): an interchangeable arbitrary
 * consumerPath is rejected at construction. The consumer is the committed
 * script the trusted replay task runs, executed directly with the fixed
 * protocol (never `deno task`).
 */
export const CAUSAL_CONSUMER_PATH = "scripts/replay.ts";

/** Installed macOS sandbox-exec binary (proven by the host receipts). */
export const CAUSAL_SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/**
 * Fixed deny-by-default seatbelt profile. Byte-copy of the immutable
 * /tmp/sentinel-deno-import-boundary-profile-v3-20260909.sb (host acceptance
 * receipt cc48556d…): the only reads are the installed Deno binary, the
 * single snapshot of the current run, that run's own cache, the System
 * library paths, localtime and the urandom/null devices; the only writes are
 * under that cache and /dev/null; execution is limited to the Deno binary.
 * Every sibling snapshot, shared cache, repo working tree, user/source/task
 * root and network/fork path stays denied.
 */
const CAUSAL_SANDBOX_PROFILE = `(version 1)
(deny default)
(import "dyld-support.sb")
(allow file-map-executable (literal (param "DENO")) (subpath "/System") (subpath "/usr/lib") (subpath "/Library/Apple"))
(allow process-exec (literal (param "DENO")))
(allow sysctl-read)
(allow mach-lookup)
(allow file-read-metadata)
(allow file-read-data
  (literal (param "DENO"))
  (subpath (param "SNAPSHOT"))
  (subpath (param "CACHE"))
  (subpath "/System")
  (subpath "/usr/lib")
  (subpath "/Library/Apple")
  (literal "/private/etc/localtime")
  (literal "/dev/urandom")
  (literal "/dev/random")
  (literal "/dev/null"))
(allow file-write* (subpath (param "CACHE")) (literal "/dev/null"))
`;

const GIT_TIMEOUT_MS = 60_000;
const GIT_OUTPUT_BYTES = 64 * 1024;
const MAX_TEST_IDS = 64;
const TEST_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_FAILURE_REASON_BYTES = 512;
const MAX_LIMIT_MS = 600_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * The ONE supported safe failure protocol for this narrow local consumer:
 * stdout is exactly one `sentinel-replay-test:<id>\n` line per trusted id in
 * trusted order, followed by exactly this single fixed failure line, with
 * empty stderr and exit code 1. The only accepted expected-failure matcher
 * is the fixed contains matcher over `SAFE_CONSUMER_FAILURE_TEXT`; any other
 * matcher is rejected before anything runs, so the classifier never matches
 * arbitrary output content and never hashes anything but the exact
 * validated safe protocol bytes.
 */
const SAFE_CONSUMER_FAILURE_TEXT = "stream terminated unexpectedly";
const SAFE_CONSUMER_FAILURE_LINE =
  `sentinel-causal-failure:${SAFE_CONSUMER_FAILURE_TEXT}`;

/**
 * Concrete trusted local consumer verifier. All constructor inputs are
 * trusted host configuration; every capture-derived value is bounded and
 * validated before any file is placed or any command runs. Any unresolved
 * condition returns null (no proof) — it never fabricates a proof and never
 * weakens the consuming boundary.
 */
export class GatewayLocalCausalVerifier implements GatewayCausalVerifierV1 {
  private readonly path: string;
  private readonly runtime: ReplayRuntimeV1;
  private readonly sandboxExecPath: string;
  private readonly osName: string;

  constructor(private readonly options: GatewayLocalCausalVerifierOptionsV1) {
    if (
      typeof options.sourcePath !== "string" ||
      !options.sourcePath.startsWith("/")
    ) {
      throw new TypeError(
        "GatewayLocalCausalVerifier requires an absolute local source path",
      );
    }
    if (
      typeof options.scratchDir !== "string" ||
      !options.scratchDir.startsWith("/")
    ) {
      throw new TypeError(
        "GatewayLocalCausalVerifier requires an absolute scratch root",
      );
    }
    if (
      typeof options.denoPath !== "string" ||
      !options.denoPath.startsWith("/") ||
      options.denoPath.length === 0
    ) {
      throw new TypeError(
        "GatewayLocalCausalVerifier requires an absolute installed Deno binary",
      );
    }
    for (
      const path of [
        options.consumerPath,
        options.consumerRequestPath,
        options.consumerUpstreamPath,
      ]
    ) {
      if (typeof path !== "string" || !isSafeBundlePath(path)) {
        throw new TypeError(
          "GatewayLocalCausalVerifier requires fixed safe root-relative paths",
        );
      }
    }
    // The consumer path is BOUND to the fixed trusted-consumer command
    // identity: an interchangeable arbitrary consumerPath is never accepted.
    if (options.consumerPath !== CAUSAL_CONSUMER_PATH) {
      throw new TypeError(
        "GatewayLocalCausalVerifier requires the fixed trusted consumer path " +
          CAUSAL_CONSUMER_PATH,
      );
    }
    // Consumer/request/upstream must be three DISTINCT fixed paths: the
    // private original inputs are never written over the consumer and no
    // path is shared between the private and sanitized writes.
    if (
      options.consumerRequestPath === options.consumerUpstreamPath ||
      options.consumerPath === options.consumerRequestPath ||
      options.consumerPath === options.consumerUpstreamPath
    ) {
      throw new TypeError(
        "GatewayLocalCausalVerifier consumer/request/upstream paths must differ",
      );
    }
    if (
      typeof options.maxDurationMs !== "number" ||
      !Number.isSafeInteger(options.maxDurationMs) ||
      options.maxDurationMs <= 0 ||
      options.maxDurationMs > MAX_LIMIT_MS
    ) {
      throw new TypeError(
        "GatewayLocalCausalVerifier requires a bounded execution deadline",
      );
    }
    if (
      typeof options.maxOutputBytes !== "number" ||
      !Number.isSafeInteger(options.maxOutputBytes) ||
      options.maxOutputBytes <= 0 ||
      options.maxOutputBytes > MAX_OUTPUT_BYTES
    ) {
      throw new TypeError(
        "GatewayLocalCausalVerifier requires a bounded output retention",
      );
    }
    const sandboxExecPath = options.sandboxExecPath ?? CAUSAL_SANDBOX_EXEC_PATH;
    if (
      typeof sandboxExecPath !== "string" ||
      !sandboxExecPath.startsWith("/") ||
      sandboxExecPath.length === 0
    ) {
      throw new TypeError(
        "GatewayLocalCausalVerifier requires an absolute sandbox-exec path",
      );
    }
    this.sandboxExecPath = sandboxExecPath;
    this.osName = options.osName ?? Deno.build.os;
    this.path = Deno.env.get("PATH") ?? "/usr/bin:/bin";
    this.runtime = options.runtime ?? new DenoReplayRuntime(this.path);
  }

  async verify(
    input: GatewayCausalVerifierInputV1,
  ): Promise<GatewayCausalProofV1 | null> {
    // ---- bounded input validation (fail closed; nothing runs yet) ----
    const capture = input.capture as RetainedGatewayCaptureV1 | null;
    if (capture === null || typeof capture !== "object") return null;
    if (!isGitSha(capture.gitSha)) return null;
    const originalSha = capture.gitSha as GitSha;
    const body = capture.body;
    if (!(body instanceof Uint8Array) || body.byteLength === 0) return null;
    const upstream = capture.upstream;
    if (
      upstream === null || typeof upstream !== "object" ||
      !Array.isArray(upstream.attempts) || upstream.attempts.length === 0
    ) {
      return null;
    }
    if (!validTestIds(input.testIds)) return null;
    if (!validExpectedFailure(input.expectedFailure)) return null;
    if (!isSafeFixtureEntries(input.fixtureEntries)) return null;

    const requestBytes = entryBytes(
      input.fixtureEntries,
      this.options.consumerRequestPath,
    );
    const upstreamBytes = entryBytes(
      input.fixtureEntries,
      this.options.consumerUpstreamPath,
    );
    if (requestBytes === null || upstreamBytes === null) return null;
    // Exact composed bundle: the digest over the actual bytes must equal the
    // identity the trusted composition computed.
    const bundleDigest = await computeReplayFixtureDigest(input.fixtureEntries);
    if (bundleDigest !== input.bundleDigest) return null;

    // The original request payload is supported JSON text: decode with FATAL
    // UTF-8 so malformed bytes are rejected before anything is placed.
    const privateText = decodeFatal(body);
    if (privateText === null) return null;

    // ---- platform/boundary preflight: the narrow macOS slice ----
    // No Deno-only or import-scanner fallback: without the real OS boundary
    // this verifier returns NO proof.
    if (this.osName !== "darwin") return null;
    const sandboxInfo = await statRegular(this.sandboxExecPath);
    if (sandboxInfo === null) return null;
    let denoResolved: string;
    try {
      denoResolved = await Deno.realPath(this.options.denoPath);
    } catch {
      return null;
    }

    let taskDir: string | null = null;
    // Uncertainty (an unsettled consumer run) preserves the restricted
    // scratch for inspection: private data is never destroyed while a run
    // cannot be proved settled, and a sanitized run starts only after the
    // original run settled.
    let preserveScratch = false;
    try {
      await Deno.mkdir(this.options.scratchDir, { recursive: true });
      taskDir = await Deno.makeTempDir({
        prefix: "sentinel-causal-verifier-",
        dir: this.options.scratchDir,
      });
      const originalDir = `${taskDir}/original`;
      const sanitizedDir = `${taskDir}/sanitized`;
      const originalHome = `${taskDir}/home-original`;
      const sanitizedHome = `${taskDir}/home-sanitized`;

      // Two INDEPENDENT exact-original-SHA snapshots (two full --no-local
      // clones; never the shared source working directory). Each run gets
      // its OWN home/cache; no cache is shared between the two executions.
      await this.cloneAt(taskDir, originalDir, originalSha);
      await this.cloneAt(taskDir, sanitizedDir, originalSha);

      // The trusted consumer must exist at the exact original SHA as a regular
      // file (never a symlink), and BOTH input paths — every component of
      // each — must be symlink-free with only regular-file endings before
      // any private bytes are placed.
      for (const dir of [originalDir, sanitizedDir]) {
        if (!(await regularFileAt(dir, this.options.consumerPath))) return null;
        if (
          !(await canPlaceInput(
            dir,
            this.options.consumerRequestPath,
            this.options.consumerUpstreamPath,
          ))
        ) {
          return null;
        }
      }

      // Private original request/upstream: ONLY under the disposable
      // restricted task directory, removed in finally. The consumer protocol
      // is fixed: request.json carries the raw body string; upstream.json
      // carries the raw authenticated upstream trace.
      await writeInput(
        originalDir,
        this.options.consumerRequestPath,
        encode(canonicalStringify({ body: privateText })),
      );
      await writeInput(
        originalDir,
        this.options.consumerUpstreamPath,
        encode(canonicalStringify(plainUpstream(upstream))),
      );

      // Sanitized snapshot uses the EXACT composed bundle bytes verbatim.
      await writeInput(
        sanitizedDir,
        this.options.consumerRequestPath,
        requestBytes,
      );
      await writeInput(
        sanitizedDir,
        this.options.consumerUpstreamPath,
        upstreamBytes,
      );

      // The SAME original source consumer in both snapshots; only the input
      // bytes differ, and each execution is confined to its own snapshot and
      // its own cache.
      const originalRun = await this.runConsumer(
        originalDir,
        originalHome,
        denoResolved,
      );
      if (!runSettled(originalRun)) {
        // Unsettled original run: abort BEFORE the sanitized execution and
        // preserve the restricted scratch on the uncertainty.
        if (uncertainRun(originalRun)) preserveScratch = true;
        return null;
      }
      const originalObservation = await this.classifyObservation(
        originalRun,
        input.testIds,
      );
      if (originalObservation === null) {
        // The original execution is settled but did not reproduce the
        // intended failure: abort before the sanitized execution.
        return null;
      }
      const sanitizedRun = await this.runConsumer(
        sanitizedDir,
        sanitizedHome,
        denoResolved,
      );
      if (!runSettled(sanitizedRun)) {
        if (uncertainRun(sanitizedRun)) preserveScratch = true;
        return null;
      }
      const sanitizedObservation = await this.classifyObservation(
        sanitizedRun,
        input.testIds,
      );
      if (sanitizedObservation === null) {
        return null;
      }

      const expectedFailureIdentity = await deriveExpectedFailureIdentity(
        input.expectedFailure,
      );
      const proof: GatewayCausalProofV1 = {
        version: "v1",
        kind: "gateway_causal_proof",
        verifier: GATEWAY_CAUSAL_VERIFIER_ID,
        proofRef: gatewayCausalProofRef(
          input.incidentId,
          input.captureId,
          bundleDigest,
        ),
        repository: input.repository,
        incidentId: input.incidentId,
        captureId: input.captureId,
        artifactDigest: input.artifactDigest,
        originalGitSha: originalSha,
        fixtureRef: input.fixtureRef,
        bundleDigest,
        replayCommandId: input.replayCommandId,
        testCommandId: input.testCommandId,
        consumerCommandId: CAUSAL_CONSUMER_COMMAND_ID,
        testIds: [...input.testIds],
        expectedFailure: copyExpectedFailure(input.expectedFailure),
        expectedFailureIdentity,
        originalObservation,
        sanitizedObservation,
      };
      // Normal cleanup is VERIFIED before the proof may be returned: a
      // cleanup failure is never swallowed while claiming the private
      // original was removed.
      const removed = await removeVerified(taskDir);
      if (!removed) return null;
      taskDir = null;
      return proof;
    } catch {
      // Any local failure (missing SHA, unsafe target, symlink, git error,
      // deno denial, policy failure, settlement uncertainty) is NO proof —
      // never an allow.
      return null;
    } finally {
      // Best-effort cleanup for settled failures. On uncertainty
      // (preserveScratch) the restricted task directory is KEPT.
      if (taskDir !== null && !preserveScratch) {
        await Deno.remove(taskDir, { recursive: true }).catch(() => {});
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal machinery (all credential-free; bounded)
  // -------------------------------------------------------------------------

  /**
   * One full exact-original-SHA snapshot clone. The clone's cwd is the
   * EXISTING parent task directory — the destination does not exist yet, so
   * it can never be its own cwd. Exact SHA/HEAD checks are retained: the
   * revision must exist, checkout must be detached and `rev-parse HEAD` must
   * equal the requested SHA.
   */
  private async cloneAt(
    parentDir: string,
    dir: string,
    sha: GitSha,
  ): Promise<void> {
    const clone = await this.runtime.run({
      executable: "git",
      args: ["clone", "-q", "--no-local", this.options.sourcePath, dir],
      cwd: parentDir,
      env: this.gitEnv(),
      maxDurationMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_OUTPUT_BYTES,
    });
    if (!exitedOk(clone)) throw new Error("verifier git clone failed");
    const verify = await this.runtime.run({
      executable: "git",
      args: ["rev-parse", "--verify", `${sha}^{commit}`],
      cwd: dir,
      env: this.gitEnv(),
      maxDurationMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_OUTPUT_BYTES,
    });
    if (!exitedOk(verify)) {
      // Missing/wrong SHA: the source does not contain the exact revision.
      throw new Error("verifier requested revision is not in the source");
    }
    const checkout = await this.runtime.run({
      executable: "git",
      args: ["checkout", "-q", "--detach", sha],
      cwd: dir,
      env: this.gitEnv(),
      maxDurationMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_OUTPUT_BYTES,
    });
    if (!exitedOk(checkout)) throw new Error("verifier checkout failed");
    const head = await this.runtime.run({
      executable: "git",
      args: ["rev-parse", "HEAD"],
      cwd: dir,
      env: this.gitEnv(),
      maxDurationMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_OUTPUT_BYTES,
    });
    if (!exitedOk(head) || decodeGit(head.stdout).trim() !== sha) {
      throw new Error("verifier checked out HEAD does not match the SHA");
    }
  }

  /**
   * One sandboxed consumer execution over the CURRENT snapshot: the direct
   * installed Deno binary under the embedded fixed seatbelt profile with
   * DENO/SNAPSHOT/CACHE substitution parameters as realpath-resolved paths,
   * cwd = this snapshot, read confined to this snapshot (relative reads
   * resolve against cwd; outside reads are denied by BOTH Deno permissions
   * and the OS boundary), no env/network/run/ffi/write permissions. Never
   * `deno task` and never a target-supplied permission or argv.
   */
  private async runConsumer(
    snapshotDir: string,
    homeDir: string,
    denoResolved: string,
  ): Promise<ReplayCommandResultV1> {
    const cacheDir = `${homeDir}/.cache/deno`;
    await Deno.mkdir(cacheDir, { recursive: true });
    const snapshotResolved = await Deno.realPath(snapshotDir);
    const cacheResolved = await Deno.realPath(cacheDir);
    return this.runtime.run({
      executable: this.sandboxExecPath,
      args: [
        "-p",
        CAUSAL_SANDBOX_PROFILE,
        "-D",
        `DENO=${denoResolved}`,
        "-D",
        `SNAPSHOT=${snapshotResolved}`,
        "-D",
        `CACHE=${cacheResolved}`,
        denoResolved,
        "run",
        "--no-prompt",
        "--no-config",
        "--no-remote",
        "--allow-read=.",
        `${snapshotDir}/${this.options.consumerPath}`,
      ],
      cwd: snapshotDir,
      env: {
        PATH: this.path,
        HOME: homeDir,
        DENO_DIR: cacheDir,
        NO_COLOR: "1",
      },
      maxDurationMs: this.options.maxDurationMs,
      maxOutputBytes: this.options.maxOutputBytes,
    });
  }

  private gitEnv(): Record<string, string> {
    return {
      PATH: this.path,
      HOME: "/tmp",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
    };
  }

  /**
   * Observed execution evidence by EXACT protocol, not by matcher: the ONLY
   * accepted consumer output is, in input.testIds order, exactly one
   * `sentinel-replay-test:<id>\n` line per trusted id followed by exactly
   * the single fixed `sentinel-causal-failure:stream terminated
   * unexpectedly\n` line on stdout, with empty stderr, exit code 1, exited
   * and settled and untruncated. Any other line, any extra/private/unrelated
   * diagnostic text, a duplicate, reordered, missing or extra id, a nonzero
   * stderr stream or any other exit code is NO evidence (fail closed). Only
   * those exact validated safe bytes (fixed public protocol lines) are
   * hashed for the observed-execution digest; arbitrary output is never
   * digested and never leaves this module.
   */
  private async classifyObservation(
    run: ReplayCommandResultV1,
    testIds: readonly string[],
  ): Promise<CausalExecutionObservationV1 | null> {
    if (run.outcome !== "exited" || !run.settled || run.truncated) {
      return null;
    }
    if (run.exitCode !== 1) return null;
    if (run.stderr.byteLength !== 0) return null;
    const expectedStdout = encode(
      testIds.map((id) => `sentinel-replay-test:${id}\n`).join("") +
        `${SAFE_CONSUMER_FAILURE_LINE}\n`,
    );
    if (!bytesEqual(run.stdout, expectedStdout)) return null;
    const outputDigest = await sha256Hex(run.stdout);
    return {
      intended: true,
      outputDigest,
      observedTestIds: [...testIds],
      exitCode: 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Free helpers (bounded, no shell, no raw output export)
// ---------------------------------------------------------------------------

function exitedOk(result: ReplayCommandResultV1): boolean {
  return result.outcome === "exited" && result.exitCode === 0 &&
    result.settled;
}

/** A consumer run is settled only when it exited and its owned group was
 * proved empty and its streams were bound within the deadline. */
function runSettled(run: ReplayCommandResultV1): boolean {
  return run.outcome === "exited" && run.settled;
}

/**
 * True when an unfinished run could not be proved clean (the runtime's
 * `timed_out` with `settled: false`): the restricted scratch MUST be
 * preserved. A settled timeout (group empty after termination) is not
 * uncertainty.
 */
function uncertainRun(run: ReplayCommandResultV1): boolean {
  return run.outcome !== "exited" && !run.settled;
}

function validTestIds(ids: readonly unknown[]): boolean {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_TEST_IDS) {
    return false;
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !TEST_ID_RE.test(id) || seen.has(id)) {
      return false;
    }
    seen.add(id);
  }
  return true;
}

function validExpectedFailure(value: unknown): value is ExpectedFailureV1 {
  if (value === null || typeof value !== "object") return false;
  const expected = value as ExpectedFailureV1;
  if (
    typeof expected.reason !== "string" || expected.reason.length === 0 ||
    expected.reason.length > MAX_FAILURE_REASON_BYTES ||
    /[\r\n\t]/.test(expected.reason)
  ) {
    return false;
  }
  // The ONLY supported safe expectation for this narrow local consumer is
  // the fixed contains matcher over the exact supported failure text: any
  // arbitrary text or regex matcher is rejected before anything runs, so
  // the classifier below never matches arbitrary output content.
  return expected.match.kind === "contains" &&
    expected.match.text === SAFE_CONSUMER_FAILURE_TEXT;
}

/**
 * The composed bundle must be exactly the two fixed consumer paths; nothing
 * more, nothing less (so the sanitized snapshot is the exact composed bundle
 * and the consumer protocol is fixed).
 */
function isSafeFixtureEntries(
  entries: readonly ReplayFixtureEntryV1[],
): boolean {
  if (!Array.isArray(entries) || entries.length !== 2) return false;
  const paths = new Set(entries.map((entry) => entry.path));
  return paths.size === 2;
}

function entryBytes(
  entries: readonly ReplayFixtureEntryV1[],
  path: string,
): Uint8Array | null {
  for (const entry of entries) {
    if (entry.path === path) return entry.bytes;
  }
  return null;
}

function copyExpectedFailure(expected: ExpectedFailureV1): ExpectedFailureV1 {
  return expected.match.kind === "contains"
    ? { ...expected, match: { kind: "contains", text: expected.match.text } }
    : { ...expected, match: { kind: "regex", source: expected.match.source } };
}

/** Plain structural copy of the private upstream (canonical-serializable). */
function plainUpstream(upstream: RetainedGatewayCaptureV1["upstream"]): Record<
  string,
  unknown
> {
  return {
    version: upstream.version,
    attempts: upstream.attempts.map((attempt) => ({
      provider: attempt.provider,
      status: attempt.status,
      content_type: attempt.content_type,
      chunks_base64: [...attempt.chunks_base64],
      terminal: attempt.terminal,
    })),
    attempts_truncated: upstream.attempts_truncated,
    bytes_truncated: upstream.bytes_truncated,
    chunks_truncated: upstream.chunks_truncated,
  };
}

/**
 * Validate EVERY component of BOTH paths with lstat before any private write:
 * a symlink anywhere (ancestor or final component), a non-directory ancestor
 * or an existing non-regular final component rejects the target. Every path
 * is validated independently — a clean first path never short-circuits the
 * second path, and a missing component is placeable only when the rest of
 * that chain is absent too.
 */
async function canPlaceInput(
  checkoutRoot: string,
  ...relativePaths: string[]
): Promise<boolean> {
  for (const relativePath of relativePaths) {
    if (!(await canPlacePath(checkoutRoot, relativePath))) return false;
  }
  return true;
}

async function canPlacePath(
  checkoutRoot: string,
  relativePath: string,
): Promise<boolean> {
  const segments = relativePath.split("/");
  let current = checkoutRoot;
  for (let i = 0; i < segments.length; i += 1) {
    const candidate = `${current}/${segments[i]}`;
    let info: Deno.FileInfo | null = null;
    try {
      info = await Deno.lstat(candidate);
    } catch (error) {
      // The chain from here on is absent: the input can be created fresh
      // (no symlink is followed, the write is exclusive).
      if (error instanceof Deno.errors.NotFound) return true;
      return false;
    }
    if (info.isSymlink) return false;
    if (i === segments.length - 1) {
      // The final component must be missing or an already-regular file (the
      // write is byte-identical-or-exclusive); directories and other
      // non-regular entries are rejected.
      return info.isFile;
    }
    if (!info.isDirectory) return false;
    current = candidate;
  }
  return true;
}

/** True when the trusted consumer exists at the path as a regular file. */
async function regularFileAt(
  checkoutRoot: string,
  relativePath: string,
): Promise<boolean> {
  const segments = relativePath.split("/");
  let current = checkoutRoot;
  for (let i = 0; i < segments.length; i += 1) {
    const candidate = `${current}/${segments[i]}`;
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(candidate);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      return false;
    }
    if (info.isSymlink) return false;
    if (i === segments.length - 1) return info.isFile;
    if (!info.isDirectory) return false;
    current = candidate;
  }
  return false;
}

/**
 * Place one input without ever following a symlink: an existing final
 * component must be a regular file whose bytes are IDENTICAL (never
 * rewritten); a missing final component is created EXCLUSIVELY (createNew —
 * a raced symlink makes the create fail rather than be followed).
 */
async function writeInput(
  checkoutRoot: string,
  relativePath: string,
  bytes: Uint8Array,
): Promise<void> {
  const target = `${checkoutRoot}/${relativePath}`;
  let info: Deno.FileInfo | null = null;
  try {
    info = await Deno.lstat(target);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      // Absent: exclusive create below.
    } else {
      throw error;
    }
  }
  if (info !== null) {
    if (info.isSymlink || !info.isFile) {
      throw new Error("verifier input target is not a regular file");
    }
    const existing = await Deno.readFile(target);
    if (!bytesEqual(existing, bytes)) {
      throw new Error("verifier input target already exists with other bytes");
    }
    return;
  }
  const parent = target.slice(0, target.lastIndexOf("/"));
  await Deno.mkdir(parent, { recursive: true });
  await Deno.writeFile(target, bytes, { createNew: true });
}

/** Remove the restricted task directory and VERIFY the removal; false means
 * the private original cannot be proved gone (never claim otherwise). */
async function removeVerified(taskDir: string): Promise<boolean> {
  try {
    await Deno.remove(taskDir, { recursive: true });
  } catch {
    return false;
  }
  try {
    await Deno.lstat(taskDir);
    return false;
  } catch (error) {
    return error instanceof Deno.errors.NotFound;
  }
}

/** Regular-file stat (no symlink follow); null when absent or non-regular. */
async function statRegular(path: string): Promise<Deno.FileInfo | null> {
  try {
    const info = await Deno.lstat(path);
    return info.isFile && !info.isSymlink ? info : null;
  } catch {
    return null;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** FATAL UTF-8 decode: malformed bytes mean no classification, no write. */
function decodeFatal(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Git diagnostic decoding (ASCII/hex output; non-fatal on locale text). */
function decodeGit(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
