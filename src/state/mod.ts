/**
 * GitStateStore: the production state-storage implementation for the two
 * fixed Sentinel state branches.
 *
 * State lives on `refs/heads/sentinel-state/repair` and
 * `refs/heads/sentinel-state/release` in a remote repository. The store never
 * touches the canonical or target checkout: every operation runs in a private
 * temporary workdir under the explicitly provided scratch directory (no
 * shared index/FETCH_HEAD/lock state, so concurrent uses cannot race on
 * scratch files), and every push is an ordinary non-force push.
 *
 * Structure of each state commit:
 *
 *   manifest.json                version/kind/sequence/updatedAt/stateHead
 *   <collection>/<sha256(id)>.json   one validated canonical JSON record per
 *                                    file, one collection per record kind
 *
 * Reads validate the full record tree (exact keys/schema, unique ids, digest
 * filenames) and verify the manifest `stateHead` equals the actual commit
 * parent. Writes are strict expected-head CAS: the expected remote head must
 * match before a candidate commit is formed with that exact parent; a ref
 * mismatch is a conflict (never an overwrite), and no force/force-with-lease
 * is ever used. Pushes carry a unique trusted write nonce in the commit
 * message so two identical concurrent candidates never produce identical
 * commits and both report success; the losing caller gets a conflict and
 * rereads. A failed push is reconciled against the authoritative ref before
 * any result is reported, so a lost response preserves the ambiguous outcome.
 *
 * The transport is injected (default: real `git` via Deno.Command with
 * clearEnv and no credential-capable config); tests inject wrappers around
 * the same transport, never alternate state logic.
 */

import { parseBudgetReservationV1 } from "../contracts/budget-reservation.ts";
import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import { parseGitHubCooldownV1 } from "../contracts/github-cooldown.ts";
import type { GitHubCooldownV1 } from "../contracts/github-cooldown.ts";
import {
  parseHostedReleaseRecordV1,
  parseHostedRuntimeRecordV1,
  validateHostedStateTransition,
} from "../contracts/hosted-supervisor.ts";
import type {
  HostedReleaseRecordV1,
  HostedRuntimeRecordV1,
} from "../contracts/hosted-supervisor.ts";
import {
  parseIncidentEvidenceV1,
  parseIncidentSummaryV1,
} from "../contracts/incident.ts";
import type {
  IncidentEvidenceV1,
  IncidentSummaryV1,
} from "../contracts/incident.ts";
import type {
  PortErrorV1,
  PortResultV1,
  ReleaseStateWriter,
  RepairStateWriter,
  StateReadResultV1,
  StateReadView,
  StateStore,
  StateWriteResultV1,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import {
  parseReleaseRecordV1,
  parseReleaseRequestV1,
} from "../contracts/release.ts";
import type {
  ReleaseRecordV1,
  ReleaseRequestV1,
} from "../contracts/release.ts";
import { parseReplayResultV1 } from "../contracts/replay-result.ts";
import type { ReplayResultV1 } from "../contracts/replay-result.ts";
import { parseReviewReceiptV1 } from "../contracts/review-receipt.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import {
  expectCount,
  expectExactKeys,
  expectGitSha,
  expectNullable,
  expectRecord,
  expectTimestamp,
  expectVersion,
  fail,
} from "../contracts/validation.ts";
import { parseWorkRecordV1 } from "../contracts/work-record.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import type { GitSha } from "../contracts/brands.ts";

/** The two fixed state refs; roles read both, each role writes only its own. */
export const REPAIR_STATE_REF = "refs/heads/sentinel-state/repair";
export const RELEASE_STATE_REF = "refs/heads/sentinel-state/release";

export type StateWriterRole = "repair" | "release";

/** Result of one `git` invocation (argv only, never a shell string). */
export interface GitRunResultV1 {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Injected transport border. Production uses DenoGitRunner (real Deno.Command
 * git, credential-free). Tests may wrap it to simulate lost responses or
 * synchronize concurrent writers; wrappers must not carry state logic.
 */
export interface GitRunnerV1 {
  runGit(
    args: string[],
    opts: { cwd: string; env?: Readonly<Record<string, string>> },
  ): Promise<GitRunResultV1>;
}

export interface GitStateStoreOptions {
  /** Scratch directory for private per-operation workdirs. */
  scratchDir: string;
  /** Remote repository URL or local path holding the state branches. */
  remoteUrl: string;
  /** Fixed writer role: a repair store never writes release state and vice versa. */
  role: StateWriterRole;
  /** Transport injection for tests; default is the real git runner. */
  runner?: GitRunnerV1;
}

/**
 * Production git runner. Every git child runs with clearEnv and only PATH,
 * a scratch HOME, and explicit config isolation, so Git global/system config,
 * credential helpers and hooks cannot supply hidden credentials, and
 * GIT_TERMINAL_PROMPT=0 keeps git from prompting for them.
 */
export class DenoGitRunner implements GitRunnerV1 {
  private readonly path: string;
  private readonly extraEnv: Readonly<Record<string, string>>;

  constructor(
    private readonly gitHome: string,
    extraEnv: Readonly<Record<string, string>> = {},
  ) {
    this.path = Deno.env.get("PATH") ?? "/usr/bin:/bin";
    this.extraEnv = { ...extraEnv };
  }

  async runGit(
    args: string[],
    opts: { cwd: string; env?: Readonly<Record<string, string>> },
  ): Promise<GitRunResultV1> {
    const command = new Deno.Command("git", {
      args,
      cwd: opts.cwd,
      clearEnv: true,
      env: {
        PATH: this.path,
        HOME: this.gitHome,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        ...this.extraEnv,
        ...opts.env,
      },
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    return { ok: result.success, code: result.code, stdout, stderr };
  }
}

type StateKind = "repair" | "release";

interface StateManifestV1 {
  version: "v1";
  kind: "repair_state_manifest" | "release_state_manifest";
  sequence: number;
  updatedAt: number;
  stateHead: GitSha | null;
}

const MANIFEST_KEYS = [
  "version",
  "kind",
  "sequence",
  "updatedAt",
  "stateHead",
] as const;
const MANIFEST_KIND: Record<StateKind, StateManifestV1["kind"]> = {
  repair: "repair_state_manifest",
  release: "release_state_manifest",
};

function parseStateManifest(
  input: unknown,
  path: string,
  kind: StateKind,
): StateManifestV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, MANIFEST_KEYS, path);
  expectVersion(obj.version, path);
  if (obj.kind !== MANIFEST_KIND[kind]) {
    fail(path, "invalid_lifecycle", "manifest kind does not match the ref");
  }
  return {
    version: "v1",
    kind: MANIFEST_KIND[kind],
    sequence: expectCount(obj.sequence, `${path}.sequence`),
    updatedAt: expectTimestamp(obj.updatedAt, `${path}.updatedAt`),
    stateHead: expectNullable(obj.stateHead, `${path}.stateHead`, expectGitSha),
  };
}

/**
 * Identity source of one validated state record. Every record kind carries
 * exactly one of the two: existing records identify by their string `id`,
 * while the durable GitHub cooldown fragment (repair and release roles) is
 * deliberately a kind-less plain data record addressing its storage slot by its
 * positive installation id (`githubCooldowns/sha256(String(installationId)).json`).
 */
interface RecordIdentitySource {
  id?: string;
  installationId?: number;
}

interface RecordCollection {
  directory: string;
  kind: string;
  parse: (input: unknown) => RecordIdentitySource;
  rows: { id: string; text: string }[];
}

const RECORD_COLLECTIONS: Record<StateKind, RecordCollection[]> = {
  repair: [
    {
      directory: "incidents",
      kind: "incident_summary",
      parse: parseIncidentSummaryV1,
      rows: [],
    },
    {
      directory: "evidence",
      kind: "incident_evidence",
      parse: parseIncidentEvidenceV1,
      rows: [],
    },
    {
      directory: "work",
      kind: "work",
      parse: parseWorkRecordV1,
      rows: [],
    },
    {
      directory: "reservations",
      kind: "budget_reservation",
      parse: parseBudgetReservationV1,
      rows: [],
    },
    {
      directory: "reviews",
      kind: "review_receipt",
      parse: parseReviewReceiptV1,
      rows: [],
    },
    {
      directory: "replays",
      kind: "replay_result",
      parse: parseReplayResultV1,
      rows: [],
    },
    {
      directory: "releaseRequests",
      kind: "release_request",
      parse: parseReleaseRequestV1,
      rows: [],
    },
    {
      directory: "githubCooldowns",
      kind: "github_cooldown",
      parse: parseGitHubCooldownV1,
      rows: [],
    },
  ],
  release: [
    {
      directory: "releases",
      kind: "release_record",
      parse: parseReleaseRecordV1,
      rows: [],
    },
    {
      directory: "hostedRuntimes",
      kind: "hosted_runtime",
      parse: parseHostedRuntimeRecordV1,
      rows: [],
    },
    {
      directory: "hostedReleases",
      kind: "hosted_release",
      parse: parseHostedReleaseRecordV1,
      rows: [],
    },
    {
      directory: "githubCooldowns",
      kind: "github_cooldown",
      parse: parseGitHubCooldownV1,
      rows: [],
    },
  ],
};

const REPAIR_REF = REPAIR_STATE_REF;
const RELEASE_REF = RELEASE_STATE_REF;

interface OpContext {
  directory: string;
}

/** Local plumbing failure while forming the candidate state commit. */
class StatePushError extends Error {
  constructor(operation: string) {
    super(`state commit plumbing failed at ${operation}`);
    this.name = "StatePushError";
  }
}

type LoadedState =
  | { status: "absent" }
  | {
    status: "found";
    head: GitSha;
    snapshot: RepairStateSnapshotV1 | ReleaseStateSnapshotV1;
  };

export class GitStateStore implements StateStore {
  private readonly scratchDir: string;
  private readonly remoteUrl: string;
  private readonly role: StateWriterRole;
  private readonly runner: GitRunnerV1;
  private readonly gitHome: string;

  constructor(options: GitStateStoreOptions) {
    if (
      typeof options.scratchDir !== "string" || options.scratchDir.length === 0
    ) {
      throw new Error("GitStateStore requires a non-empty scratch directory");
    }
    if (
      typeof options.remoteUrl !== "string" || options.remoteUrl.length === 0
    ) {
      throw new Error("GitStateStore requires a remote URL or path");
    }
    if (options.role !== "repair" && options.role !== "release") {
      throw new Error("GitStateStore requires a fixed writer role");
    }
    this.scratchDir = options.scratchDir;
    this.remoteUrl = options.remoteUrl;
    this.role = options.role;
    this.gitHome = `${options.scratchDir}/state-git-home`;
    this.runner = options.runner ?? new DenoGitRunner(this.gitHome);
    // Scratch and per-run HOME only; no repository or branch is created here.
    Deno.mkdirSync(this.scratchDir, { recursive: true });
    Deno.mkdirSync(this.gitHome, { recursive: true });
  }

  // -------------------------------------------------------------------------
  // Reads: both roles read both fixed refs.
  // -------------------------------------------------------------------------

  readRepair(): Promise<
    PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>
  > {
    return this.withOpDir<StateReadResultV1<RepairStateSnapshotV1>>(
      async (op) => {
        const loaded = await this.loadRemote(op, REPAIR_REF, "repair");
        if (!loaded.ok) return loaded;
        if (loaded.value.status === "absent") {
          return portOk({
            status: "absent",
            currentHead: null,
            ref: REPAIR_REF,
          });
        }
        return portOk({
          status: "found",
          snapshot: loaded.value.snapshot as RepairStateSnapshotV1,
          head: loaded.value.head,
          ref: REPAIR_REF,
        });
      },
    );
  }

  readRelease(): Promise<
    PortResultV1<StateReadResultV1<ReleaseStateSnapshotV1>>
  > {
    return this.withOpDir<StateReadResultV1<ReleaseStateSnapshotV1>>(
      async (op) => {
        const loaded = await this.loadRemote(op, RELEASE_REF, "release");
        if (!loaded.ok) return loaded;
        if (loaded.value.status === "absent") {
          return portOk({
            status: "absent",
            currentHead: null,
            ref: RELEASE_REF,
          });
        }
        return portOk({
          status: "found",
          snapshot: loaded.value.snapshot as ReleaseStateSnapshotV1,
          head: loaded.value.head,
          ref: RELEASE_REF,
        });
      },
    );
  }

  // -------------------------------------------------------------------------
  // Writes: role-gated, strict expected-head CAS, non-force pushes only.
  // -------------------------------------------------------------------------

  writeRepair(
    next: RepairStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    if (this.role !== "repair") {
      return Promise.resolve(portError(
        "invalid",
        "repair state writes require a repair-role store (role mismatch)",
      ));
    }
    return this.writeState(next, expectedHead, "repair", REPAIR_REF);
  }

  writeRelease(
    next: ReleaseStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    if (this.role !== "release") {
      return Promise.resolve(portError(
        "invalid",
        "release state writes require a release-role store (role mismatch)",
      ));
    }
    return this.writeState(next, expectedHead, "release", RELEASE_REF);
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------

  private async withOpDir<T>(
    run: (op: OpContext) => Promise<PortResultV1<T>>,
  ): Promise<PortResultV1<T>> {
    let directory: string;
    try {
      directory = await Deno.makeTempDir({
        prefix: "state-op-",
        dir: this.scratchDir,
      });
    } catch {
      // Local allocation failure: a sanitized typed result, never an
      // exception whose text could carry paths into a caller or log.
      return portError(
        "unavailable",
        "state operation could not allocate a private working directory",
      );
    }
    const op: OpContext = { directory };
    try {
      return await run(op);
    } finally {
      try {
        await Deno.remove(op.directory, { recursive: true });
      } catch {
        // Best-effort scratch cleanup; results are unaffected.
      }
    }
  }

  private async git(
    op: OpContext,
    args: string[],
    env?: Readonly<Record<string, string>>,
  ): Promise<GitRunResultV1> {
    try {
      return await this.runner.runGit(args, { cwd: op.directory, env });
    } catch {
      // A throwing transport (or local spawn failure) is a sanitized git
      // failure with no exception text: never leak paths, URLs or remote
      // error details into the typed result. The ref state is unknown.
      return { ok: false, code: -1, stdout: "", stderr: "" };
    }
  }

  /**
   * Strict exact ls-remote output parsing. Zero output lines means the ref
   * truly does not exist (ls-remote exited 0 with no match). Any malformed
   * line, a response with no matching record, or more than one matching
   * record is an invalid response — never "empty" — because a failed read can
   * never become a successful empty state.
   */
  private parseLsRemote(
    stdout: string,
    ref: string,
  ): { status: "absent" } | { status: "invalid" } | {
    status: "found";
    head: string;
  } {
    const lines = stdout.split("\n").filter((line) => line.length > 0);
    const matches: string[] = [];
    for (const line of lines) {
      const match = /^([0-9a-f]{40})\t(\S+)$/.exec(line);
      if (match === null) {
        return { status: "invalid" };
      }
      if (match[2] === ref) matches.push(match[1]);
    }
    if (lines.length === 0) return { status: "absent" };
    if (matches.length === 0) return { status: "invalid" };
    if (matches.length > 1) return { status: "invalid" };
    return { status: "found", head: matches[0] };
  }

  /**
   * Reads the exact remote ref and, when present, the full validated state
   * tree underneath it. Absent means the ref does not exist (ls-remote exit
   * 0 with no match); every other transport outcome is a typed error.
   */
  private async loadRemote(
    op: OpContext,
    ref: string,
    kind: StateKind,
  ): Promise<PortResultV1<LoadedState>> {
    const init = await this.git(op, ["init", "-q"]);
    if (!init.ok) return this.gitFailure("unavailable", "init", init);
    const remote = await this.git(op, [
      "remote",
      "add",
      "origin",
      this.remoteUrl,
    ]);
    if (!remote.ok) return this.gitFailure("unavailable", "remote add", remote);

    const lookup = await this.git(op, ["ls-remote", "origin", ref]);
    if (!lookup.ok) {
      return this.gitFailure(
        this.classifyGitError(lookup),
        "ls-remote",
        lookup,
      );
    }
    const lookupParsed = this.parseLsRemote(lookup.stdout, ref);
    if (lookupParsed.status === "absent") {
      return portOk({ status: "absent" });
    }
    if (lookupParsed.status === "invalid") {
      return portError(
        "invalid",
        "remote state ref ls-remote response is malformed or duplicate",
      );
    }
    const head = lookupParsed.head;
    if (!/^[0-9a-f]{40}$/.test(head)) {
      return portError("invalid", "remote state ref has a malformed commit id");
    }

    const fetch = await this.git(op, [
      "fetch",
      "-q",
      "--no-tags",
      "origin",
      ref,
    ]);
    if (!fetch.ok) {
      return this.gitFailure(this.classifyGitError(fetch), "fetch", fetch);
    }
    const fetchHead = await this.git(op, ["rev-parse", "FETCH_HEAD"]);
    if (!fetchHead.ok) {
      return this.gitFailure("unavailable", "rev-parse", fetchHead);
    }
    const fetched = fetchHead.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(fetched)) {
      return portError("invalid", "remote state ref has a malformed commit id");
    }

    const snapshot = await this.readCommitTree(op, fetched, kind);
    if (!snapshot.ok) return snapshot;
    return portOk({
      status: "found",
      head: fetched as GitSha,
      snapshot: snapshot.value,
    });
  }

  private writeState(
    next: RepairStateSnapshotV1 | ReleaseStateSnapshotV1,
    expectedHead: GitSha | null,
    kind: StateKind,
    ref: string,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    // Validate the caller's snapshot before any Git mutation.
    try {
      if (kind === "repair") {
        parseRepairStateSnapshotV1(next);
      } else {
        parseReleaseStateSnapshotV1(next);
      }
    } catch {
      return Promise.resolve(
        portError("invalid", "state snapshot failed contract validation"),
      );
    }

    return this.withOpDir<StateWriteResultV1>(async (op) => {
      const loaded = await this.loadRemote(op, ref, kind);
      if (!loaded.ok) return loaded;
      const prior = loaded.value.status === "absent"
        ? null
        : loaded.value.snapshot;
      const priorHead = loaded.value.status === "absent"
        ? null
        : loaded.value.head;
      if (priorHead !== expectedHead) {
        return portOk({ status: "conflict", currentHead: priorHead });
      }

      const transitionMessage = validateSnapshotTransition(
        prior,
        next,
        expectedHead,
      );
      if (transitionMessage !== null) {
        return portError("invalid", transitionMessage);
      }

      let candidate: {
        pushed: boolean;
        head: GitSha;
        pushFailureKind: PortErrorV1["kind"] | null;
      };
      try {
        candidate = await this.buildAndPush(
          op,
          next,
          expectedHead,
          kind,
          ref,
        );
      } catch {
        // Local formation failure only (before any push): a sanitized typed
        // unavailable result, never an exception or raw filesystem path.
        return portError(
          "unavailable",
          "could not form the state commit locally",
        );
      }
      const ourHead = candidate.head;

      // Reconcile the authoritative ref before reporting any outcome; never
      // retry blindly. The response may have been lost — or the transport
      // itself may have thrown — after the server accepted the update; the
      // ref, not the push response, decides. A failed, thrown or malformed
      // verification read after an attempted push is ambiguous, never a false
      // "not applied" error.
      const verify = await this.git(op, ["ls-remote", "origin", ref]);
      const verifyParsed = !verify.ok
        ? ({ status: "invalid" } as const)
        : this.parseLsRemote(verify.stdout, ref);
      if (verifyParsed.status === "absent" && !candidate.pushed) {
        // A successful authoritative reread proves that a failed push did not
        // create the ref. Preserve the safe transport category so a trusted
        // caller can distinguish authentication from local availability
        // failure without exposing Git's raw stderr.
        return portError(
          candidate.pushFailureKind ?? "unavailable",
          "state push was not applied; the remote ref remains absent",
        );
      }
      if (verifyParsed.status !== "found") {
        return portOk({ status: "ambiguous", currentHead: priorHead });
      }
      const verifyHead = verifyParsed.head as GitSha;
      if (verifyHead === ourHead) {
        return portOk({ status: "applied", head: ourHead });
      }
      if (!candidate.pushed) {
        if (verifyHead === priorHead) {
          return portError(
            "unavailable",
            "state push was not applied; the remote ref is unchanged",
          );
        }
        return portOk({
          status: "conflict",
          currentHead: verifyHead,
        });
      }
      // The push reported success but the ref does not point at our commit:
      // preserve the ambiguous outcome for exact-state reconciliation.
      return portOk({
        status: "ambiguous",
        currentHead: verifyHead,
      });
    });
  }

  /**
   * Forms the candidate commit — parent pinned to the exact expected head
   * (no checkout/reset is ever performed; plumbing only) — with a unique
   * trusted write nonce in the commit message, then pushes without force.
   * Returns the actual commit identity, push result and safe failure category;
   * reconciliation (applied/conflict/ambiguous) happens in the caller.
   */
  private async buildAndPush(
    op: OpContext,
    next: RepairStateSnapshotV1 | ReleaseStateSnapshotV1,
    expectedHead: GitSha | null,
    kind: StateKind,
    ref: string,
  ): Promise<{
    pushed: boolean;
    head: GitSha;
    pushFailureKind: PortErrorV1["kind"] | null;
  }> {
    const manifest: StateManifestV1 = {
      version: "v1",
      kind: MANIFEST_KIND[kind],
      sequence: next.sequence,
      updatedAt: next.updatedAt,
      stateHead: expectedHead,
    };
    const files: { path: string; text: string }[] = [{
      path: "manifest.json",
      text: `${canonicalStringify(manifest)}\n`,
    }];
    files.push(...await this.recordFiles(next, kind));
    for (const file of files) {
      const slash = file.path.lastIndexOf("/");
      if (slash !== -1) {
        await Deno.mkdir(`${op.directory}/${file.path.slice(0, slash)}`, {
          recursive: true,
        });
      }
      await Deno.writeTextFile(`${op.directory}/${file.path}`, file.text);
    }

    const add = await this.git(op, ["add", "-A"]);
    if (!add.ok) throw new StatePushError("add");
    const tree = await this.git(op, ["write-tree"]);
    if (!tree.ok) throw new StatePushError("write-tree");
    const treeSha = tree.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(treeSha)) {
      throw new StatePushError("write-tree");
    }

    const nonce = await randomHex(32);
    const commitEnv = {
      GIT_AUTHOR_NAME: "sentinel-state",
      GIT_AUTHOR_EMAIL: "sentinel-state@localhost",
      GIT_COMMITTER_NAME: "sentinel-state",
      GIT_COMMITTER_EMAIL: "sentinel-state@localhost",
    };
    const message = `sentinel-state ${kind} write\n\nnonce: ${nonce}`;
    const parentArgs = expectedHead === null ? [] : ["-p", expectedHead];
    const commit = await this.git(
      op,
      ["commit-tree", treeSha, ...parentArgs, "-m", message],
      commitEnv,
    );
    if (!commit.ok) throw new StatePushError("commit-tree");
    const ourHead = commit.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(ourHead)) {
      throw new StatePushError("commit-tree");
    }

    const push = await this.git(op, [
      "push",
      "origin",
      `${ourHead}:${ref}`,
    ]);
    return {
      pushed: push.ok,
      head: ourHead as GitSha,
      pushFailureKind: push.ok ? null : this.classifyGitError(push),
    };
  }

  private recordFiles(
    next: RepairStateSnapshotV1 | ReleaseStateSnapshotV1,
    kind: StateKind,
  ): Promise<{ path: string; text: string }[]> {
    const records: { id: string; directory: string; value: unknown }[] = [];
    if (kind === "repair") {
      const repair = next as RepairStateSnapshotV1;
      const add = (recordKind: string, rows: readonly unknown[]) => {
        // The directory is resolved through the same collection mapping the
        // read loop validates, so the written layout cannot drift from it.
        const directory = collectionDirectory(kind, recordKind);
        for (const value of rows) {
          records.push({
            id: recordIdentity(value as RecordIdentitySource),
            directory,
            value,
          });
        }
      };
      add("incident_summary", repair.incidents);
      add("incident_evidence", repair.evidence);
      add("work", repair.work);
      add("budget_reservation", repair.reservations);
      add("review_receipt", repair.reviews);
      add("replay_result", repair.replays);
      add("release_request", repair.releaseRequests);
      // Durable cooldowns are serialized explicitly: the fragment is
      // deliberately a kind-less data record, so its collection directory and
      // storage identity (sha256 of String(installationId)) are fixed by the
      // collection mapping here, never inferred from the record content.
      add("github_cooldown", repair.githubCooldowns);
    } else {
      const release = next as ReleaseStateSnapshotV1;
      const add = (recordKind: string, rows: readonly unknown[]) => {
        const directory = collectionDirectory(kind, recordKind);
        for (const value of rows) {
          records.push({
            id: recordIdentity(value as RecordIdentitySource),
            directory,
            value,
          });
        }
      };
      add("release_record", release.releases);
      add("hosted_runtime", release.hostedRuntimes);
      add("hosted_release", release.hostedReleases);
      // Release-role cooldowns use the same kind-less fragment convention as
      // the repair role; both are addressed by installation id.
      add("github_cooldown", release.githubCooldowns);
    }
    return Promise.all(
      records.map(async (record) => ({
        path: `${record.directory}/${await sha256Hex(record.id)}.json`,
        text: `${canonicalStringify(record.value)}\n`,
      })),
    );
  }

  /**
   * Parses and validates the full record tree at one commit: manifest schema,
   * exact collection layout, exact keys/schema per record, digest filenames,
   * unique ids, and manifest stateHead against the actual commit parent.
   */
  private async readCommitTree(
    op: OpContext,
    commitSha: string,
    kind: StateKind,
  ): Promise<PortResultV1<RepairStateSnapshotV1 | ReleaseStateSnapshotV1>> {
    const parents = await this.git(op, [
      "rev-list",
      "--parents",
      "-n",
      "1",
      commitSha,
    ]);
    if (!parents.ok) return this.gitFailure("unavailable", "rev-list", parents);
    const parentTokens = parents.stdout.trim().split(/\s+/).filter(Boolean);
    const parentsOfCommit = parentTokens.slice(1);

    const tree = await this.git(op, ["ls-tree", "-r", commitSha]);
    if (!tree.ok) return this.gitFailure("unavailable", "ls-tree", tree);

    interface Entry {
      mode: string;
      type: string;
      sha: string;
      path: string;
    }
    const entries: Entry[] = [];
    for (const line of tree.stdout.split("\n")) {
      if (line.length === 0) continue;
      const match = /^([0-9]{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/.exec(
        line,
      );
      if (match === null) {
        return portError("invalid", "state tree has a malformed entry");
      }
      entries.push({
        mode: match[1],
        type: match[2],
        sha: match[3],
        path: match[4],
      });
      if (match[2] !== "blob") {
        return portError("invalid", "state tree contains a non-blob entry");
      }
      // State files are full regular blobs only: an executable or a symlink
      // (for the manifest or any record) is tampered state, never storage.
      if (match[1] !== "100644") {
        return portError(
          "invalid",
          "state tree contains a non-regular state file",
        );
      }
    }

    const manifestEntry = entries.find((entry) =>
      entry.path === "manifest.json"
    );
    if (manifestEntry === undefined) {
      return portError("invalid", "state tree is missing manifest.json");
    }
    if (
      entries.filter((entry) => entry.path === "manifest.json").length !== 1
    ) {
      return portError("invalid", "state tree has duplicate manifest entries");
    }
    const manifestBlob = await this.git(op, [
      "cat-file",
      "blob",
      manifestEntry.sha,
    ]);
    if (!manifestBlob.ok) {
      return this.gitFailure("unavailable", "cat-file", manifestBlob);
    }
    let manifest: StateManifestV1;
    try {
      manifest = parseStateManifest(
        JSON.parse(manifestBlob.stdout),
        "$.manifest",
        kind,
      );
    } catch {
      return portError("invalid", "state manifest failed validation");
    }
    // The manifest must be exactly the canonical JSON bytes this store writes
    // (canonicalStringify + newline). Any reordered keys, duplicate JSON keys
    // — which parse to one silent last-wins value — or formatting drift is a
    // mismatch and invalid rather than a best-effort reparse.
    if (`${canonicalStringify(manifest)}\n` !== manifestBlob.stdout) {
      return portError("invalid", "state manifest is not canonical JSON");
    }

    // Validate the embedded stateHead against the actual commit parent.
    if (manifest.stateHead === null) {
      if (parentsOfCommit.length !== 0) {
        return portError(
          "invalid",
          "manifest stateHead is null but the commit has a parent",
        );
      }
    } else {
      if (
        parentsOfCommit.length !== 1 ||
        parentsOfCommit[0] !== manifest.stateHead
      ) {
        return portError(
          "invalid",
          "manifest stateHead does not match the commit parent",
        );
      }
    }

    const collections = RECORD_COLLECTIONS[kind];
    const directories = new Set(collections.map((c) => c.directory));
    const byDirectory: Record<string, Record<string, string>> = {};
    for (const collection of collections) {
      byDirectory[collection.directory] = {};
    }
    for (const entry of entries) {
      if (entry.path === "manifest.json") continue;
      const slash = entry.path.indexOf("/");
      if (slash === -1) {
        return portError("invalid", "state tree has an unexpected root file");
      }
      const directory = entry.path.slice(0, slash);
      const fileName = entry.path.slice(slash + 1);
      if (!directories.has(directory)) {
        return portError("invalid", "state tree has an unexpected collection");
      }
      if (!/^[0-9a-f]{64}\.json$/.test(fileName)) {
        return portError(
          "invalid",
          "state record file name is not digest-encoded",
        );
      }
      const blob = await this.git(op, ["cat-file", "blob", entry.sha]);
      if (!blob.ok) return this.gitFailure("unavailable", "cat-file", blob);
      byDirectory[directory][fileName] = blob.stdout;
    }

    // Parse and validate every record file; the filename must be the SHA-256
    // of the record id, preventing duplication or misplacement.
    const records: Record<string, { id: string; value: unknown }[]> = {};
    for (const collection of collections) records[collection.directory] = [];
    for (const collection of collections) {
      for (
        const [fileName, text] of Object.entries(
          byDirectory[collection.directory],
        )
      ) {
        const expectedHex = fileName.slice(0, 64);
        let record: RecordIdentitySource;
        try {
          record = collection.parse(JSON.parse(text));
        } catch {
          return portError(
            "invalid",
            `state record in ${collection.directory} failed validation`,
          );
        }
        // Exact canonical bytes, exactly as this store writes them. Duplicate
        // JSON keys re-parse to one last-wins value, so their original bytes
        // never match the canonical form of the parsed record and are
        // rejected instead of silently accepted.
        if (`${canonicalStringify(record)}\n` !== text) {
          return portError(
            "invalid",
            `state record in ${collection.directory} is not canonical JSON`,
          );
        }
        // The digest filename must equal sha256 of the record's storage
        // identity: the record id for existing records, the positive
        // installation id string for kind-less GitHub cooldowns.
        const identity = recordIdentity(record);
        const actualHex = await sha256Hex(identity);
        if (actualHex !== expectedHex) {
          return portError(
            "invalid",
            "state record file name does not match the record id",
          );
        }
        records[collection.directory].push({ id: identity, value: record });
      }
    }

    // Deterministic order by id, then full snapshot validation (exact keys,
    // schema, duplicate ids) via the frozen snapshot parsers.
    let snapshot: RepairStateSnapshotV1 | ReleaseStateSnapshotV1;
    try {
      if (kind === "repair") {
        const repair = {
          version: "v1",
          kind: "repair_state_snapshot",
          stateHead: manifest.stateHead,
          sequence: manifest.sequence,
          updatedAt: manifest.updatedAt,
          incidents: orderRecords(records.incidents) as IncidentSummaryV1[],
          evidence: orderRecords(records.evidence) as IncidentEvidenceV1[],
          work: orderRecords(records.work) as WorkRecordV1[],
          reservations: orderRecords(
            records.reservations,
          ) as BudgetReservationV1[],
          reviews: orderRecords(records.reviews) as ReviewReceiptV1[],
          replays: orderRecords(records.replays) as ReplayResultV1[],
          releaseRequests: orderRecords(
            records.releaseRequests,
          ) as ReleaseRequestV1[],
          githubCooldowns: orderRecords(
            records.githubCooldowns,
          ) as GitHubCooldownV1[],
        };
        snapshot = parseRepairStateSnapshotV1(repair);
      } else {
        const release = {
          version: "v1",
          kind: "release_state_snapshot",
          stateHead: manifest.stateHead,
          sequence: manifest.sequence,
          updatedAt: manifest.updatedAt,
          releases: orderRecords(records.releases) as ReleaseRecordV1[],
          hostedRuntimes: orderRecords(
            records.hostedRuntimes,
          ) as HostedRuntimeRecordV1[],
          hostedReleases: orderRecords(
            records.hostedReleases,
          ) as HostedReleaseRecordV1[],
          githubCooldowns: orderRecords(
            records.githubCooldowns,
          ) as GitHubCooldownV1[],
        };
        snapshot = parseReleaseStateSnapshotV1(release);
      }
    } catch {
      return portError("invalid", "state snapshot failed validation");
    }
    return portOk(snapshot);
  }

  private classifyGitError(
    result: GitRunResultV1,
  ): "auth_failed" | "not_found" | "unavailable" {
    // Classification only; stderr is never echoed (it may contain URLs).
    const text = result.stderr.toLowerCase();
    if (
      text.includes("authentication failed") ||
      text.includes("could not read username") ||
      text.includes("could not read password") ||
      text.includes("permission denied") ||
      text.includes("access denied") ||
      text.includes("401") ||
      text.includes("403")
    ) {
      return "auth_failed";
    }
    if (
      text.includes("not a git repository") ||
      text.includes("does not appear to be a git repository") ||
      text.includes("repository not found") ||
      text.includes("not found")
    ) {
      return "not_found";
    }
    return "unavailable";
  }

  private gitFailure(
    kind: PortErrorV1["kind"],
    operation: string,
    _result: GitRunResultV1,
  ): PortResultV1<never> {
    return portError(
      kind,
      `state remote ${operation} failed; the remote ref state is unknown`,
    );
  }
}

function collectionDirectory(kind: StateKind, recordKind: string): string {
  const collection = RECORD_COLLECTIONS[kind].find(
    (c) => c.kind === recordKind,
  );
  if (collection === undefined) {
    throw new Error(`unknown record kind ${recordKind} for ${kind} state`);
  }
  return collection.directory;
}

/**
 * Storage identity of one validated record. Existing records use their string
 * id; the kind-less GitHub cooldown fragment is addressed by its positive
 * installation id (sha256(String(installationId)).json). A validated record
 * carries exactly one of the two; a record carrying neither is corrupt state
 * and fails closed instead of being written to a wrong storage slot.
 */
function recordIdentity(record: RecordIdentitySource): string {
  if (record.id !== undefined) return record.id;
  if (record.installationId !== undefined) {
    return String(record.installationId);
  }
  throw new Error("state record has no storage identity");
}

function orderRecords<T>(rows: { id: string; value: unknown }[]): T[] {
  return rows
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row) => row.value as T);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomHex(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Transition validation: fail-closed preservation and immutability rules.
// The store refuses any write that silently drops, rewrites or resets state.
// ---------------------------------------------------------------------------

function sameCanonical(a: unknown, b: unknown): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}

function sameRepository(
  a: { owner: string; name: string; installationId: number },
  b: { owner: string; name: string; installationId: number },
): boolean {
  return a.owner === b.owner && a.name === b.name &&
    a.installationId === b.installationId;
}

function validateSnapshotTransition(
  prior: RepairStateSnapshotV1 | ReleaseStateSnapshotV1 | null,
  next: RepairStateSnapshotV1 | ReleaseStateSnapshotV1,
  expectedHead: GitSha | null,
): string | null {
  if (next.stateHead !== expectedHead) {
    return "snapshot stateHead must equal the expected remote head";
  }
  if (prior === null) {
    if (next.sequence !== 1) {
      return "the first state snapshot must have sequence 1";
    }
    // Initial hosted validation: a first release snapshot cannot smuggle
    // historical proofs, a non-initial generation or terminal receipts.
    if (!("work" in next)) {
      const firstRelease = next as ReleaseStateSnapshotV1;
      return validateHostedStateTransition(
        [],
        [],
        firstRelease.hostedRuntimes,
        firstRelease.hostedReleases,
      );
    }
  } else {
    if (next.sequence !== prior.sequence + 1) {
      return "snapshot sequence must be exactly prior sequence + 1";
    }
    if (next.updatedAt < prior.updatedAt) {
      return "snapshot updatedAt cannot move backward";
    }
    if ("work" in prior) {
      return validateRepairTransition(prior, next as RepairStateSnapshotV1);
    }
    return validateReleaseTransition(prior, next as ReleaseStateSnapshotV1);
  }
  return null;
}

function validateRepairTransition(
  prior: RepairStateSnapshotV1,
  next: RepairStateSnapshotV1,
): string | null {
  // Every prior record must survive; existing records must not rewrite their
  // immutable identity or reset terminal state.
  for (const priorRecord of prior.work) {
    const nextRecord = next.work.find((record) => record.id === priorRecord.id);
    if (nextRecord === undefined) {
      return "existing work record cannot be dropped";
    }
    if (priorRecord.nextStep === "done") {
      if (!sameCanonical(priorRecord, nextRecord)) {
        return "a done work record cannot restart or mutate";
      }
      continue;
    }
    if (
      !sameRepository(priorRecord.repository, nextRecord.repository) ||
      priorRecord.source.kind !== nextRecord.source.kind ||
      priorRecord.source.id !== nextRecord.source.id ||
      priorRecord.source.revision !== nextRecord.source.revision ||
      priorRecord.controller.sha !== nextRecord.controller.sha ||
      priorRecord.failingRevision !== nextRecord.failingRevision ||
      priorRecord.sourceSnapshotDigest !== nextRecord.sourceSnapshotDigest
    ) {
      return "existing work record immutable identity changed";
    }
  }
  for (const priorRecord of prior.reservations) {
    const nextRecord = next.reservations.find(
      (record) => record.id === priorRecord.id,
    );
    if (nextRecord === undefined) {
      return "existing reservation cannot disappear";
    }
    if (
      !sameRepository(priorRecord.repository, nextRecord.repository) ||
      priorRecord.taskId !== nextRecord.taskId ||
      priorRecord.attempt !== nextRecord.attempt ||
      priorRecord.head !== nextRecord.head ||
      priorRecord.purpose !== nextRecord.purpose ||
      priorRecord.createdAt !== nextRecord.createdAt
    ) {
      return "existing reservation identity or time changed";
    }
    if (priorRecord.outcome === "ambiguous") {
      // A settled ambiguous reservation stays charged; it may be reconciled
      // as submitted (charged) or proven never submitted (the only uncharged
      // terminal, whose proof ref the parser already requires). The recorded
      // settlement time may advance on resolution, never move backward, and
      // an equal repeated settlement stays idempotent.
      const priorSettledAt = priorRecord.settledAt;
      if (
        priorSettledAt === null || nextRecord.settledAt === null ||
        nextRecord.settledAt < priorSettledAt
      ) {
        return "settled reservation cannot clear or move settlement time backward";
      }
      if (nextRecord.outcome === "reserved") {
        return "settled reservation cannot revert to reserved";
      }
    } else if (priorRecord.outcome !== "reserved") {
      if (!sameCanonical(priorRecord, nextRecord)) {
        return "settled reservation cannot revert or mutate";
      }
    }
  }
  for (const priorRecord of prior.releaseRequests) {
    const nextRecord = next.releaseRequests.find(
      (record) => record.id === priorRecord.id,
    );
    if (nextRecord === undefined) {
      return "existing release request cannot disappear";
    }
    if (
      !sameRepository(
        priorRecord.target.repository,
        nextRecord.target.repository,
      ) ||
      priorRecord.target.environment !== nextRecord.target.environment ||
      priorRecord.revision !== nextRecord.revision ||
      priorRecord.source.pullRequest !== nextRecord.source.pullRequest ||
      priorRecord.source.reviewRequestId !==
        nextRecord.source.reviewRequestId ||
      priorRecord.source.reviewReceiptId !==
        nextRecord.source.reviewReceiptId ||
      priorRecord.source.head !== nextRecord.source.head ||
      priorRecord.source.base !== nextRecord.source.base ||
      priorRecord.createdAt !== nextRecord.createdAt
    ) {
      return "existing release request identity changed";
    }
    if (
      priorRecord.status !== "open" && !sameCanonical(priorRecord, nextRecord)
    ) {
      return "terminal release request cannot restart or mutate";
    }
  }
  // Replay results are terminal proof: exactly immutable, never regenerated.
  for (const priorRecord of prior.replays) {
    const nextRecord = next.replays.find((record) =>
      record.id === priorRecord.id
    );
    if (nextRecord === undefined) {
      return "existing replay result cannot be dropped";
    }
    if (!sameCanonical(priorRecord, nextRecord)) {
      return "existing replay result cannot be rewritten";
    }
  }
  for (const priorRecord of prior.incidents) {
    const nextRecord = next.incidents.find((record) =>
      record.id === priorRecord.id
    );
    if (nextRecord === undefined) {
      return "existing incident summary cannot be dropped";
    }
    if (
      !sameRepository(priorRecord.repository, nextRecord.repository) ||
      priorRecord.fingerprint !== nextRecord.fingerprint ||
      priorRecord.firstSeenAt !== nextRecord.firstSeenAt ||
      priorRecord.failingRevision !== nextRecord.failingRevision
    ) {
      return "existing incident summary identity changed";
    }
    if (nextRecord.count < priorRecord.count) {
      return "incident count cannot decrease";
    }
    if (nextRecord.lastSeenAt < priorRecord.lastSeenAt) {
      return "incident lastSeenAt cannot move backward";
    }
    if (
      priorRecord.provenance.source !== nextRecord.provenance.source ||
      priorRecord.provenance.endpoint !== nextRecord.provenance.endpoint ||
      nextRecord.provenance.capturedAt < priorRecord.provenance.capturedAt
    ) {
      return "incident provenance changed";
    }
    // severity/errorType/context/coverage/evidenceRef stay updateable so
    // repeated discovery and evidence retention work.
  }
  for (const priorRecord of prior.evidence) {
    const nextRecord = next.evidence.find((record) =>
      record.id === priorRecord.id
    );
    if (nextRecord === undefined) {
      return "existing incident evidence cannot be dropped";
    }
    if (
      !sameRepository(priorRecord.repository, nextRecord.repository) ||
      priorRecord.incidentId !== nextRecord.incidentId ||
      priorRecord.fingerprint !== nextRecord.fingerprint ||
      priorRecord.failingRevision !== nextRecord.failingRevision ||
      !sameCanonical(priorRecord.provenance, nextRecord.provenance)
    ) {
      return "existing incident evidence identity or provenance changed";
    }
    for (const artifact of priorRecord.artifacts) {
      if (
        !nextRecord.artifacts.some((next) => sameCanonical(next, artifact))
      ) {
        return "existing evidence artifact cannot be removed or altered";
      }
    }
    if (priorRecord.replay !== null) {
      const nextReplay = nextRecord.replay;
      if (nextReplay === null) {
        return "existing replay metadata cannot be removed";
      }
      // Replay metadata identity: the fixture ref and command stay fixed.
      // upstreamCaptured is derived (the parser ties it to fixtureDigest
      // nullness), so the fill-once rules below govern it completely.
      if (
        nextReplay.fixtureRef !== priorRecord.replay.fixtureRef ||
        nextReplay.commandId !== priorRecord.replay.commandId
      ) {
        return "existing replay metadata identity changed";
      }
      // A null fixtureDigest/reproducedAt may fill once; a non-null identity
      // may never be replaced.
      if (
        priorRecord.replay.fixtureDigest !== null &&
        nextReplay.fixtureDigest !== priorRecord.replay.fixtureDigest
      ) {
        return "replay fixture digest cannot be replaced";
      }
      if (
        priorRecord.replay.reproducedAt !== null &&
        nextReplay.reproducedAt !== priorRecord.replay.reproducedAt
      ) {
        return "replay reproducedAt cannot be replaced";
      }
    }
    // coverage stays updateable.
  }
  // Duplicate artifact refs are never valid, including on newly appended
  // evidence records; refs are exact storage pointers, not multiply-claimable.
  for (const [index, record] of next.evidence.entries()) {
    const seen = new Set<string>();
    for (const artifact of record.artifacts) {
      if (seen.has(artifact.ref)) {
        return `ev${index}: duplicate artifact refs are invalid`;
      }
      seen.add(artifact.ref);
    }
  }
  for (const priorRecord of prior.reviews) {
    const nextRecord = next.reviews.find((record) =>
      record.id === priorRecord.id
    );
    if (nextRecord === undefined) {
      return "existing review receipt cannot be dropped";
    }
    if (
      priorRecord.requestId !== nextRecord.requestId ||
      priorRecord.expectedReviewer !== nextRecord.expectedReviewer ||
      !sameRepository(priorRecord.repository, nextRecord.repository) ||
      !sameCanonical(priorRecord.pullRequest, nextRecord.pullRequest) ||
      priorRecord.submittedAt !== nextRecord.submittedAt
    ) {
      return "existing review receipt identity changed";
    }
    if (nextRecord.observedAt < priorRecord.observedAt) {
      return "review observedAt cannot move backward";
    }
    if (
      priorRecord.outcome === "completed" &&
      !sameCanonical(priorRecord, nextRecord)
    ) {
      return "completed review receipt cannot mutate";
    }
    // pending/unavailable observations may update observed reviewer, result,
    // findings and outcome — including becoming completed.
  }
  // Durable GitHub cooldowns are fail-closed preservation state; the same
  // guard protects both refs.
  return cooldownTransitionMessage(
    prior.githubCooldowns,
    next.githubCooldowns,
  );
}

/**
 * Durable GitHub cooldowns are fail-closed preservation state in both refs:
 * one record per affected installation, never dropped, never moved to a
 * different installation, and a manual fail-closed hold (null deadline) can
 * never be silently converted into a finite retry deadline. A new observation
 * may refresh deadline, observation identity, backoff and observedAt for the
 * same installation; the role-owned writer owns that update policy.
 */
function cooldownTransitionMessage(
  priorRecords: readonly GitHubCooldownV1[],
  nextRecords: readonly GitHubCooldownV1[],
): string | null {
  for (const priorRecord of priorRecords) {
    const nextRecord = nextRecords.find(
      (record) => record.installationId === priorRecord.installationId,
    );
    if (nextRecord === undefined) {
      return "existing github cooldown cannot be dropped";
    }
    if (nextRecord.observedAt < priorRecord.observedAt) {
      return "github cooldown observedAt cannot move backward";
    }
    if (
      priorRecord.retryNotBefore === null &&
      nextRecord.retryNotBefore !== null
    ) {
      return "a manual github cooldown hold cannot become a retry deadline";
    }
  }
  return null;
}

function validateReleaseTransition(
  prior: ReleaseStateSnapshotV1,
  next: ReleaseStateSnapshotV1,
): string | null {
  for (const priorRecord of prior.releases) {
    const nextRecord = next.releases.find(
      (record) => record.id === priorRecord.id,
    );
    if (nextRecord === undefined) {
      return "existing release record cannot disappear";
    }
    if (
      !sameRepository(priorRecord.repository, nextRecord.repository) ||
      priorRecord.environment !== nextRecord.environment ||
      priorRecord.requestId !== nextRecord.requestId ||
      priorRecord.requestRevision !== nextRecord.requestRevision ||
      !sameCanonical(priorRecord.candidate, nextRecord.candidate) ||
      !sameCanonical(priorRecord.prior, nextRecord.prior) ||
      priorRecord.createdAt !== nextRecord.createdAt
    ) {
      return "existing release record candidate/prior/request identity changed";
    }
    if (
      priorRecord.phase === "accepted" ||
      priorRecord.phase === "rolled_back" ||
      priorRecord.phase === "failed"
    ) {
      if (!sameCanonical(priorRecord, nextRecord)) {
        return "terminal release record cannot restart or reset acceptance/rollback";
      }
      continue;
    }
    if (nextRecord.updatedAt < priorRecord.updatedAt) {
      return "release record updatedAt cannot move backward";
    }
    // Same-phase persistence is the normal monitoring resume path (repeated
    // samples, saved intent, interrupted coverage restart); forward
    // transitions remain permitted; backward phase resets stay forbidden.
    const allowed: Record<string, string[]> = {
      requested: ["requested", "promoting", "monitoring", "failed"],
      promoting: ["promoting", "monitoring", "failed", "rolled_back"],
      monitoring: ["monitoring", "accepted", "failed", "rolled_back"],
    };
    if (!allowed[priorRecord.phase]?.includes(nextRecord.phase)) {
      return "release record phase transition is not allowed";
    }
  }
  // Durable cooldowns are preserved on this ref exactly as on the repair ref:
  // a record can never disappear, move backward or lift a manual hold.
  const cooldownMessage = cooldownTransitionMessage(
    prior.githubCooldowns,
    next.githubCooldowns,
  );
  if (cooldownMessage !== null) return cooldownMessage;
  // Hosted supervisor records share this ref through their own collections;
  // the existing Deno checks above run first, then the hosted preservation and
  // pointer-movement rules.
  return validateHostedStateTransition(
    prior.hostedRuntimes,
    prior.hostedReleases,
    next.hostedRuntimes,
    next.hostedReleases,
  );
}

// ---------------------------------------------------------------------------
// Capability facades: narrow the combined store per role so a consumer can
// only receive the capability it may use (release model never gets repair
// write capability and vice versa).
// ---------------------------------------------------------------------------

export interface RepairGitStateStore extends StateReadView, RepairStateWriter {}
export interface ReleaseGitStateStore
  extends StateReadView, ReleaseStateWriter {}

export function createRepairStateStore(
  options: Omit<GitStateStoreOptions, "role">,
): RepairGitStateStore {
  return new GitStateStore({ ...options, role: "repair" });
}

export function createReleaseStateStore(
  options: Omit<GitStateStoreOptions, "role">,
): ReleaseGitStateStore {
  return new GitStateStore({ ...options, role: "release" });
}
