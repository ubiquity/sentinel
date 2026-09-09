// Test-only helpers for the m01-github suite. The helpers synthesize
// credential-free HTTP/Git/service transport fakes: they record calls and
// return canned values — no product logic lives in the fakes, every check
// asserts on the real adapter methods and the recorded requests.
import type { GitSha } from "../../src/contracts/brands.ts";
import type { GitHubRateLimitV1 } from "../../src/contracts/github-cooldown.ts";
import type {
  Clock,
  GitHubCooldownGateV1,
  PortErrorV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type {
  GitHubAuthProviderV1,
  JwtClaimsV1,
} from "../../src/github/auth.ts";
import type {
  GitExecutorV1,
  GitPushResultV1,
} from "../../src/github/git-executor.ts";
import type {
  HttpRequestV1,
  HttpResponseV1,
  HttpTransportV1,
} from "../../src/github/http.ts";
import { GitHubPortImpl } from "../../src/github/impl.ts";
import type { GitHubPortOptionsV1 } from "../../src/github/impl.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import type {
  HumanResolutionVerifierV1,
  ResolutionEvidenceCheckV1,
  ReviewRequestReadV1,
  ReviewRequestSubmitV1,
  ReviewServiceReadV1,
  ReviewServiceTransportV1,
  ReviewSubmitOutcomeV1,
} from "../../src/github/review-service.ts";

export const REPO: RepositoryIdentityV1 = {
  owner: "ubiquity",
  name: "sentinel",
  installationId: 42,
};
export const REVIEWER = "chatgpt-codex-connector[bot]";
export const PR_AUTHOR = "sentinel[bot]";
export const T0 = 1786000000000;

const SHA_PREFIXES = [
  "aafb7ee0598699bb7fb8a72ea133693ed64462da",
  "6dc35d06e757107b91eb58232bd15e5f671d79b4",
  "4a21c96d46e6f98c3c04125cafce34e255e710e3",
  "e2b6425889b5e013917dae74f99773e86056f185",
  "50bcfb47f60adf1958e9cca921ad2fa33f658229",
];
export function sha(index: number): GitSha {
  return SHA_PREFIXES[index % SHA_PREFIXES.length] as GitSha;
}
export const SHA1 = sha(0);
export const SHA2 = sha(1);
export const SHA3 = sha(2);
export const SHA4 = sha(3);
export const SHA5 = sha(4);

export class FakeClock implements Clock {
  private current: number;
  constructor(start: number = T0) {
    this.current = start;
  }
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

// ---------------------------------------------------------------------------
// Scripted HTTP transport
// ---------------------------------------------------------------------------

export type ScriptEntry =
  | {
    kind: "respond";
    method: string;
    urlPart: string;
    status: number;
    body: string;
    headers?: Record<string, string>;
    /** When true the entry answers every matching request (never consumed). */
    repeat?: boolean;
  }
  | { kind: "throw"; method: string; urlPart: string; repeat?: boolean };

export class ScriptedHttpTransport {
  requests: HttpRequestV1[] = [];
  private readonly used = new Set<number>();

  constructor(private readonly script: ScriptEntry[] = []) {}

  /** Record a request and answer from the script; unexpected requests throw.
   * Entries are matched in script order; one-shot entries answer once, and
   * a URL with no query must end the request path exactly (so `/pulls/1`
   * never answers `/pulls/1/reviews`). */
  fetch(request: HttpRequestV1): Promise<HttpResponseV1> {
    this.requests.push(request);
    const [path, query] = splitQuery(request.url);
    for (let i = 0; i < this.script.length; i++) {
      const entry = this.script[i];
      if (entry.method !== request.method) continue;
      if (!entry.repeat && this.used.has(i)) continue;
      if (!usedMatches(entry, path, query, request.url)) continue;
      if (entry.kind === "throw") {
        if (entry.repeat !== true) this.used.add(i);
        return Promise.reject(new Error("synthetic connection loss"));
      }
      if (!entry.repeat) this.used.add(i);
      return Promise.resolve({
        status: entry.status,
        headers: new Headers(entry.headers ?? {}),
        bodyText: entry.body,
      });
    }
    return Promise.reject(
      new Error(`unexpected request ${request.method} ${request.url}`),
    );
  }

  /** Convenience accessor for assertions on recorded requests. */
  lastRequest(): HttpRequestV1 {
    const last = this.requests[this.requests.length - 1];
    if (last === undefined) throw new Error("no request recorded");
    return last;
  }
}

function splitQuery(url: string): [string, string | null] {
  const at = url.indexOf("?");
  if (at === -1) return [url, null];
  return [url.slice(0, at), url.slice(at + 1)];
}

function usedMatches(
  entry: ScriptEntry,
  path: string,
  _query: string | null,
  fullUrl: string,
): boolean {
  if (entry.urlPart.includes("?")) {
    return fullUrl.includes(entry.urlPart);
  }
  return path.endsWith(entry.urlPart);
}

export function httpRespond(
  method: string,
  urlPart: string,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ScriptEntry {
  return {
    kind: "respond",
    method,
    urlPart,
    status,
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers,
  };
}

export function httpThrow(
  method: string,
  urlPart: string,
): ScriptEntry {
  return { kind: "throw", method, urlPart };
}

// ---------------------------------------------------------------------------
// Fake durable cooldown gate
// ---------------------------------------------------------------------------

/**
 * Test-only cooldown gate: every read is allowed and every observed rate
 * limit is recorded. It is isolated to this suite — the production gate is a
 * required constructor capability and never has a permissive module default.
 */
export class FakeCooldownGate implements GitHubCooldownGateV1 {
  beforeRequests: number[] = [];
  recorded: { installationId: number; rateLimit: GitHubRateLimitV1 }[] = [];
  beforeRequest(installationId: number): Promise<PortResultV1<void>> {
    this.beforeRequests.push(installationId);
    return Promise.resolve(portOk(undefined));
  }
  recordRateLimit(
    installationId: number,
    rateLimit: GitHubRateLimitV1,
  ): Promise<PortResultV1<void>> {
    this.recorded.push({ installationId, rateLimit });
    return Promise.resolve(portOk(undefined));
  }
}

// ---------------------------------------------------------------------------
// Auth provider / signer fakes
// ---------------------------------------------------------------------------

export class FakeAuthProvider implements GitHubAuthProviderV1 {
  calls = 0;
  constructor(
    private readonly header = "Bearer ghs_synthetic_token_0001",
    private readonly failure: PortErrorV1 | null = null,
  ) {}
  authorizationHeader(): Promise<PortResultV1<string>> {
    this.calls++;
    if (this.failure !== null) {
      return Promise.resolve(portError(this.failure.kind, this.failure.detail));
    }
    return Promise.resolve(portOk(this.header));
  }
}

/**
 * Synthetic JWT signer: deterministic, no real key material. Produces a
 * well-formed (unsigned) compact JWT so tests can inspect the claims exactly
 * as the provider minted them.
 */
export class SyntheticJwtSigner {
  calls: JwtClaimsV1[] = [];
  constructor(
    private readonly signature = "synthetic-signature-0000",
    private readonly fail: PortErrorV1 | null = null,
  ) {}
  signJwt(claims: JwtClaimsV1): Promise<PortResultV1<string>> {
    this.calls.push(claims);
    if (this.fail !== null) {
      return Promise.resolve(portError(this.fail.kind, this.fail.detail));
    }
    try {
      const header = base64UrlEncodeJson({ alg: "RS256", typ: "JWT" });
      const payload = base64UrlEncodeJson(claims);
      return Promise.resolve(portOk(`${header}.${payload}.${this.signature}`));
    } catch {
      return Promise.resolve(portError("invalid", "synthetic signer failed"));
    }
  }
}

function base64UrlEncodeJson(value: unknown): string {
  const text = JSON.stringify(value);
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/g,
    "",
  );
}

// ---------------------------------------------------------------------------
// Fake git executor
// ---------------------------------------------------------------------------

export interface PushStep {
  ref: string;
  sha: GitSha;
  expectedRef: GitSha | null;
  result: GitPushResultV1;
}

export class FakeGitExecutor implements GitExecutorV1 {
  /** Current remote identity per ref; absent means the ref does not exist. */
  refs = new Map<string, GitSha | null>();
  remoteReads: { ref: string }[] = [];
  ancestry: { ancestor: GitSha; descendant: GitSha; result: boolean }[] = [];
  pushes: { ref: string; sha: GitSha; expectedRef: GitSha | null }[] = [];
  nextPush: GitPushResultV1 = { status: "applied" };
  /** When true, an ambiguous push still applied at the remote (response lost
   * after the side effect) and the fake advances the ref to the candidate. */
  ambiguousAppliesEffect = false;
  /** When set, isAncestor always returns this value. */
  ancestryEvery: boolean | null = null;

  readRemoteRef(ref: string): Promise<PortResultV1<GitSha | null>> {
    this.remoteReads.push({ ref });
    return Promise.resolve(portOk(this.refs.get(ref) ?? null));
  }
  isAncestor(
    ancestor: GitSha,
    descendant: GitSha,
  ): Promise<PortResultV1<boolean>> {
    const result = this.ancestryEvery ?? true;
    this.ancestry.push({ ancestor, descendant, result });
    return Promise.resolve(portOk(result));
  }
  push(
    ref: string,
    sha: GitSha,
    expectedRef: GitSha | null,
  ): Promise<PortResultV1<GitPushResultV1>> {
    this.pushes.push({ ref, sha, expectedRef });
    const result = this.nextPush;
    if (result.status === "applied") this.refs.set(ref, sha);
    if (result.status === "ambiguous" && this.ambiguousAppliesEffect) {
      this.refs.set(ref, sha);
    }
    return Promise.resolve(portOk(result));
  }
}

// ---------------------------------------------------------------------------
// Fake review service transport
// ---------------------------------------------------------------------------

export class FakeReviewService implements ReviewServiceTransportV1 {
  submits: ReviewRequestSubmitV1[] = [];
  reads: ReviewRequestReadV1[] = [];
  submitResult: ReviewSubmitOutcomeV1 | "error" = {
    status: "submitted",
    requestId: "req-1",
    requestedAt: T0,
  };
  readResult: ReviewServiceReadV1 = defaultServiceReceipt({
    status: "pending",
    requestId: "req-1",
    resultId: null,
    completedAt: null,
    summary: null,
    terminalTurnSucceeded: false,
    outputPresent: false,
  });

  submitReview(
    request: ReviewRequestSubmitV1,
  ): Promise<PortResultV1<ReviewSubmitOutcomeV1>> {
    this.submits.push(request);
    if (this.submitResult === "error") {
      return Promise.resolve(
        portError("unavailable", "review service unavailable"),
      );
    }
    return Promise.resolve(portOk(this.submitResult));
  }
  readReview(
    request: ReviewRequestReadV1,
  ): Promise<PortResultV1<ReviewServiceReadV1>> {
    this.reads.push(request);
    return Promise.resolve(portOk(this.readResult));
  }
}

/**
 * Trusted service receipt defaults: bind every service read to the canonical
 * submission identity used by this suite (operation key `review:work-1`,
 * PR #1, head SHA1, base SHA2, the trusted reviewer, repository REPO) and the
 * canonical GitHub review id 100 (the default `reviewWire()` id).
 */
export function defaultServiceReceipt(
  overrides: Partial<ReviewServiceReadV1> = {},
): ReviewServiceReadV1 {
  return {
    status: "pending",
    requestId: "req-1",
    resultId: null,
    completedAt: null,
    summary: null,
    terminalTurnSucceeded: false,
    outputPresent: false,
    operationKey: "review:work-1",
    githubReviewId: null,
    repository: REPO,
    prNumber: 1,
    expectedHead: SHA1,
    expectedBase: SHA2,
    expectedReviewer: REVIEWER,
    ...overrides,
  };
}

export function completedServiceRead(
  overrides: Partial<ReviewServiceReadV1> = {},
): ReviewServiceReadV1 {
  return defaultServiceReceipt({
    status: "completed",
    requestId: "req-1",
    resultId: "result-9",
    completedAt: T0 + 120_000,
    summary: "completed review output",
    terminalTurnSucceeded: true,
    outputPresent: true,
    githubReviewId: 100,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Fake human-resolution verifier
// ---------------------------------------------------------------------------

export class FakeResolutionVerifier implements HumanResolutionVerifierV1 {
  checks: ResolutionEvidenceCheckV1[] = [];
  constructor(
    private readonly verified = true,
    private readonly identity: string | null = null,
    private readonly failure: PortErrorV1 | null = null,
  ) {}
  verifyResolution(
    check: ResolutionEvidenceCheckV1,
  ): Promise<
    PortResultV1<{ verified: boolean; authorizingIdentity: string | null }>
  > {
    this.checks.push(check);
    if (this.failure !== null) {
      return Promise.resolve(portError(this.failure.kind, this.failure.detail));
    }
    return Promise.resolve(
      portOk({ verified: this.verified, authorizingIdentity: this.identity }),
    );
  }
}

// ---------------------------------------------------------------------------
// Wire fixture builders (synthetic; never real credentials or payloads)
// ---------------------------------------------------------------------------

export function issueWire(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number: 7,
    title: "an issue",
    body: "issue body",
    state: "open",
    user: { login: "octocat" },
    labels: [{ name: "bug" }],
    created_at: "2026-09-07T00:00:00Z",
    updated_at: "2026-09-07T01:00:00Z",
    closed_at: null,
    ...overrides,
  };
}

export function pullWire(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number: 1,
    title: "a pull request",
    body: "pr body",
    state: "open",
    head: { ref: "sentinel/fix-1", sha: SHA1 },
    base: { ref: "development", sha: SHA2 },
    user: { login: PR_AUTHOR },
    created_at: "2026-09-07T00:00:00Z",
    updated_at: "2026-09-07T01:00:00Z",
    merged_at: null,
    merge_commit_sha: null,
    review_decision: "none",
    ...overrides,
  };
}

export function checkRunWire(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "ci",
    status: "completed",
    conclusion: "success",
    head_sha: SHA1,
    started_at: "2026-09-07T00:00:00Z",
    completed_at: "2026-09-07T01:00:00Z",
    ...overrides,
  };
}

export function checksPageWire(runs: unknown[]): Record<string, unknown> {
  return { total_count: runs.length, check_runs: runs };
}

export function statusesPageWire(statuses: unknown[]): Record<string, unknown> {
  return { total_count: statuses.length, statuses };
}

export function commitStatusWire(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    context: "ci",
    state: "success",
    description: "passed",
    target_url: null,
    created_at: "2026-09-07T00:00:00Z",
    updated_at: "2026-09-07T01:00:00Z",
    ...overrides,
  };
}

export function reviewDecisionGraphqlWire(
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null,
): Record<string, unknown> {
  return {
    data: {
      repository: {
        pullRequest: { reviewDecision },
      },
    },
  };
}

export function protectionWire(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    required_status_checks: {
      strict: true,
      contexts: ["ci"],
      checks: [{ context: "ci", app_id: 1 }],
    },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: {
      required_approving_review_count: 0,
      dismiss_stale_reviews: false,
    },
    required_linear_history: true,
    restrictions: { users: [], teams: [], apps: [] },
    ...overrides,
  };
}

export function refWire(
  sha: GitSha,
  ref = "refs/heads/sentinel/fix-1",
): Record<string, unknown> {
  return { ref, object: { type: "commit", sha } };
}

// ---------------------------------------------------------------------------
// Rules / ruleset wire fixtures (shapes per the cached GitHub OpenAPI)
// ---------------------------------------------------------------------------

export const RULESET_ID = 10;

export function statusChecksRuleWire(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "required_status_checks",
    id: 11,
    name: "required status checks",
    parameters: {
      required_status_checks: [{ context: "ci", integration_id: 1 }],
      strict_required_status_checks_policy: true,
      do_not_enforce_on_create: false,
    },
    ruleset_source_type: "Repository",
    ruleset_source: "sentinel-ruleset",
    ruleset_id: RULESET_ID,
    ...overrides,
  };
}

export function pullRequestRuleWire(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "pull_request",
    id: 12,
    name: "pull requests",
    parameters: {
      allowed_merge_methods: ["merge"],
      dismiss_stale_reviews_on_push: true,
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_approving_review_count: 0,
      required_review_thread_resolution: false,
    },
    ruleset_source_type: "Repository",
    ruleset_source: "sentinel-ruleset",
    ruleset_id: RULESET_ID,
    ...overrides,
  };
}

export function nonFastForwardRuleWire(): Record<string, unknown> {
  return {
    type: "non_fast_forward",
    id: 13,
    name: null,
    ruleset_source_type: "Repository",
    ruleset_source: "sentinel-ruleset",
    ruleset_id: RULESET_ID,
  };
}

/** The effective branch rules GET /rules/branches/{branch} would return. */
export function branchRulesWire(
  rules: unknown[],
): unknown {
  return rules;
}

export function rulesetWire(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: RULESET_ID,
    name: "sentinel-ruleset",
    target: "branch",
    source_type: "Repository",
    source: "sentinel-ruleset",
    enforcement: "active",
    bypass_actors: [],
    current_user_can_bypass: "never",
    rules: [],
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-07T00:00:00Z",
    ...overrides,
  };
}

export function reviewWire(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 100,
    user: { login: REVIEWER },
    state: "APPROVED",
    body: "no issues found",
    commit_id: SHA1,
    submitted_at: "2026-09-07T01:00:00Z",
    ...overrides,
  };
}

export function commentWire(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 500,
    pull_request_review_id: 100,
    path: "src/main.ts",
    body: "[P1] broken error handling",
    user: { login: REVIEWER },
    commit_id: SHA1,
    created_at: "2026-09-07T01:00:00Z",
    ...overrides,
  };
}

export function mergeResponseWire(mergeSha: GitSha): Record<string, unknown> {
  return {
    sha: mergeSha,
    merged: true,
    message: "Pull Request successfully merged",
  };
}

export function accessTokenWire(
  token: string,
  expiresAt = "2099-01-01T00:00:00Z",
): Record<string, unknown> {
  return {
    token,
    expires_at: expiresAt,
    permissions: { contents: "write" },
    repository_selection: "selected",
  };
}

export function errorWire(message: string): Record<string, unknown> {
  return { message, documentation_url: "https://docs.github.com/rest" };
}

// ---------------------------------------------------------------------------
// Port assembly
// ---------------------------------------------------------------------------

export interface MakePortOptions {
  script?: ScriptEntry[];
  /** Custom transport override (defaults to the scripted transport). */
  http?: HttpTransportV1;
  auth?: GitHubAuthProviderV1;
  cooldownGate?: GitHubCooldownGateV1;
  git?: GitExecutorV1;
  review?: ReviewServiceTransportV1;
  clock?: Clock;
  trustedPrAuthor?: string;
  trustedReviewer?: string;
  trustedResolutionAuthors?: string[];
  resolutionVerifier?: HumanResolutionVerifierV1;
  apiBaseUrl?: string;
  findingCap?: number;
  perPage?: number;
  maxPages?: number;
  maxItems?: number;
  requestDeadlineMs?: number;
}

export function makePort(
  options: MakePortOptions = {},
): {
  port: GitHubPortImpl;
  client: GitHubApiClient;
  transport: ScriptedHttpTransport;
} {
  const transport = new ScriptedHttpTransport(options.script ?? []);
  const portOptions: GitHubPortOptionsV1 = {
    repository: REPO,
    apiBaseUrl: options.apiBaseUrl ?? "https://api.github.com",
    http: options.http ?? transport.fetch.bind(transport) as HttpTransportV1,
    auth: options.auth ?? new FakeAuthProvider(),
    cooldownGate: options.cooldownGate ?? new FakeCooldownGate(),
    clock: options.clock ?? new FakeClock(T0),
    git: options.git ?? new FakeGitExecutor(),
    reviewService: options.review ?? new FakeReviewService(),
    trustedPrAuthor: options.trustedPrAuthor ?? PR_AUTHOR,
    trustedReviewer: options.trustedReviewer ?? REVIEWER,
    trustedResolutionAuthors: options.trustedResolutionAuthors ?? [],
    resolutionVerifier: options.resolutionVerifier,
    findingCap: options.findingCap,
    perPage: options.perPage,
    maxPages: options.maxPages,
    maxItems: options.maxItems,
    requestDeadlineMs: options.requestDeadlineMs,
  };
  const port = new GitHubPortImpl(portOptions);
  const client = new GitHubApiClient({
    repository: portOptions.repository,
    apiBaseUrl: portOptions.apiBaseUrl ?? "https://api.github.com",
    http: portOptions.http,
    auth: portOptions.auth,
    cooldownGate: portOptions.cooldownGate,
    clock: portOptions.clock,
    perPage: portOptions.perPage,
    maxPages: portOptions.maxPages,
    maxItems: portOptions.maxItems,
    requestDeadlineMs: portOptions.requestDeadlineMs,
  });
  return { port, client, transport };
}
