/**
 * Wave C trusted release host composition seam tests.
 *
 * The host factory (`src/host/release.ts`) constructs the existing concrete
 * release modules from explicit caller-supplied capabilities and returns the
 * exact `ReleaseEntrypointDepsV1` set. These tests prove:
 *
 * - the capability split is preserved at the type boundary (read-only state
 *   view + release-only writer; no repair/budget/model surface);
 * - construction is side-effect free and produces one concrete
 *   `DenoReleaseRESTClient` bound to the supplied transport/auth/config/clock;
 * - the unavailable build-receipt default is preserved when resolver inputs
 *   are omitted;
 * - an exact `GithubBuildReceiptResolver` (repository/environment/project/
 *   base branch/workflow blob/auth/fetch) is constructed when inputs are
 *   supplied, proven by the immutable fixture receipt resolve;
 * - target/policy/binding faults are rejected BEFORE anything is constructed
 *   (zero capability use), with static TypeError text;
 * - the composed deps drive an unavailable-resolver release entrypoint cycle
 *   against temporary real Git state without promotion;
 * - direct execution of the release entrypoint stays a static fail-closed
 *   fault until a trusted host supplies capability wiring.
 *
 * No network, no model call, no credentials, no GitHub writes or deployment.
 */
import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  PortResultV1,
  ReleaseStateWriter,
  StateReadView,
} from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { ReleaseTargetEnvironmentV1 } from "../../src/contracts/release.ts";
import type { ReleaseTargetConfigV1 } from "../../src/release/config.ts";
import {
  GithubBuildReceiptResolver,
  type GithubBuildReceiptResolverAuthV1,
} from "../../src/release/build-receipt-resolver.ts";
import { DenoReleaseRESTClient } from "../../src/release/port.ts";
import { UnavailableBuildReceiptResolver } from "../../src/release/resolver.ts";
import { runReleaseEntrypoint } from "../../src/release-main.ts";
import type { ReleaseEntrypointDepsV1 } from "../../src/release-main.ts";
import {
  composeReleaseHost,
  type ReleaseHostOptionsV1,
} from "../../src/host/release.ts";
import { makeIntegrationCtx } from "./helpers.ts";
import {
  asTransport,
  DEP_0,
  installREST,
  publishRepairRequest,
  requestFor,
  REVISIONS_PATH,
  ScriptedTransport,
  stabilityPolicy,
  storeAt,
  T0,
  targetConfig,
  TestClock,
} from "../release/helpers.ts";
import { REPO } from "../state/helpers.ts";

// ---------------------------------------------------------------------------
// Recording capabilities (construction must never touch them).
// ---------------------------------------------------------------------------

interface RecordingStateV1 {
  calls: string[];
  read: StateReadView;
  write: ReleaseStateWriter;
}

function recordingState(): RecordingStateV1 {
  const calls: string[] = [];
  return {
    calls,
    read: {
      readRepair: () => {
        calls.push("readRepair");
        return Promise.resolve(portError("unavailable", "synthetic state"));
      },
      readRelease: () => {
        calls.push("readRelease");
        return Promise.resolve(portError("unavailable", "synthetic state"));
      },
    },
    write: {
      writeRelease: () => {
        calls.push("writeRelease");
        return Promise.resolve(portError("unavailable", "synthetic state"));
      },
    },
  };
}

interface RecordingAuthV1 {
  calls: number;
  bearerToken: () => Promise<PortResultV1<string>>;
}

function recordingDenoAuth(): RecordingAuthV1 {
  const auth: RecordingAuthV1 = {
    calls: 0,
    bearerToken: () => Promise.resolve(portOk("synthetic-token")),
  };
  const original = auth.bearerToken;
  auth.bearerToken = () => {
    auth.calls += 1;
    return original();
  };
  return auth;
}

function recordingGithubAuth(): {
  calls: { count: number };
  auth: GithubBuildReceiptResolverAuthV1;
} {
  const calls = { count: 0 };
  const auth: GithubBuildReceiptResolverAuthV1 = {
    authorizationHeader: (): Promise<PortResultV1<string>> => {
      calls.count += 1;
      return Promise.resolve(portOk("Bearer test-token"));
    },
  };
  return { calls, auth };
}

// ---------------------------------------------------------------------------
// Immutable fixture truth for the exact resolver binding proof.
// ---------------------------------------------------------------------------

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../fixtures/release/build-receipt-upload-v1.json",
      import.meta.url,
    ),
  ),
) as {
  producerCommit: string;
  workflowBlobSha: string;
  archiveSize: number;
  archiveDigest: string;
  archiveBase64: string;
  receipt: {
    repository: string;
    run_id: string;
    run_attempt: string;
    workflow_ref: string;
    git_sha: string;
    project: string;
    revision_id: string;
    build_transaction_id: string;
  };
};

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const REVISION = fixture.producerCommit as GitSha;
const WORKFLOW_SHA = fixture.workflowBlobSha as GitSha;
const ARCHIVE_BYTES = decodeBase64(fixture.archiveBase64);
const ARCHIVE_SIZE = fixture.archiveSize;
const ARCHIVE_DIGEST = fixture.archiveDigest;

const REPO_FULL = "ubiquity/ai.ubq.fi";
const REPO_ID = 111;
const WORKFLOW_ID = 9999;
const RUN_ID = 12345;
const ATTEMPT = 2;
const PR_NUMBER = 321;
const HEAD_SHA = "1111111111111111111111111111111111111111" as GitSha;
const BASE_BRANCH = "development";
const STORAGE_URL =
  "https://objects.githubusercontent.com/github-production-release-asset/123/zip?X-Amz-Signature=deadbeef";
const ARTIFACT_ID = 9001;
const TARGET_NAME = `sentinel-build-receipt-${RUN_ID}-${ATTEMPT}`;

const EXPECTED_RECEIPT = {
  status: "found" as const,
  receipt: {
    buildTransactionId: "github-actions:ubiquity/ai.ubq.fi:12345:2",
    identity: { gitSha: REVISION, revisionId: "synthetic-r123" },
  },
};

// ---------------------------------------------------------------------------
// Scripted GitHub transport (actual REST response shapes).
// ---------------------------------------------------------------------------

interface RecordedCallV1 {
  url: URL;
  init: RequestInit;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function scriptedFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): { fetchImpl: typeof globalThis.fetch; calls: RecordedCallV1[] } {
  const calls: RecordedCallV1[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(handler(url, init ?? {}));
  };
  return { fetchImpl: fetchImpl as typeof globalThis.fetch, calls };
}

function prPayload(): Record<string, unknown> {
  return {
    number: PR_NUMBER,
    state: "closed",
    merged: true,
    merge_commit_sha: REVISION,
    head: { sha: HEAD_SHA },
    base: {
      ref: BASE_BRANCH,
      sha: "3333333333333333333333333333333333333333",
      repo: { id: REPO_ID, full_name: REPO_FULL },
    },
  };
}

function runItem(): Record<string, unknown> {
  return {
    id: RUN_ID,
    run_attempt: ATTEMPT,
    event: "push",
    status: "completed",
    conclusion: "success",
    head_sha: REVISION,
    head_branch: BASE_BRANCH,
    workflow_id: WORKFLOW_ID,
    repository: { id: REPO_ID, full_name: REPO_FULL },
    head_repository: { id: REPO_ID, full_name: REPO_FULL },
  };
}

function receiptArtifact(): Record<string, unknown> {
  return {
    id: ARTIFACT_ID,
    name: TARGET_NAME,
    size_in_bytes: ARCHIVE_SIZE,
    digest: ARCHIVE_DIGEST,
    expired: false,
    expires_at: "2099-01-01T00:00:00Z",
    workflow_run: {
      id: RUN_ID,
      repository_id: REPO_ID,
      head_repository_id: REPO_ID,
      head_sha: REVISION,
      head_branch: BASE_BRANCH,
    },
  };
}

function successGithubFetch(
  url: URL,
  _init: RequestInit,
): Response | Promise<Response> {
  const path = url.pathname;
  if (path.endsWith(`/pulls/${PR_NUMBER}`)) return jsonResponse(prPayload());
  if (path.endsWith("/contents/.github/workflows/deno-deploy.yml")) {
    return jsonResponse({
      type: "file",
      path: ".github/workflows/deno-deploy.yml",
      sha: WORKFLOW_SHA,
    });
  }
  if (path.endsWith("/actions/workflows/deno-deploy.yml")) {
    return jsonResponse({
      id: WORKFLOW_ID,
      path: ".github/workflows/deno-deploy.yml",
      name: "deno-deploy",
    });
  }
  if (/\/workflows\/[0-9]+\/runs$/.test(path)) {
    return jsonResponse({ total_count: 1, workflow_runs: [runItem()] });
  }
  if (path.endsWith(`/actions/runs/${RUN_ID}/attempts/${ATTEMPT}`)) {
    return jsonResponse(runItem());
  }
  if (path.endsWith(`/actions/runs/${RUN_ID}/artifacts`)) {
    return jsonResponse({ total_count: 1, artifacts: [receiptArtifact()] });
  }
  if (path.endsWith(`/actions/artifacts/${ARTIFACT_ID}/zip`)) {
    return new Response(null, {
      status: 302,
      headers: { location: STORAGE_URL },
    });
  }
  if (path.endsWith("/github-production-release-asset/123/zip")) {
    return new Response(ARCHIVE_BYTES as BodyInit, { status: 200 });
  }
  if (path.endsWith(`/actions/runs/${RUN_ID}`)) {
    return jsonResponse(runItem());
  }
  assert.fail(`unexpected GitHub fetch: ${url.href}`);
}

// ---------------------------------------------------------------------------
// Options helpers.
// ---------------------------------------------------------------------------

const DENO_AUTH_BEARER = "Bearer synthetic-token";

function baseOptions(overrides: {
  target?: ReleaseTargetConfigV1;
  resolver?: ReleaseHostOptionsV1["resolver"];
} = {}): {
  transport: ScriptedTransport;
  state: RecordingStateV1;
  denoAuth: RecordingAuthV1;
  options: ReleaseHostOptionsV1;
} {
  const config = overrides.target ?? targetConfig();
  const transport = new ScriptedTransport(config);
  const state = recordingState();
  const denoAuth = recordingDenoAuth();
  return {
    transport,
    state,
    denoAuth,
    options: {
      clock: new TestClock(T0),
      stateRead: state.read,
      stateWrite: state.write,
      repository: REPO,
      environment: "production",
      target: config,
      policy: stabilityPolicy(),
      deno: {
        transport: asTransport(transport),
        auth: {
          bearerToken: denoAuth.bearerToken,
        },
      },
      resolver: overrides.resolver,
    },
  };
}

function resolverBinding(overrides: {
  repository?: RepositoryIdentityV1;
  environment?: "production" | "isolated";
  project?: string;
  baseBranch?: string;
  workflowBlobSha?: string;
  auth?: unknown;
  fetch?: unknown;
  timeoutMs?: number;
} = {}): ReleaseHostOptionsV1["resolver"] {
  return {
    repository: overrides.repository ?? REPO,
    environment: overrides.environment ?? "production",
    project: overrides.project ?? "ai-ubq-fi",
    baseBranch: overrides.baseBranch ?? BASE_BRANCH,
    workflowBlobSha: (overrides.workflowBlobSha ?? WORKFLOW_SHA) as GitSha,
    auth: overrides.auth === undefined
      ? recordingGithubAuth().auth
      : overrides.auth as GithubBuildReceiptResolverAuthV1,
    fetch: overrides.fetch as typeof globalThis.fetch | undefined,
    timeoutMs: overrides.timeoutMs,
  };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

Deno.test("host seam preserves the release/read capability split at the type boundary", () => {
  // The composition options never accept repair write capability, budget or
  // model admission; the returned deps keep the release-only writer and the
  // read-only view of the production entrypoint.
  const hostFence = (options: ReleaseHostOptionsV1) => {
    // @ts-expect-error the host seam never accepts repair write capability
    options.stateWrite.writeRepair;
    // @ts-expect-error the read view never carries a writer
    options.stateRead.writeRelease;
    // @ts-expect-error no budget surface on the release seam
    options.budget;
    // @ts-expect-error no work-record surface on the release seam
    options.work;
  };
  const depsFence = (deps: ReleaseEntrypointDepsV1) => {
    // @ts-expect-error release-only writer: no repair write capability
    deps.stateWrite.writeRepair;
    // @ts-expect-error the read view is read-only
    deps.stateRead.writeRelease;
    // @ts-expect-error the release entrypoint never receives model admission
    deps.model;
  };
  assert.equal(typeof hostFence, "function");
  assert.equal(typeof depsFence, "function");
});

Deno.test("factory constructs the concrete Deno client and keeps the unavailable resolver default", async () => {
  const rig = baseOptions();
  const config = rig.options.target;
  installREST(rig.transport, [DEP_0]);
  rig.transport.health();
  const deps = composeReleaseHost(rig.options);

  // Construction touched no state and no credential.
  assert.deepEqual(rig.state.calls, []);
  assert.equal(rig.denoAuth.calls, 0);
  assert.equal(deps.deno instanceof DenoReleaseRESTClient, true);
  assert.equal(deps.clock, rig.options.clock);
  assert.equal(deps.stateRead, rig.state.read);
  assert.equal(deps.stateWrite, rig.state.write);
  assert.deepEqual(deps.repository, REPO);
  assert.equal(deps.environment, "production");
  assert.equal(deps.target.projectId, config.projectId);
  assert.equal(deps.resolver instanceof UnavailableBuildReceiptResolver, true);

  // The concrete client drives the supplied transport with the supplied auth,
  // the supplied clock and the validated config.
  const deployment = await deps.deno.readCurrentDeployment(config.projectId);
  assert.ok(deployment.ok, JSON.stringify(deployment));
  if (deployment.ok) {
    assert.equal(deployment.value.status, "live");
    assert.deepEqual(deployment.value.identity, DEP_0);
  }
  assert.equal(
    rig.denoAuth.calls,
    2,
    "revision list + exact resource share one auth call each",
  );
  assert.ok(
    rig.transport.calls.some((call) => call.authorization === DENO_AUTH_BEARER),
    "the supplied Deno auth reached the REST transport",
  );
  assert.equal(
    rig.transport.calls.some((call) => call.pathname === REVISIONS_PATH),
    true,
    "the client targets the validated config project",
  );

  // Unavailable default: every resolve is a static unavailable fault.
  const resolution = await deps.resolver!.resolve(requestFor());
  assert.ok(!resolution.ok);
  if (!resolution.ok) {
    assert.equal(resolution.error.kind, "unavailable");
    assert.equal(
      resolution.error.detail,
      "build receipt integration is not wired",
    );
  }
  assert.deepEqual(rig.state.calls, [], "the factory never touches state");
});

Deno.test("factory constructs an exact GithubBuildReceiptResolver when inputs are supplied", async () => {
  const config = targetConfig({ projectId: "ai-ubq-fi" });
  const { fetchImpl, calls } = scriptedFetch(successGithubFetch);
  const githubAuth = recordingGithubAuth();
  const rig = baseOptions({
    target: config,
    resolver: {
      repository: REPO,
      environment: "production",
      project: "ai-ubq-fi",
      baseBranch: BASE_BRANCH,
      workflowBlobSha: WORKFLOW_SHA,
      auth: githubAuth.auth,
      fetch: fetchImpl,
      timeoutMs: 2000,
    },
  });
  const deps = composeReleaseHost(rig.options);
  assert.equal(deps.resolver instanceof GithubBuildReceiptResolver, true);

  const request = requestFor("release-request-host", {
    revision: REVISION,
    source: {
      pullRequest: PR_NUMBER,
      reviewRequestId: "rev-1",
      reviewReceiptId: null,
      head: HEAD_SHA,
      base: "2222222222222222222222222222222222222222" as GitSha,
    },
  });
  const result = await deps.resolver!.resolve(request);
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(result.value, EXPECTED_RECEIPT);

  // Every binding was exact enough to pass the immutable fixture receipt:
  // repository/base.branch/workflow blob/project/attempt were each required.
  assert.equal(calls.length, 9);
  assert.equal(githubAuth.calls.count, 1, "exactly one auth call");
  assert.equal(
    new Headers(calls[0]!.init.headers).get("authorization"),
    "Bearer test-token",
    "the supplied GitHub auth reached the resolver",
  );
  assert.equal(
    calls[1]!.url.searchParams.get("ref"),
    REVISION,
    "the workflow blob is pinned at the accepted revision",
  );
  assert.equal(calls[3]!.url.searchParams.get("branch"), BASE_BRANCH);
  assert.equal(
    new Headers(calls[7]!.init.headers).has("authorization"),
    false,
    "the signed download carries no credential",
  );
  assert.deepEqual(rig.state.calls, [], "the factory never touches state");
});

Deno.test("factory rejects target and policy faults before constructing anything", () => {
  {
    const rig = baseOptions({
      target: {
        ...targetConfig(),
        projectId: "",
      } as unknown as ReleaseTargetConfigV1,
    });
    assert.throws(
      () => composeReleaseHost(rig.options),
      /contract validation failed at \$\.projectId/,
    );
    assert.deepEqual(rig.state.calls, []);
    assert.equal(rig.denoAuth.calls, 0);
    assert.equal(rig.transport.calls.length, 0);
  }
  {
    const rig = baseOptions();
    const options = {
      ...rig.options,
      policy: { ...stabilityPolicy(), minSamples: 1 },
    };
    assert.throws(
      () => composeReleaseHost(options),
      (error: unknown) =>
        error instanceof TypeError &&
        error.message === "release host stability policy is rejected: " +
            "release minSamples must be exactly 60",
    );
    assert.deepEqual(rig.state.calls, []);
    assert.equal(rig.denoAuth.calls, 0);
    assert.equal(rig.transport.calls.length, 0);
  }
});

Deno.test("factory rejects resolver binding mismatches with static TypeError text", () => {
  const cases: [string, ReturnType<typeof resolverBinding>, string][] = [
    [
      "repository",
      resolverBinding({
        repository: { owner: "ubiquity", name: "other", installationId: 7 },
      }),
      "release host resolver repository does not match the release target",
    ],
    [
      "environment",
      resolverBinding({ environment: "isolated" }),
      "release host resolver environment does not match the release target",
    ],
    [
      "project",
      resolverBinding({ project: "project-ubq" }),
      "release host resolver project does not match the release target",
    ],
  ];
  for (const [name, resolver, message] of cases) {
    const rig = baseOptions({
      target: targetConfig({ projectId: "ai-ubq-fi" }),
      resolver,
    });
    let fault: string | null = null;
    try {
      composeReleaseHost(rig.options);
    } catch (error) {
      fault = error instanceof Error ? error.message : String(error);
    }
    assert.equal(fault, message, name);
    assert.deepEqual(rig.state.calls, [], `${name}: no state access`);
    assert.equal(rig.denoAuth.calls, 0, `${name}: no credential access`);
    assert.equal(rig.transport.calls.length, 0, `${name}: no transport use`);
  }
});

Deno.test("factory rejects malformed resolver input without echoing values", () => {
  const malformed: [string, ReturnType<typeof resolverBinding>][] = [
    ["bad base branch", resolverBinding({ baseBranch: "main\n" })],
    ["empty project", resolverBinding({ project: "" })],
    ["bad blob sha", resolverBinding({ workflowBlobSha: "not-a-sha" })],
    ["bad timeout", resolverBinding({ timeoutMs: 0 })],
    ["bad fetch", resolverBinding({ fetch: "nope" })],
    ["bad auth", resolverBinding({ auth: {} })],
  ];
  for (const [name, resolver] of malformed) {
    const rig = baseOptions({ resolver });
    let fault: string | null = null;
    try {
      composeReleaseHost(rig.options);
    } catch (error) {
      fault = error instanceof Error ? error.message : String(error);
    }
    assert.equal(fault, "release host resolver input is invalid", name);
    assert.deepEqual(rig.state.calls, [], `${name}: no state access`);
    assert.equal(rig.denoAuth.calls, 0, `${name}: no credential access`);
    assert.equal(rig.transport.calls.length, 0, `${name}: no transport use`);
  }
});

Deno.test("factory rejects a malformed explicit repository before any capability is used", () => {
  // A deliberately binding-mismatched resolver is supplied so the
  // repository fault wins over any resolver work: the explicit repository
  // validation precedes resolver validation AND construction.
  const cases: [string, unknown, string][] = [
    ["not an object", "ubiquity/ai.ubq.fi", "ubiquity/ai.ubq.fi"],
    ["missing installation id", {
      owner: "ubiquity",
      name: "ai.ubq.fi",
    }, "installationId"],
    ["empty owner", { owner: "", name: "ai.ubq.fi", installationId: 7 }, ""],
    ["invalid owner marker", {
      owner: "u biquity",
      name: "ai.ubq.fi",
      installationId: 7,
    }, "u biquity"],
    ["empty name", { owner: "ubiquity", name: "", installationId: 7 }, ""],
    ["zero installation id", {
      owner: "ubiquity",
      name: "ai.ubq.fi",
      installationId: 0,
    }, "0"],
    ["extra key", {
      owner: "ubiquity",
      name: "ai.ubq.fi",
      installationId: 7,
      extra: true,
    }, "extra"],
  ];
  for (const [name, repository, marker] of cases) {
    const rig = baseOptions({
      resolver: resolverBinding({ project: "project-ubq" }),
    });
    const options: ReleaseHostOptionsV1 = {
      ...rig.options,
      repository: repository as unknown as RepositoryIdentityV1,
    };
    let fault: string | null = null;
    try {
      composeReleaseHost(options);
    } catch (error) {
      fault = error instanceof Error ? error.message : String(error);
    }
    assert.equal(
      fault,
      "release host repository identity is invalid",
      name,
    );
    if (marker !== "") {
      assert.equal(
        fault!.includes(marker),
        false,
        `${name}: no supplied value is echoed`,
      );
    }
    assert.deepEqual(rig.state.calls, [], `${name}: no state access`);
    assert.equal(rig.denoAuth.calls, 0, `${name}: no credential access`);
    assert.equal(rig.transport.calls.length, 0, `${name}: no transport use`);
  }
});

Deno.test("factory rejects an invalid runtime environment before any capability is used", () => {
  // The same binding-mismatched resolver proves environment validation also
  // precedes resolver validation and construction.
  const cases: [string, string][] = [
    ["unknown env", "staging"],
    ["trailing space", "production "],
    ["uppercase", "PRODUCTION"],
    ["empty", ""],
  ];
  for (const [name, environment] of cases) {
    const rig = baseOptions({
      resolver: resolverBinding({ project: "project-ubq" }),
    });
    const options: ReleaseHostOptionsV1 = {
      ...rig.options,
      environment: environment as unknown as ReleaseTargetEnvironmentV1,
    };
    let fault: string | null = null;
    try {
      composeReleaseHost(options);
    } catch (error) {
      fault = error instanceof Error ? error.message : String(error);
    }
    assert.equal(fault, "release host environment is invalid", name);
    if (environment !== "") {
      assert.equal(
        fault!.includes(environment),
        false,
        `${name}: no supplied value is echoed`,
      );
    }
    assert.deepEqual(rig.state.calls, [], `${name}: no state access`);
    assert.equal(rig.denoAuth.calls, 0, `${name}: no credential access`);
    assert.equal(rig.transport.calls.length, 0, `${name}: no transport use`);
  }
});

Deno.test("factory returns the parsed repository and the validated environment", () => {
  for (const environment of ["production", "isolated"] as const) {
    const rig = baseOptions({
      target: targetConfig({ projectId: "ai-ubq-fi" }),
      resolver: resolverBinding({ environment }),
    });
    const options: ReleaseHostOptionsV1 = {
      ...rig.options,
      // A structurally equal mutable copy: the deps carry the parsed form.
      repository: { ...REPO },
      environment,
    };
    const deps = composeReleaseHost(options);
    assert.deepEqual(deps.repository, REPO);
    assert.equal(deps.environment, environment);
  }
});

Deno.test("composed deps drive an unavailable-resolver entrypoint cycle without promotion", async () => {
  const ctx = await makeIntegrationCtx("host-cycle");
  try {
    await publishRepairRequest(ctx, requestFor("release-request-host-0001"));
    const config = targetConfig();
    const transport = new ScriptedTransport(config);
    const clock = new TestClock(T0);
    const store = storeAt(ctx, "host-release", "release");
    const deps = composeReleaseHost({
      clock,
      stateRead: store,
      stateWrite: store,
      repository: REPO,
      environment: "production",
      target: config,
      policy: stabilityPolicy(),
      deno: {
        transport: asTransport(transport),
        auth: {
          bearerToken: () => Promise.resolve(portOk("synthetic-token")),
        },
      },
    });
    const result = await runReleaseEntrypoint(deps);
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.value.status, "waiting");
    assert.equal(result.value.detail, "build receipt is unavailable");
    assert.equal(
      transport.calls.length,
      0,
      "no Deno transport call without an available receipt",
    );
    assert.ok(
      transport.calls.every((call) => call.method !== "POST"),
      "no promotion effect was attempted",
    );
    const read = await store.readRelease();
    assert.ok(read.ok);
    const records = read.ok && read.value.status === "found"
      ? read.value.snapshot.releases
      : [];
    assert.equal(records.length, 0, "no release record was created");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("direct release entrypoint execution stays a static fail-closed fault", async () => {
  // The host factory ships no capability wiring: executing src/release-main.ts
  // directly must still terminate with the static fault, and the repository
  // must never present a live activation path.
  const command = new Deno.Command("deno", {
    args: ["run", "--quiet", "src/release-main.ts"],
    cwd: Deno.cwd(),
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  assert.notEqual(result.code, 0);
  const output = new TextDecoder().decode(result.stdout) +
    new TextDecoder().decode(result.stderr);
  assert.ok(
    output.includes("requires injected trusted capabilities"),
    `unexpected direct-execution output: ${output}`,
  );
});
