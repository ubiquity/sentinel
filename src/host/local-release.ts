/**
 * Private local-activation receipt I/O (Wave C).
 *
 * This module owns the trusted supervisor's private on-disk state below the
 * state root:
 *
 * - `local-releases/<sha256(requestId)>.json` — one strict
 *   `LocalReleaseReceiptV1` per local release request;
 * - `active-runtime.json` — the private exact-revision pointer
 *   `{version:"v1",kind:"local_active_runtime",revision}` that names the one
 *   active runtime checkout;
 * - `status.json` — the existing bounded local host status receipt read back
 *   as an observed run proof source;
 * - `supervisor-logs/` — bounded private child logs.
 *
 * Every read is bounded before parsing and every write is private (0700
 * directories, 0600 files), written to a temporary sibling, synced and then
 * renamed, so no partial JSON is ever visible. Corrupt, unreadable, oversized
 * or identity-mismatched receipts are explicitly unavailable; a missing file
 * is an explicit null. No repair process writes any of these files.
 */

import type { GitSha } from "../contracts/brands.ts";
import { isGitSha } from "../contracts/brands.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import type {
  LocalReleaseReceiptV1,
  LocalRunOutcomeStatusV1,
} from "../contracts/local-release.ts";
import {
  isLocalReleasePendingPhase,
  LOCAL_RELEASE_RECEIPT_MAX_BYTES,
  LOCAL_RUN_OUTCOME_STATUSES,
  parseLocalReleaseReceiptV1,
  sameLocalReleaseRequestV1,
} from "../contracts/local-release.ts";
import { MaxText } from "../contracts/validation.ts";
import {
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectRecord,
  expectTimestamp,
  expectVersion,
  fail,
} from "../contracts/validation.ts";

/** Static, value-free failure texts. */
const UNAVAILABLE_RECEIPT = "local release receipt is unavailable";
const UNAVAILABLE_POINTER = "local active runtime pointer is unavailable";
const UNAVAILABLE_STATUS = "local run status receipt is unavailable";
const AMBIGUOUS_RECEIPTS = "more than one pending local release receipt exists";

const RECEIPTS_DIR = "local-releases";
const ACTIVE_RUNTIME_FILE = "active-runtime.json";
const STATUS_FILE = "status.json";
const SESSION_MARKER_FILE = "session-active.json";
const SUPERVISOR_LOG_DIR = "supervisor-logs";
export const RUNNER_LOCK_FILE = "runner.lock";
export const SUPERVISOR_LOCK_FILE = "supervisor.lock";
export const LOCAL_RELEASE_LOG_MAX_BYTES = 64 * 1024;

const POINTER_KEYS = ["version", "kind", "revision"] as const;

export interface LocalActiveRuntimePointerV1 {
  version: "v1";
  kind: "local_active_runtime";
  /** The exact active runtime Git SHA; never chosen by time or list order. */
  revision: GitSha;
}

export interface LocalRunStatusV1 {
  invocationId: string;
  controllerSha: GitSha;
  startedAt: number;
  finishedAt: number;
  outcome: LocalRunOutcomeStatusV1;
  /** False when the child reported its own repair state as unavailable. */
  stateAvailable: boolean;
}

export function parseLocalActiveRuntimePointerV1(
  input: unknown,
): LocalActiveRuntimePointerV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, POINTER_KEYS, "$");
  expectVersion(obj.version, "$.version");
  expectEnum(obj.kind, ["local_active_runtime"], "$.kind");
  const revision = expectGitSha(obj.revision, "$.revision");
  return { version: "v1", kind: "local_active_runtime", revision };
}

export interface LocalReleaseReadCapabilityV1 {
  readLocalRelease(
    request: ReleaseRequestV1,
  ): Promise<PortResultV1<LocalReleaseReceiptV1 | null>>;
}

/**
 * Compose the optional `StateReadView.readLocalRelease` capability onto the
 * privately owned local state facade. Only the concrete local host calls this;
 * hosts without a local activation scope never receive the method, and this
 * reader adds nothing beyond the bounded private receipt read.
 */
export function composeLocalReleaseReader(
  stateRoot: string,
): LocalReleaseReadCapabilityV1 {
  return {
    readLocalRelease(request: ReleaseRequestV1) {
      return readLocalReleaseReceipt(stateRoot, request);
    },
  };
}

/** `stateRoot/local-releases/<sha256(request.id)>.json`, never a raw id. */
export async function localReleaseReceiptPath(
  stateRoot: string,
  requestId: string,
): Promise<string> {
  return joinPath(
    stateRoot,
    RECEIPTS_DIR,
    `${await sha256Hex(requestId)}.json`,
  );
}

export function localActiveRuntimePath(stateRoot: string): string {
  return joinPath(stateRoot, ACTIVE_RUNTIME_FILE);
}

export function localStatusPath(stateRoot: string): string {
  return joinPath(stateRoot, STATUS_FILE);
}

export function localSessionMarkerPath(stateRoot: string): string {
  return joinPath(stateRoot, SESSION_MARKER_FILE);
}

export function localRunnerLockPath(stateRoot: string): string {
  return joinPath(stateRoot, RUNNER_LOCK_FILE);
}

export function localSupervisorLockPath(stateRoot: string): string {
  return joinPath(stateRoot, SUPERVISOR_LOCK_FILE);
}

/**
 * Read the strict private receipt for one exact request. Missing is an
 * explicit null; oversized, corrupt, unreadable or identity-mismatched state
 * is unavailable (never a null and never a fallback).
 */
export async function readLocalReleaseReceipt(
  stateRoot: string,
  request: ReleaseRequestV1,
): Promise<PortResultV1<LocalReleaseReceiptV1 | null>> {
  const path = await localReleaseReceiptPath(stateRoot, request.id);
  const text = await readBoundedFile(path, LOCAL_RELEASE_RECEIPT_MAX_BYTES);
  if (text.kind === "missing") return portOk(null);
  if (text.kind === "unavailable") {
    return portError("unavailable", UNAVAILABLE_RECEIPT);
  }
  let receipt: LocalReleaseReceiptV1;
  try {
    receipt = parseLocalReleaseReceiptV1(JSON.parse(text.value));
  } catch {
    return portError("unavailable", UNAVAILABLE_RECEIPT);
  }
  if (
    receipt.request.id !== request.id ||
    receipt.request.revision !== request.revision ||
    !sameLocalReleaseRequestV1(receipt.request, request)
  ) {
    return portError("unavailable", UNAVAILABLE_RECEIPT);
  }
  return portOk(receipt);
}

/** Persist one strict receipt atomically; the caller owns the supervisor lock. */
export async function writeLocalReleaseReceipt(
  stateRoot: string,
  receipt: LocalReleaseReceiptV1,
): Promise<void> {
  const validated = parseLocalReleaseReceiptV1(receipt);
  const dir = joinPath(stateRoot, RECEIPTS_DIR);
  await ensurePrivateDir(dir);
  const path = await localReleaseReceiptPath(stateRoot, validated.request.id);
  await writePrivateFileAtomic(path, JSON.stringify(validated) + "\n");
}

/**
 * All receipts currently present, strictly parsed. A single corrupt or
 * oversized file makes the whole listing unavailable: the supervisor must
 * never reconcile or promote against partial private history.
 */
export async function listLocalReleaseReceipts(
  stateRoot: string,
): Promise<PortResultV1<LocalReleaseReceiptV1[]>> {
  const dir = joinPath(stateRoot, RECEIPTS_DIR);
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".json")) names.push(entry.name);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return portOk([]);
    return portError("unavailable", UNAVAILABLE_RECEIPT);
  }
  names.sort();
  const receipts: LocalReleaseReceiptV1[] = [];
  for (const name of names) {
    const text = await readBoundedFile(
      joinPath(dir, name),
      LOCAL_RELEASE_RECEIPT_MAX_BYTES,
    );
    if (text.kind !== "found") {
      return portError("unavailable", UNAVAILABLE_RECEIPT);
    }
    try {
      receipts.push(parseLocalReleaseReceiptV1(JSON.parse(text.value)));
    } catch {
      return portError("unavailable", UNAVAILABLE_RECEIPT);
    }
  }
  return portOk(receipts);
}

/**
 * The one receipt whose phase still has outstanding work. More than one is a
 * proven ambiguity (two promotions cannot be reconciled deterministically)
 * and is unavailable rather than a guess.
 */
export async function findPendingLocalReleaseReceipt(
  stateRoot: string,
): Promise<PortResultV1<LocalReleaseReceiptV1 | null>> {
  const listed = await listLocalReleaseReceipts(stateRoot);
  if (!listed.ok) return listed;
  const pending = listed.value
    .filter((receipt) => isLocalReleasePendingPhase(receipt.phase))
    .sort((left, right) =>
      left.updatedAt - right.updatedAt ||
      (left.request.id < right.request.id ? -1 : 1)
    );
  if (pending.length > 1) {
    return portError("unavailable", AMBIGUOUS_RECEIPTS);
  }
  return portOk(pending[0] ?? null);
}

/** Read the private active-runtime pointer; missing is an explicit null. */
export async function readLocalActiveRuntime(
  stateRoot: string,
): Promise<PortResultV1<LocalActiveRuntimePointerV1 | null>> {
  const text = await readBoundedFile(
    localActiveRuntimePath(stateRoot),
    8 * 1024,
  );
  if (text.kind === "missing") return portOk(null);
  if (text.kind === "unavailable") {
    return portError("unavailable", UNAVAILABLE_POINTER);
  }
  try {
    return portOk(parseLocalActiveRuntimePointerV1(JSON.parse(text.value)));
  } catch {
    return portError("unavailable", UNAVAILABLE_POINTER);
  }
}

/**
 * Compare-and-set the active-runtime pointer under the supervisor lock: the
 * exact expected revision must still be current immediately before the atomic
 * rename, so an unrelated newer pointer is never overwritten.
 */
export async function compareAndSetLocalActiveRuntime(
  stateRoot: string,
  expected: GitSha,
  next: GitSha,
): Promise<"applied" | "missing" | "mismatch"> {
  const current = await readLocalActiveRuntime(stateRoot);
  if (!current.ok) return "mismatch";
  if (current.value === null) return "missing";
  if (current.value.revision !== expected) return "mismatch";
  await ensurePrivateDir(stateRoot);
  await writePrivateFileAtomic(
    localActiveRuntimePath(stateRoot),
    JSON.stringify(
      {
        version: "v1",
        kind: "local_active_runtime",
        revision: next,
      } satisfies LocalActiveRuntimePointerV1,
    ) + "\n",
  );
  return "applied";
}

/** Read the bounded private status receipt a bounded local run wrote. */
export async function readLocalRunStatus(
  stateRoot: string,
): Promise<PortResultV1<LocalRunStatusV1 | null>> {
  const text = await readBoundedFile(localStatusPath(stateRoot), 256 * 1024);
  if (text.kind === "missing") return portOk(null);
  if (text.kind === "unavailable") {
    return portError("unavailable", UNAVAILABLE_STATUS);
  }
  try {
    const obj = expectRecord(JSON.parse(text.value), "$");
    expectVersion(obj.version, "$.version");
    expectEnum(obj.kind, ["sentinel_local_status"], "$.kind");
    const invocationId = expectNonEmptyString(
      obj.invocationId,
      "$.invocationId",
      MaxText.recordId,
    );
    const controllerSha = expectGitSha(obj.controllerSha, "$.controllerSha");
    const startedAt = expectTimestamp(obj.startedAt, "$.startedAt");
    const finishedAt = expectTimestamp(obj.finishedAt, "$.finishedAt");
    if (finishedAt < startedAt) {
      fail(
        "$.finishedAt",
        "invalid_lifecycle",
        "status finished before it started",
      );
    }
    const outcome = expectRecord(obj.outcome, "$.outcome");
    const status = expectEnum(
      outcome.status,
      LOCAL_RUN_OUTCOME_STATUSES,
      "$.outcome.status",
    );
    // The successful real status shape carries no explicit `state` and always
    // carries the observed work and reservation arrays. The only other valid
    // shape is the explicit `unavailable` state. A success shape that omits
    // its arrays, and any unknown explicit state value, is unavailable.
    let stateAvailable = false;
    if (obj.state === "unavailable") {
      stateAvailable = false;
    } else if (obj.state !== undefined) {
      fail("$.state", "invalid_value", "unknown explicit repair state");
    } else if (Array.isArray(obj.work) && Array.isArray(obj.reservations)) {
      stateAvailable = true;
    } else {
      fail("$.state", "invalid_lifecycle", "status omits its state evidence");
    }
    return portOk({
      invocationId,
      controllerSha,
      startedAt,
      finishedAt,
      outcome: status,
      stateAvailable,
    });
  } catch {
    return portError("unavailable", UNAVAILABLE_STATUS);
  }
}

/**
 * True when a prior/current run left the private session marker behind. Only a
 * proven absence (`NotFound`) is false: every other filesystem error is
 * conservatively reported as present so the supervisor pauses instead of
 * treating unreadable evidence as an absent marker.
 */
export async function localSessionMarkerExists(
  stateRoot: string,
): Promise<boolean> {
  try {
    await Deno.lstat(localSessionMarkerPath(stateRoot));
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    return true;
  }
}

/**
 * Probe the child runner lock without waiting: a successful exclusive acquire
 * followed by an immediate release proves no child currently holds it. The
 * supervisor probes before every child start and again after the child
 * settles; a held lock is never reclaimed by time or process guess.
 */
export async function probeRunnerLock(stateRoot: string): Promise<boolean> {
  await ensurePrivateDir(stateRoot);
  let file: Deno.FsFile;
  try {
    file = await Deno.open(localRunnerLockPath(stateRoot), {
      create: true,
      read: true,
      write: true,
      mode: 0o600,
    });
  } catch {
    return false;
  }
  try {
    if (file.tryLockSync(true)) return true;
  } catch {
    // fall through to close + refusal
  } finally {
    try {
      file.close();
    } catch {
      // the probe result is already decided by the lock attempt
    }
  }
  return false;
}

/** Append one bounded private child log; no credential value is ever written. */
export async function writeLocalChildLog(
  stateRoot: string,
  name: string,
  text: string,
): Promise<void> {
  const dir = joinPath(stateRoot, SUPERVISOR_LOG_DIR);
  await ensurePrivateDir(dir);
  const bounded = text.length > LOCAL_RELEASE_LOG_MAX_BYTES
    ? text.slice(0, LOCAL_RELEASE_LOG_MAX_BYTES)
    : text;
  await Deno.writeTextFile(joinPath(dir, `${safeName(name)}.log`), bounded, {
    mode: 0o600,
  });
}

export async function ensurePrivateDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  try {
    await Deno.chmod(path, 0o700);
  } catch {
    // best-effort tightening; the directory was created private already
  }
}

/** Write-through-temp: sync the private file, then atomically rename it. */
export async function writePrivateFileAtomic(
  path: string,
  text: string,
): Promise<void> {
  const temp = `${path}.tmp-${crypto.randomUUID()}`;
  await Deno.writeTextFile(temp, text, { mode: 0o600 });
  let handle: Deno.FsFile | null = null;
  try {
    handle = await Deno.open(temp, { read: true, write: true });
    await handle.sync();
  } finally {
    try {
      handle?.close();
    } catch {
      // the rename below still decides the visible state
    }
  }
  try {
    await Deno.rename(temp, path);
  } catch (error) {
    try {
      await Deno.remove(temp);
    } catch {
      // the original error decides
    }
    throw error;
  }
  try {
    await Deno.chmod(path, 0o600);
  } catch {
    // best-effort tightening; the file was created 0600 already
  }
}

type BoundedRead =
  | { kind: "found"; value: string }
  | { kind: "missing" }
  | { kind: "unavailable" };

/** Bounded read: a missing file is distinct from an unreadable/oversized one. */
export async function readBoundedFile(
  path: string,
  maxBytes: number,
): Promise<BoundedRead> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { kind: "missing" };
    return { kind: "unavailable" };
  }
  try {
    const info = await file.stat();
    if (!info.isFile || info.size > maxBytes) return { kind: "unavailable" };
    const bytes = new Uint8Array(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes.subarray(offset));
      if (read === null) break;
      offset += read;
    }
    if (offset !== bytes.length) return { kind: "unavailable" };
    return { kind: "found", value: new TextDecoder().decode(bytes) };
  } catch {
    return { kind: "unavailable" };
  } finally {
    try {
      file.close();
    } catch {
      // the read result is already decided
    }
  }
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

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
}

function joinPath(base: string, ...parts: string[]): string {
  let out = base.replace(/\/+$/, "");
  for (const part of parts) {
    out += "/" + part.replace(/^\/+|\/+$/g, "");
  }
  return out.length === 0 ? "/" : out;
}

/** Exported for the supervisor's own shape checks; never used to pick a SHA. */
export function isExactGitSha(value: unknown): value is GitSha {
  return isGitSha(value);
}
