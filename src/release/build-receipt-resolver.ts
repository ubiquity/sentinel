/**
 * Concrete authenticated GitHub build receipt resolver (m05).
 *
 * Implements BuildReceiptResolverV1 against the fixed GitHub REST origin
 * `https://api.github.com`. The exact accepted merged PR binds the request
 * revision, the trusted workflow blob is pinned at that revision, exactly one
 * terminal push run for the request workflow/branch/revision is selected
 * (never by time or list order), the exact attempt's receipt artifact is
 * downloaded through the authenticated 302 plus credential-free signed
 * storage flow with exact size/digest verification, the archive is decoded by
 * the bounded receipt-archive reader and validated against the strict
 * producer schema, and the run attempt is re-read before the receipt is
 * returned.
 *
 * Hard rules of this module:
 * - Multiple matching runs or artifacts are ambiguous, never selected by
 *   order or time; an empty listing is absent; a failure is never a
 *   successful empty result.
 * - All API requests are GETs that target only the fixed API origin; the
 *   artifact 302 Location is followed exactly once with no credentials and
 *   no redirects, and only after rejecting non-HTTPS, userinfo, fragments,
 *   IP-literal and localhost hosts.
 * - No raw URL, body, header, token or exception is ever returned: every
 *   failure is a static typed PortResultV1 error.
 * - One whole-resolve deadline (default 30s, constructor `timeoutMs`
 *   1..30000 for deterministic tests) spans auth, all reads, the body and
 *   ZIP decoding; uncooperative promises are raced and late responses and
 *   readers are cancelled, timers are cleared.
 * - The resolver writes no state and promotes nothing.
 */

import type { GitSha } from "../contracts/brands.ts";
import { isGitSha } from "../contracts/brands.ts";
import {
  type Clock,
  portError,
  type PortErrorKindV1,
  portOk,
  type PortResultV1,
} from "../contracts/ports.ts";
import type {
  ReleaseRequestV1,
  ReleaseTargetEnvironmentV1,
} from "../contracts/release.ts";
import { parseReleaseRequestV1 } from "../contracts/release.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { parseRepositoryIdentity } from "../contracts/shared.ts";
import type {
  BuildReceiptLookupV1,
  BuildReceiptResolverV1,
} from "./resolver.ts";
import { decodeBuildReceiptArchive } from "./receipt-archive.ts";

/** Fixed GitHub REST origin; the only API origin ever requested. */
const API_ORIGIN = "https://api.github.com";
const API_ACCEPT = "application/vnd.github+json";
const API_VERSION = "2022-11-28";

const WORKFLOW_PATH = ".github/workflows/deno-deploy.yml";
const WORKFLOW_FILENAME = "deno-deploy.yml";
const RECEIPT_ARTIFACT_PREFIX = "sentinel-build-receipt-";

/** Hard response/body bounds. */
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 262144;
const MAX_SIGNED_URL_CHARS = 8192;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MAX_TOTAL_ITEMS = 1000;

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 30_000;

const BASE_BRANCH_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,254})$/;
const REVISION_ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
const ARTIFACT_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const CONTROL_CHARS_RE = /[\p{Cc}]/u;

/** Exact production/isolated projects trusted for this resolver. */
const PROJECT_FOR_ENVIRONMENT: Record<ReleaseTargetEnvironmentV1, string> = {
  production: "ai-ubq-fi",
  isolated: "p-ai-ubq-fi",
};

// ---------------------------------------------------------------------------
// Static (never raw) error details.
// ---------------------------------------------------------------------------

const ERR_CONFIG = "resolver configuration is invalid";
const ERR_REQUEST = "release request is invalid";
const ERR_REQUEST_REPOSITORY =
  "release request repository does not match the configured repository";
const ERR_REQUEST_ENVIRONMENT =
  "release request environment does not match the configured environment";
const ERR_TIMEOUT = "build receipt resolution timed out";
const ERR_TRANSPORT = "GitHub API request failed";
const ERR_AUTH = "GitHub API authentication failed";
const ERR_RATE = "GitHub API rate limit exceeded";
const ERR_NOT_FOUND = "GitHub API resource not found";
const ERR_PAYLOAD = "GitHub API response is invalid";
const ERR_PR = "GitHub pull request response is invalid";
const ERR_WORKFLOW = "GitHub workflow response is invalid";
const ERR_RUNS = "GitHub workflow runs response is invalid";
const ERR_RUNS_PAGINATION = "GitHub workflow runs pagination is invalid";
const ERR_ATTEMPT = "GitHub workflow run attempt response is invalid";
const ERR_ARTIFACTS = "GitHub workflow run artifacts response is invalid";
const ERR_ARTIFACTS_PAGINATION =
  "GitHub workflow run artifacts pagination is invalid";
const ERR_ARTIFACT = "build receipt artifact is invalid";
const ERR_ARTIFACT_EXPIRED = "build receipt artifact is expired";
const ERR_ARTIFACT_SIZE = "build receipt artifact size mismatch";
const ERR_ARTIFACT_DIGEST = "build receipt artifact digest mismatch";
const ERR_SIGNED_URL = "build receipt artifact download URL is invalid";
const ERR_STORAGE = "build receipt artifact download failed";
const ERR_RECEIPT = "build receipt payload is invalid";
const ERR_RERUN = "build workflow run attempt changed during resolution";
const ERR_UNEXPECTED = "build receipt resolution failed";

// ---------------------------------------------------------------------------
// Deadline racing.
// ---------------------------------------------------------------------------

const DEADLINE = Symbol("deadline");

type Guarded<T> = T | typeof DEADLINE;

/**
 * Race a promise against a real-time deadline. The timer is always cleared
 * and a late rejection after the race settled is consumed, so an
 * uncooperative promise can never leak a timer or an unhandled rejection.
 */
function guardUntil<T>(
  promise: Promise<T>,
  remainingMs: number,
): Promise<Guarded<T>> {
  const tracked = Promise.resolve(promise);
  if (remainingMs <= 0) {
    // The caller still owns the promise; consume its rejection even when the
    // deadline already expired, so a late failure is never unhandled.
    tracked.catch(() => {});
    return Promise.resolve(DEADLINE);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE), remainingMs);
  });
  const outcome = Promise.race([tracked, timeout]) as Promise<Guarded<T>>;
  tracked.catch(() => {}); // consume a rejection that arrives after the race
  void outcome.then(
    () => clearTimeout(timer),
    () => clearTimeout(timer),
  );
  return outcome;
}

/** One whole-resolve real-time budget, from before auth through body+ZIP. */
class DeadlineTracker {
  private readonly startedAt: number;

  constructor(private readonly budgetMs: number) {
    this.startedAt = Date.now();
  }

  remainingMs(): number {
    return Math.max(0, this.budgetMs - (Date.now() - this.startedAt));
  }

  isExhausted(): boolean {
    return this.remainingMs() <= 0;
  }
}

/** Grace window for best-effort cleanup of uncooperative promises. */
const CLEANUP_GRACE_MS = 500;

/**
 * Start best-effort cleanup without ever awaiting it. Cleanup is bounded by
 * a grace timer (unref'd so a pending cleanup never keeps the runtime alive)
 * and every rejection is consumed, so an uncooperative cancel can never hang
 * or leak an unhandled rejection.
 */
function startCleanup(work: Promise<unknown>): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE), CLEANUP_GRACE_MS);
    const deno = (globalThis as {
      Deno?: { unrefTimer?: (id: ReturnType<typeof setTimeout>) => void };
    }).Deno;
    deno?.unrefTimer?.(timer);
  });
  const settled = Promise.race([Promise.resolve(work).catch(() => {}), grace]);
  void settled.then(() => clearTimeout(timer), () => clearTimeout(timer));
}

/** Tracks in-flight fetch controllers and body readers for cleanup. */
class FetchContext {
  private readonly controllers: AbortController[] = [];
  private readonly readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();

  track(controller: AbortController): void {
    this.controllers.push(controller);
  }

  trackReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
    this.readers.add(reader);
  }

  /** Best-effort bounded cancel of an unread response body; never awaited. */
  cancelBody(body: ReadableStream<Uint8Array> | null): void {
    if (body === null) return;
    startCleanup(Promise.resolve().then(() => body.cancel()));
  }

  /**
   * Best-effort bounded cancel of a tracked reader and release of its lock.
   * Every exit path of a bounded body read ends here, so a reader is never
   * left tracked or locked after this resolver stops waiting on it. The lock
   * is released immediately after cancel() is issued, never while awaiting
   * cancellation settlement, so an underlying cancel that never settles
   * cannot keep the stream locked.
   */
  cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
    this.readers.delete(reader);
    try {
      startCleanup(Promise.resolve(reader.cancel()));
    } catch {
      // Cancel already ran or the reader was released; still unlock below.
    }
    try {
      reader.releaseLock();
    } catch {
      // Lock already released or a pending read still holds it.
    }
  }

  dispose(): void {
    for (const controller of this.controllers) controller.abort();
    this.controllers.length = 0;
    for (const reader of this.readers) this.cancelReader(reader);
  }
}

// ---------------------------------------------------------------------------
// Strict fail-closed payload field readers. A malformed shape throws
// BadPayload; each step maps that to one static invalid error.
// ---------------------------------------------------------------------------

class BadPayload extends Error {}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadPayload();
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  if (typeof value !== "string") throw new BadPayload();
  return value;
}

function asBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new BadPayload();
  return value;
}

function asPosInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new BadPayload();
  }
  return value;
}

function asNonNegInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BadPayload();
  }
  return value;
}

function field(obj: Record<string, unknown>, key: string): unknown {
  if (!(key in obj)) throw new BadPayload();
  return obj[key];
}

function repoField(obj: Record<string, unknown>): {
  id: number;
  fullName: string;
} {
  const repo = asRecord(field(obj, "repository"));
  return {
    id: asPosInt(field(repo, "id")),
    fullName: asString(field(repo, "full_name")),
  };
}

function headRepoField(obj: Record<string, unknown>): {
  id: number;
  fullName: string;
} {
  const repo = asRecord(field(obj, "head_repository"));
  return {
    id: asPosInt(field(repo, "id")),
    fullName: asString(field(repo, "full_name")),
  };
}

// ---------------------------------------------------------------------------
// GithubApi: bounded authenticated GETs against the fixed API origin.
// ---------------------------------------------------------------------------

export interface GithubBuildReceiptResolverAuthV1 {
  /** Returns the full `Authorization` header value, e.g. `Bearer <token>`. */
  authorizationHeader(): Promise<PortResultV1<string>>;
}

export interface GithubBuildReceiptResolverOptionsV1 {
  repository: RepositoryIdentityV1;
  environment: ReleaseTargetEnvironmentV1;
  project: string;
  baseBranch: string;
  workflowBlobSha: GitSha;
  clock: Clock;
  auth: GithubBuildReceiptResolverAuthV1;
  fetch?: typeof globalThis.fetch;
  /** Internal deterministic test timeout only; default 30000ms. */
  timeoutMs?: number;
}

interface ValidatedConfig {
  repository: RepositoryIdentityV1;
  environment: ReleaseTargetEnvironmentV1;
  project: string;
  baseBranch: string;
  workflowBlobSha: GitSha;
  clock: Clock;
  auth: GithubBuildReceiptResolverAuthV1;
  fetchImpl: typeof globalThis.fetch;
  timeoutMs: number;
}

function validateConfig(value: unknown): ValidatedConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;

  let repository: RepositoryIdentityV1;
  try {
    repository = parseRepositoryIdentity(raw.repository, "$");
  } catch {
    return null;
  }
  const environment = raw.environment;
  if (environment !== "production" && environment !== "isolated") return null;
  const project = raw.project;
  if (typeof project !== "string" || project === "") return null;
  if (project !== PROJECT_FOR_ENVIRONMENT[environment]) return null;
  const baseBranch = raw.baseBranch;
  if (
    typeof baseBranch !== "string" ||
    baseBranch.length === 0 ||
    CONTROL_CHARS_RE.test(baseBranch) ||
    baseBranch !== baseBranch.trim() ||
    !BASE_BRANCH_RE.test(baseBranch)
  ) {
    return null;
  }
  const workflowBlobSha = raw.workflowBlobSha;
  if (typeof workflowBlobSha !== "string" || !isGitSha(workflowBlobSha)) {
    return null;
  }
  const clock = raw.clock;
  if (
    typeof clock !== "object" || clock === null ||
    typeof (clock as Record<string, unknown>).now !== "function"
  ) {
    return null;
  }
  const auth = raw.auth;
  if (
    typeof auth !== "object" || auth === null ||
    typeof (auth as Record<string, unknown>).authorizationHeader !==
      "function"
  ) {
    return null;
  }
  const customFetch = raw.fetch;
  if (customFetch !== undefined && typeof customFetch !== "function") {
    return null;
  }
  const timeoutMs = raw.timeoutMs === undefined
    ? DEFAULT_TIMEOUT_MS
    : raw.timeoutMs;
  if (
    typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS
  ) {
    return null;
  }
  return {
    repository,
    environment,
    project,
    baseBranch,
    workflowBlobSha: workflowBlobSha as GitSha,
    clock: clock as Clock,
    auth: auth as GithubBuildReceiptResolverAuthV1,
    fetchImpl: (customFetch ?? globalThis.fetch) as typeof globalThis.fetch,
    timeoutMs,
  };
}

function mapHttpStatus(status: number): PortResultV1<never> {
  if (status === 401 || status === 403) {
    return portError("auth_failed", ERR_AUTH);
  }
  if (status === 429) return portError("rate_limited", ERR_RATE);
  if (status === 404) return portError("not_found", ERR_NOT_FOUND);
  return portError("unavailable", ERR_TRANSPORT);
}

/** Bounded JSON body read: exactly 200, at most MAX_JSON_BYTES, fatal UTF-8. */
async function readBoundedBytes(
  api: GithubApi,
  response: Response,
  cap: number,
  errorDetail: string,
): Promise<PortResultV1<Uint8Array>> {
  const body = response.body;
  if (body === null) return portError("invalid", errorDetail);
  const reader = body.getReader();
  api.ctx.trackReader(reader);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const guarded = await guardUntil(
        reader.read(),
        api.tracker.remainingMs(),
      );
      if (guarded === DEADLINE) {
        api.ctx.cancelReader(reader);
        return portError("unavailable", ERR_TIMEOUT);
      }
      const step = guarded;
      if (step.done) break;
      const chunk = step.value;
      if (chunk.byteLength === 0) continue;
      total += chunk.byteLength;
      if (total > cap) {
        api.ctx.cancelReader(reader);
        return portError("invalid", errorDetail);
      }
      chunks.push(chunk);
    }
  } catch {
    api.ctx.cancelReader(reader);
    if (api.tracker.isExhausted()) return portError("unavailable", ERR_TIMEOUT);
    return portError("invalid", errorDetail);
  }
  api.ctx.cancelReader(reader); // stream done: release the lock, best-effort
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return portOk(output);
}

class GithubApi {
  readonly ctx = new FetchContext();

  constructor(
    readonly fetchImpl: typeof globalThis.fetch,
    readonly tracker: DeadlineTracker,
    readonly authorization: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      authorization: this.authorization,
      accept: API_ACCEPT,
      "x-github-api-version": API_VERSION,
    };
  }

  /** Authenticated bounded GET against the fixed API origin; no redirect. */
  async get(
    pathname: string,
    params: Record<string, string> | null = null,
    manualRedirect = false,
  ): Promise<PortResultV1<Response>> {
    if (this.tracker.isExhausted()) {
      return portError("unavailable", ERR_TIMEOUT);
    }
    const url = new URL(`${API_ORIGIN}${pathname}`);
    if (params !== null) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }
    const controller = new AbortController();
    this.ctx.track(controller);
    const fetchPromise = this.fetchImpl(url.href, {
      method: "GET",
      headers: this.headers(),
      signal: controller.signal,
      redirect: manualRedirect ? "manual" : "error",
    });
    try {
      const guarded = await guardUntil(
        fetchPromise,
        this.tracker.remainingMs(),
      );
      if (guarded === DEADLINE) {
        controller.abort();
        // The injected transport may ignore the signal; cancel any late body.
        void fetchPromise.then(
          (late) => this.ctx.cancelBody(late.body),
          () => {},
        );
        return portError("unavailable", ERR_TIMEOUT);
      }
      return portOk(guarded);
    } catch {
      if (this.tracker.isExhausted()) {
        return portError("unavailable", ERR_TIMEOUT);
      }
      return portError("unavailable", ERR_TRANSPORT);
    }
  }

  async getJson(
    pathname: string,
    params: Record<string, string> | null = null,
  ): Promise<PortResultV1<unknown>> {
    const response = await this.get(pathname, params);
    if (!response.ok) return response;
    if (response.value.status !== 200) {
      this.ctx.cancelBody(response.value.body);
      return mapHttpStatus(response.value.status);
    }
    const bytes = await readBoundedBytes(
      this,
      response.value,
      MAX_JSON_BYTES,
      ERR_PAYLOAD,
    );
    if (!bytes.ok) return bytes;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.value);
    } catch {
      return portError("invalid", ERR_PAYLOAD);
    }
    try {
      return portOk(JSON.parse(text) as unknown);
    } catch {
      return portError("invalid", ERR_PAYLOAD);
    }
  }

  /** Credential-free signed storage GET: no auth, no redirect, no cookies. */
  async downloadSigned(location: URL): Promise<PortResultV1<Response>> {
    if (this.tracker.isExhausted()) {
      return portError("unavailable", ERR_TIMEOUT);
    }
    const controller = new AbortController();
    this.ctx.track(controller);
    const fetchPromise = this.fetchImpl(location.href, {
      method: "GET",
      headers: { accept: "application/octet-stream" },
      redirect: "error",
      credentials: "omit",
      signal: controller.signal,
    });
    try {
      const guarded = await guardUntil(
        fetchPromise,
        this.tracker.remainingMs(),
      );
      if (guarded === DEADLINE) {
        controller.abort();
        void fetchPromise.then(
          (late) => this.ctx.cancelBody(late.body),
          () => {},
        );
        return portError("unavailable", ERR_TIMEOUT);
      }
      return portOk(guarded);
    } catch {
      if (this.tracker.isExhausted()) {
        return portError("unavailable", ERR_TIMEOUT);
      }
      return portError("unavailable", ERR_STORAGE);
    }
  }
}

/** Bounded complete pagination over locally built fixed page URLs. */
interface PagedPayload {
  total: number;
  items: unknown[];
}

async function paginate(
  api: GithubApi,
  pathname: string,
  params: Record<string, string>,
  itemsField: string,
  paginationDetail: string,
): Promise<PortResultV1<PagedPayload>> {
  let expectedTotal: number | null = null;
  const items: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageParams: Record<string, string> = {
      ...params,
      per_page: String(PAGE_SIZE),
      page: String(page),
    };
    const pageResult = await api.getJson(pathname, pageParams);
    if (!pageResult.ok) return pageResult;
    let total: number;
    let pageItems: unknown[];
    try {
      const root = asRecord(pageResult.value);
      total = asNonNegInt(field(root, "total_count"));
      const rawItems = field(root, itemsField);
      if (!Array.isArray(rawItems)) throw new BadPayload();
      pageItems = rawItems;
      if (pageItems.length > PAGE_SIZE) throw new BadPayload();
    } catch {
      return portError("invalid", paginationDetail);
    }
    if (total >= MAX_TOTAL_ITEMS) return portError("invalid", paginationDetail);
    if (expectedTotal === null) {
      expectedTotal = total;
    } else if (expectedTotal !== total) {
      return portError("invalid", paginationDetail);
    }
    items.push(...pageItems);
    if (items.length === expectedTotal) break;
    if (items.length > expectedTotal) {
      return portError("invalid", paginationDetail);
    }
    if (pageItems.length === 0) return portError("invalid", paginationDetail);
    if (page === MAX_PAGES) return portError("invalid", paginationDetail);
  }
  return portOk({ total: expectedTotal as number, items });
}

// ---------------------------------------------------------------------------
// GitHub response validation (mirrors official REST field shapes).
// ---------------------------------------------------------------------------

interface VerifiedRun {
  id: number;
  attempt: number;
}

type RunSelection =
  | { status: "run"; run: VerifiedRun }
  | { status: "absent" }
  | { status: "ambiguous" };

interface VerifiedArtifact {
  id: number;
  sizeInBytes: number;
  digestHex: string;
}

function validatePrPayload(
  payload: unknown,
  expected: {
    pullRequest: number;
    revision: string;
    head: string;
    baseBranch: string;
    repoFull: string;
  },
): { repoId: number } | null {
  try {
    const pr = asRecord(payload);
    if (asPosInt(field(pr, "number")) !== expected.pullRequest) return null;
    if (asBoolean(field(pr, "merged")) !== true) return null;
    if (asString(field(pr, "merge_commit_sha")) !== expected.revision) {
      return null;
    }
    const head = asRecord(field(pr, "head"));
    if (asString(field(head, "sha")) !== expected.head) return null;
    const base = asRecord(field(pr, "base"));
    if (asString(field(base, "ref")) !== expected.baseBranch) return null;
    // GitHub GET /pulls/{n} carries the repository inside base.repo, never a
    // top-level `repository`; the trusted repo id is derived from base.repo.
    const baseRepo = asRecord(field(base, "repo"));
    if (asString(field(baseRepo, "full_name")) !== expected.repoFull) {
      return null;
    }
    return { repoId: asPosInt(field(baseRepo, "id")) };
  } catch {
    return null;
  }
}

function validateWorkflowPayload(
  payload: unknown,
  expected: { workflowId: number | null },
): number {
  const workflow = asRecord(payload);
  const id = asPosInt(field(workflow, "id"));
  if (expected.workflowId !== null && id !== expected.workflowId) {
    throw new BadPayload();
  }
  if (asString(field(workflow, "path")) !== WORKFLOW_PATH) {
    throw new BadPayload();
  }
  return id;
}

function validateRunListItem(
  item: unknown,
  expected: {
    revision: string;
    baseBranch: string;
    repoFull: string;
    workflowId: number;
    repoId: number;
  },
): { id: number; attempt: number; terminal: boolean } {
  const run = asRecord(item);
  const id = asPosInt(field(run, "id"));
  const attempt = asPosInt(field(run, "run_attempt"));
  const event = asString(field(run, "event"));
  const status = asString(field(run, "status"));
  const conclusionRaw = field(run, "conclusion");
  const conclusion = conclusionRaw === null ? null : asString(conclusionRaw);
  if (status === "completed" && conclusion === null) throw new BadPayload();
  const repository = repoField(run);
  const headRepository = headRepoField(run);
  if (
    event !== "push" ||
    asString(field(run, "head_sha")) !== expected.revision ||
    asString(field(run, "head_branch")) !== expected.baseBranch ||
    asPosInt(field(run, "workflow_id")) !== expected.workflowId ||
    repository.fullName !== expected.repoFull ||
    repository.id !== expected.repoId ||
    headRepository.fullName !== expected.repoFull ||
    headRepository.id !== expected.repoId
  ) {
    throw new BadPayload();
  }
  const terminal = status === "completed" &&
    (conclusion === "success" || conclusion === "failure");
  return { id, attempt, terminal };
}

function validateAttemptPayload(
  payload: unknown,
  expected: {
    runId: number;
    attempt: number;
    revision: string;
    baseBranch: string;
    repoFull: string;
    workflowId: number;
    repoId: number;
  },
): "success" | "failure" {
  const attempt = asRecord(payload);
  if (asPosInt(field(attempt, "id")) !== expected.runId) throw new BadPayload();
  if (asPosInt(field(attempt, "run_attempt")) !== expected.attempt) {
    throw new BadPayload();
  }
  const event = asString(field(attempt, "event"));
  const status = asString(field(attempt, "status"));
  const conclusion = asString(field(attempt, "conclusion"));
  const repository = repoField(attempt);
  const headRepository = headRepoField(attempt);
  if (
    event !== "push" || status !== "completed" ||
    (conclusion !== "success" && conclusion !== "failure") ||
    asString(field(attempt, "head_sha")) !== expected.revision ||
    asString(field(attempt, "head_branch")) !== expected.baseBranch ||
    asPosInt(field(attempt, "workflow_id")) !== expected.workflowId ||
    repository.fullName !== expected.repoFull ||
    repository.id !== expected.repoId ||
    headRepository.fullName !== expected.repoFull ||
    headRepository.id !== expected.repoId
  ) {
    throw new BadPayload();
  }
  return conclusion;
}

/** The selected receipt artifact exists but is expired. */
class ArtifactExpired extends Error {}

/**
 * Structural identity of ANY listed artifact entry. Receipt-specific checks
 * never apply here: a listing can mix unrelated artifact types that are
 * larger than the receipt cap, expired or carry no digest.
 */
function validateArtifactIdentity(
  item: unknown,
): { id: number; name: string } {
  const artifact = asRecord(item);
  const id = asPosInt(field(artifact, "id"));
  const name = asString(field(artifact, "name"));
  if (name === "") throw new BadPayload();
  return { id, name };
}

/**
 * Receipt-specific checks, applied ONLY to the single exactly-named selected
 * artifact after the target-name count was determined.
 */
function validateReceiptArtifact(
  item: unknown,
  expected: {
    runId: number;
    revision: string;
    baseBranch: string;
    repoId: number;
    nowMs: number;
  },
): { id: number; name: string; sizeInBytes: number; digestHex: string } {
  const artifact = asRecord(item);
  const id = asPosInt(field(artifact, "id"));
  const name = asString(field(artifact, "name"));
  const sizeInBytes = asPosInt(field(artifact, "size_in_bytes"));
  if (sizeInBytes > MAX_ARCHIVE_BYTES) throw new BadPayload();
  const digest = asString(field(artifact, "digest"));
  if (!ARTIFACT_DIGEST_RE.test(digest)) throw new BadPayload();
  const expired = asBoolean(field(artifact, "expired"));
  const expiresAtRaw = asString(field(artifact, "expires_at"));
  const expiresAt = Date.parse(expiresAtRaw);
  if (!Number.isFinite(expiresAt)) throw new BadPayload();
  if (expired || expiresAt <= expected.nowMs) throw new ArtifactExpired();
  const workflowRun = asRecord(field(artifact, "workflow_run"));
  if (
    asPosInt(field(workflowRun, "id")) !== expected.runId ||
    asPosInt(field(workflowRun, "repository_id")) !== expected.repoId ||
    asPosInt(field(workflowRun, "head_repository_id")) !== expected.repoId ||
    asString(field(workflowRun, "head_sha")) !== expected.revision ||
    asString(field(workflowRun, "head_branch")) !== expected.baseBranch
  ) {
    throw new BadPayload();
  }
  if (name === "") throw new BadPayload();
  return { id, name, sizeInBytes, digestHex: digest.slice("sha256:".length) };
}

// ---------------------------------------------------------------------------
// Strict producer receipt schema.
// ---------------------------------------------------------------------------

const RECEIPT_KEYS = [
  "version",
  "repository",
  "run_id",
  "run_attempt",
  "workflow_ref",
  "git_sha",
  "project",
  "revision_id",
  "build_transaction_id",
] as const;

/** No control characters and no leading/trailing whitespace (incl. newline). */
function isCanonicalString(value: string): boolean {
  if (value.length === 0) return false;
  if (CONTROL_CHARS_RE.test(value)) return false;
  if (value !== value.trim()) return false;
  return true;
}

function parseProducerReceipt(
  payload: unknown,
  expected: {
    repoFull: string;
    runId: string;
    attempt: string;
    workflowRef: string;
    revision: string;
    project: string;
    transaction: string;
  },
): { revisionId: string; buildTransactionId: string } | null {
  let obj: Record<string, unknown>;
  try {
    obj = asRecord(payload);
  } catch {
    return null;
  }
  const keys = Object.keys(obj);
  if (keys.length !== RECEIPT_KEYS.length) return null;
  for (const key of RECEIPT_KEYS) {
    if (!(key in obj)) return null;
  }
  if (obj.version !== 1) return null;
  const strings: Record<string, string> = {};
  for (const key of RECEIPT_KEYS) {
    if (key === "version") continue;
    const value = obj[key];
    if (typeof value !== "string" || !isCanonicalString(value)) return null;
    strings[key] = value;
  }
  if (strings.repository !== expected.repoFull) return null;
  if (strings.run_id !== expected.runId) return null;
  if (strings.run_attempt !== expected.attempt) return null;
  if (strings.workflow_ref !== expected.workflowRef) return null;
  if (strings.git_sha !== expected.revision) return null;
  if (strings.project !== expected.project) return null;
  if (!REVISION_ID_RE.test(strings.revision_id)) return null;
  if (strings.build_transaction_id !== expected.transaction) return null;
  return {
    revisionId: strings.revision_id,
    buildTransactionId: strings.build_transaction_id,
  };
}

// ---------------------------------------------------------------------------
// Signed download URL validation.
// ---------------------------------------------------------------------------

/**
 * Reject control chars, any raw fragment (including the empty `#`), IP
 * literals (IPv4 dotted and IPv6), localhost with or without a trailing DNS
 * dot, non-HTTPS, userinfo, nonstandard port and single-label hosts.
 */
function parseSignedLocation(location: string): URL | null {
  if (location.length === 0 || location.length > MAX_SIGNED_URL_CHARS) {
    return null;
  }
  if (CONTROL_CHARS_RE.test(location)) return null;
  if (location.includes("#")) return null;
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.hash !== "") return null;
  if (url.port !== "" && url.port !== "443") return null;
  const host = url.hostname.toLowerCase();
  const hostBase = host.endsWith(".") ? host.slice(0, -1) : host;
  if (hostBase === "" || host.includes(":")) return null; // IPv6 literal
  if (hostBase === "localhost" || hostBase.endsWith(".localhost")) return null;
  const ipv4 = /^[0-9]+(\.[0-9]+){3}$/;
  if (ipv4.test(host) || ipv4.test(hostBase)) return null; // IPv4 literal
  if (!hostBase.includes(".")) return null; // single-label host is not a storage host
  return url;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// The resolver.
// ---------------------------------------------------------------------------

/**
 * Concrete authenticated resolver for one configured repository/project.
 * The trusted host injects repository, project, base branch, the pinned
 * workflow blob SHA, clock, auth capability, fetch and optional timeout; this
 * construction is a local capability, not an approved deployment policy.
 */
export class GithubBuildReceiptResolver implements BuildReceiptResolverV1 {
  private readonly repository: RepositoryIdentityV1;
  private readonly environment: ReleaseTargetEnvironmentV1;
  private readonly project: string;
  private readonly baseBranch: string;
  private readonly workflowBlobSha: GitSha;
  private readonly clock: Clock;
  private readonly auth: GithubBuildReceiptResolverAuthV1;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly configError:
    | { kind: PortErrorKindV1; detail: string }
    | null;

  constructor(options: GithubBuildReceiptResolverOptionsV1) {
    const config = validateConfig(options);
    if (config === null) {
      this.repository = {
        owner: "",
        name: "",
        installationId: 0,
      };
      this.environment = "production";
      this.project = "";
      this.baseBranch = "";
      this.workflowBlobSha = "" as GitSha;
      this.clock = { now: () => 0 };
      this.auth = {
        authorizationHeader: () =>
          Promise.resolve(portError("unavailable", "unavailable")),
      };
      this.fetchImpl = globalThis.fetch;
      this.timeoutMs = DEFAULT_TIMEOUT_MS;
      this.configError = { kind: "invalid", detail: ERR_CONFIG };
      return;
    }
    this.repository = config.repository;
    this.environment = config.environment;
    this.project = config.project;
    this.baseBranch = config.baseBranch;
    this.workflowBlobSha = config.workflowBlobSha;
    this.clock = config.clock;
    this.auth = config.auth;
    this.fetchImpl = config.fetchImpl;
    this.timeoutMs = config.timeoutMs;
    this.configError = null;
  }

  async resolve(
    request: ReleaseRequestV1,
  ): Promise<PortResultV1<BuildReceiptLookupV1>> {
    if (this.configError !== null) {
      return portError(this.configError.kind, this.configError.detail);
    }
    let parsed: ReleaseRequestV1;
    try {
      parsed = parseReleaseRequestV1(request);
    } catch {
      return portError("invalid", ERR_REQUEST);
    }
    if (
      parsed.target.repository.owner !== this.repository.owner ||
      parsed.target.repository.name !== this.repository.name ||
      parsed.target.repository.installationId !==
        this.repository.installationId
    ) {
      return portError("invalid", ERR_REQUEST_REPOSITORY);
    }
    if (parsed.target.environment !== this.environment) {
      return portError("invalid", ERR_REQUEST_ENVIRONMENT);
    }

    const repoFull = `${this.repository.owner}/${this.repository.name}`;
    const owner = this.repository.owner;
    const name = this.repository.name;
    const revision = parsed.revision;
    const baseBranch = this.baseBranch;
    const workflowRef = `${repoFull}/${WORKFLOW_PATH}@refs/heads/${baseBranch}`;

    const tracker = new DeadlineTracker(this.timeoutMs);

    // One clock reading used for every expiry comparison; it must be a finite
    // valid epoch, otherwise expiry checks are meaningless.
    const nowMs = this.clock.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      return portError("invalid", ERR_CONFIG);
    }

    // Auth is fetched once, inside the whole-resolve deadline; the value is
    // scoped to this resolve and never stored or returned. A synchronous
    // throw or an async rejection is a static typed auth error, never an
    // escaped rejection of resolve.
    const authPromise: Promise<PortResultV1<string>> = Promise.resolve()
      .then(() => this.auth.authorizationHeader())
      .catch(() => portError("auth_failed", ERR_AUTH) as PortResultV1<string>);
    const authResult = await guardUntil(authPromise, tracker.remainingMs());
    if (authResult === DEADLINE) return portError("unavailable", ERR_TIMEOUT);
    if (!authResult.ok || authResult.value.length === 0) {
      return portError("auth_failed", ERR_AUTH);
    }
    const authorization = authResult.value;

    const api = new GithubApi(this.fetchImpl, tracker, authorization);
    try {
      // --- Step 1: exact merged PR binding -------------------------------
      const prResult = await api.getJson(
        `/repos/${owner}/${name}/pulls/${parsed.source.pullRequest}`,
      );
      if (!prResult.ok) return prResult;
      const prIdentity = validatePrPayload(prResult.value, {
        pullRequest: parsed.source.pullRequest,
        revision,
        head: parsed.source.head,
        baseBranch,
        repoFull,
      });
      if (prIdentity === null) return portError("invalid", ERR_PR);
      const repoId = prIdentity.repoId;

      // --- Step 2: pinned workflow blob at the request revision ----------
      const contentsResult = await api.getJson(
        `/repos/${owner}/${name}/contents/${WORKFLOW_PATH}`,
        { ref: revision },
      );
      if (!contentsResult.ok) return contentsResult;
      let contentsData: { type: string; path: string; sha: string };
      try {
        const contents = asRecord(contentsResult.value);
        const type = asString(field(contents, "type"));
        const path = asString(field(contents, "path"));
        const sha = asString(field(contents, "sha"));
        contentsData = { type, path, sha };
      } catch {
        return portError("invalid", ERR_PAYLOAD);
      }
      if (
        contentsData.type !== "file" || contentsData.path !== WORKFLOW_PATH ||
        contentsData.sha !== this.workflowBlobSha
      ) {
        return portError("invalid", ERR_PAYLOAD);
      }

      // --- Step 3: workflow id and exactly one terminal push run ---------
      const workflowResult = await api.getJson(
        `/repos/${owner}/${name}/actions/workflows/${WORKFLOW_FILENAME}`,
      );
      if (!workflowResult.ok) return workflowResult;
      let workflowId: number;
      try {
        workflowId = validateWorkflowPayload(workflowResult.value, {
          workflowId: null,
        });
      } catch {
        return portError("invalid", ERR_WORKFLOW);
      }

      const runsPages = await paginate(
        api,
        `/repos/${owner}/${name}/actions/workflows/${workflowId}/runs`,
        { head_sha: revision, event: "push", branch: baseBranch },
        "workflow_runs",
        ERR_RUNS_PAGINATION,
      );
      if (!runsPages.ok) return runsPages;
      const runs: { id: number; attempt: number; terminal: boolean }[] = [];
      const seenRunIds = new Set<number>();
      for (const item of runsPages.value.items) {
        let validated: { id: number; attempt: number; terminal: boolean };
        try {
          validated = validateRunListItem(item, {
            revision,
            baseBranch,
            repoFull,
            workflowId,
            repoId,
          });
        } catch {
          return portError("invalid", ERR_RUNS);
        }
        if (seenRunIds.has(validated.id)) return portError("invalid", ERR_RUNS);
        seenRunIds.add(validated.id);
        runs.push(validated);
      }
      const runSelection = ((): RunSelection => {
        if (runs.length === 0) return { status: "absent" };
        if (runs.length > 1) return { status: "ambiguous" };
        const only = runs[0];
        if (!only.terminal) return { status: "absent" };
        return {
          status: "run",
          run: { id: only.id, attempt: only.attempt },
        };
      })();
      if (runSelection.status === "absent") {
        return portOk<BuildReceiptLookupV1>({ status: "absent" });
      }
      if (runSelection.status === "ambiguous") {
        return portOk<BuildReceiptLookupV1>({
          status: "ambiguous",
          detail: "multiple matching workflow runs",
        });
      }
      const run = runSelection.run;
      const runId = run.id;
      const attempt = run.attempt;

      // --- Step 4: exact attempt + receipt artifact -----------------------
      const attemptResult = await api.getJson(
        `/repos/${owner}/${name}/actions/runs/${runId}/attempts/${attempt}`,
      );
      if (!attemptResult.ok) return attemptResult;
      let conclusion: "success" | "failure";
      try {
        conclusion = validateAttemptPayload(attemptResult.value, {
          runId,
          attempt,
          revision,
          baseBranch,
          repoFull,
          workflowId,
          repoId,
        });
      } catch {
        return portError("invalid", ERR_ATTEMPT);
      }

      const artifactsPages = await paginate(
        api,
        `/repos/${owner}/${name}/actions/runs/${runId}/artifacts`,
        {},
        "artifacts",
        ERR_ARTIFACTS_PAGINATION,
      );
      if (!artifactsPages.ok) return artifactsPages;
      if (tracker.isExhausted()) return portError("unavailable", ERR_TIMEOUT);
      const targetName = `${RECEIPT_ARTIFACT_PREFIX}${runId}-${attempt}`;
      // Structural identity for every listing entry: unrelated artifact types
      // may legitimately be larger than the receipt cap, expired or digest-
      // free; only exact target-name count and duplicate ids are decided
      // before any receipt-specific check.
      const seenArtifactIds = new Set<number>();
      let nameMatchCount = 0;
      let selectedIndex = -1;
      for (const [index, item] of artifactsPages.value.items.entries()) {
        let validated: { id: number; name: string };
        try {
          validated = validateArtifactIdentity(item);
        } catch {
          return portError("invalid", ERR_ARTIFACTS);
        }
        if (seenArtifactIds.has(validated.id)) {
          return portError("invalid", ERR_ARTIFACTS);
        }
        seenArtifactIds.add(validated.id);
        if (validated.name === targetName) {
          nameMatchCount += 1;
          selectedIndex = index;
        }
      }
      if (nameMatchCount === 0) {
        return portOk<BuildReceiptLookupV1>({ status: "absent" });
      }
      if (nameMatchCount > 1) {
        return portOk<BuildReceiptLookupV1>({
          status: "ambiguous",
          detail: "multiple matching receipt artifacts",
        });
      }
      let artifact: VerifiedArtifact;
      try {
        const selected = validateReceiptArtifact(
          artifactsPages.value.items[selectedIndex],
          {
            runId,
            revision,
            baseBranch,
            repoId,
            nowMs,
          },
        );
        artifact = {
          id: selected.id,
          sizeInBytes: selected.sizeInBytes,
          digestHex: selected.digestHex,
        };
      } catch (error) {
        if (error instanceof ArtifactExpired) {
          return portError("invalid", ERR_ARTIFACT_EXPIRED);
        }
        return portError("invalid", ERR_ARTIFACTS);
      }

      // --- Step 5: authenticated 302 + signed storage download -----------
      const zipResult = await api.get(
        `/repos/${owner}/${name}/actions/artifacts/${artifact.id}/zip`,
        null,
        true,
      );
      if (!zipResult.ok) return zipResult;
      const zipResponse = zipResult.value;
      if (zipResponse.status === 404 || zipResponse.status === 410) {
        api.ctx.cancelBody(zipResponse.body);
        return portOk<BuildReceiptLookupV1>({ status: "absent" });
      }
      if (zipResponse.status !== 302) {
        api.ctx.cancelBody(zipResponse.body);
        return mapHttpStatus(zipResponse.status);
      }
      const location = zipResponse.headers.get("location");
      if (location === null) return portError("invalid", ERR_SIGNED_URL);
      const signedLocation = parseSignedLocation(location);
      if (signedLocation === null) return portError("invalid", ERR_SIGNED_URL);

      const storageResult = await api.downloadSigned(signedLocation);
      if (!storageResult.ok) return storageResult;
      const storageResponse = storageResult.value;
      if (storageResponse.status !== 200) {
        api.ctx.cancelBody(storageResponse.body);
        return portError("unavailable", ERR_STORAGE);
      }
      const archiveBytes = await readBoundedBytes(
        api,
        storageResponse,
        MAX_ARCHIVE_BYTES,
        ERR_ARTIFACT,
      );
      if (!archiveBytes.ok) return archiveBytes;
      if (archiveBytes.value.length !== artifact.sizeInBytes) {
        return portError("invalid", ERR_ARTIFACT_SIZE);
      }
      let actualDigest: string;
      try {
        const guarded = await guardUntil(
          sha256Hex(archiveBytes.value),
          tracker.remainingMs(),
        );
        if (guarded === DEADLINE) return portError("unavailable", ERR_TIMEOUT);
        actualDigest = guarded;
      } catch {
        return portError("invalid", ERR_ARTIFACT);
      }
      if (actualDigest !== artifact.digestHex) {
        return portError("invalid", ERR_ARTIFACT_DIGEST);
      }

      // --- Step 6: bounded archive decode + strict producer schema -------
      if (tracker.isExhausted()) return portError("unavailable", ERR_TIMEOUT);
      const decoded = decodeBuildReceiptArchive(archiveBytes.value);
      if (!decoded.ok) return decoded;
      const receipt = parseProducerReceipt(decoded.value, {
        repoFull,
        runId: String(runId),
        attempt: String(attempt),
        workflowRef,
        revision,
        project: this.project,
        transaction: `github-actions:${repoFull}:${runId}:${attempt}`,
      });
      if (receipt === null) return portError("invalid", ERR_RECEIPT);
      if (tracker.isExhausted()) return portError("unavailable", ERR_TIMEOUT);

      // --- Step 7: latest-run attempt recheck before returning -----------
      const recheckResult = await api.getJson(
        `/repos/${owner}/${name}/actions/runs/${runId}`,
      );
      if (!recheckResult.ok) return recheckResult;
      let recheckMatches: boolean;
      try {
        const current = asRecord(recheckResult.value);
        const repository = repoField(current);
        const headRepository = headRepoField(current);
        const recheckConclusion = asString(field(current, "conclusion"));
        recheckMatches = asPosInt(field(current, "id")) === runId &&
          asPosInt(field(current, "run_attempt")) === attempt &&
          recheckConclusion === conclusion &&
          asString(field(current, "event")) === "push" &&
          asString(field(current, "status")) === "completed" &&
          asString(field(current, "head_sha")) === revision &&
          asString(field(current, "head_branch")) === baseBranch &&
          asPosInt(field(current, "workflow_id")) === workflowId &&
          repository.fullName === repoFull && repository.id === repoId &&
          headRepository.fullName === repoFull &&
          headRepository.id === repoId;
      } catch {
        return portError("invalid", ERR_RUNS);
      }
      if (!recheckMatches) return portError("unavailable", ERR_RERUN);
      if (tracker.isExhausted()) return portError("unavailable", ERR_TIMEOUT);

      return portOk({
        status: "found",
        receipt: {
          buildTransactionId: receipt.buildTransactionId,
          identity: {
            gitSha: revision,
            revisionId: receipt.revisionId,
          },
        },
      });
    } catch {
      if (tracker.isExhausted()) return portError("unavailable", ERR_TIMEOUT);
      return portError("unavailable", ERR_UNEXPECTED);
    } finally {
      api.ctx.dispose();
    }
  }
}
