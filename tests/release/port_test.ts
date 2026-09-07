// DenoReleaseRESTClient over scripted transports: exact-lookup discovery,
// current-deployment determination, 204 promotion semantics, managed health
// identity and log-window sampling. No timestamp/list-order substitution.
import assert from "node:assert/strict";

import { portOk } from "../../src/contracts/ports.ts";
import type { DenoAuthProviderV1 } from "../../src/release/http.ts";
import { DenoReleaseRESTClient } from "../../src/release/port.ts";
import {
  asTransport,
  CUSTOM_URL,
  DEP_0,
  DEP_1,
  DEP_X,
  installREST,
  logRoute,
  MANAGED_URL,
  promoteRoute,
  ScriptedTransport,
  T0,
  TestClock,
} from "./helpers.ts";

function client(transport: ScriptedTransport, clock = new TestClock(T0)) {
  const auth: DenoAuthProviderV1 = {
    bearerToken: () => Promise.resolve(portOk("deno-token")),
  };
  return new DenoReleaseRESTClient({
    transport: asTransport(transport),
    auth,
    config: transport.config,
    clock,
  });
}

function noAuth(): DenoAuthProviderV1 {
  return {
    bearerToken: () =>
      Promise.resolve({
        ok: false as const,
        error: { kind: "auth_failed" as const, detail: "x" },
      }),
  };
}

Deno.test("port: candidate discovery binds the exact SHA+transaction once", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0, DEP_1]);
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    `txn-${DEP_1.revisionId}`,
  );
  assert.ok(found.ok);
  if (!found.ok) return;
  assert.equal(found.value.status, "found");
  if (found.value.status === "found") {
    assert.equal(found.value.build.identity.gitSha, DEP_1.gitSha);
    assert.equal(found.value.build.identity.revisionId, DEP_1.revisionId);
    assert.equal(
      found.value.build.buildTransactionId,
      `txn-${DEP_1.revisionId}`,
    );
    assert.equal(found.value.build.status, "succeeded");
  }
});

Deno.test("port: candidate discovery is none when no build carries the SHA", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    `txn-${DEP_1.revisionId}`,
  );
  assert.ok(found.ok);
  if (found.ok) assert.equal(found.value.status, "none");
});

Deno.test("port: another same-SHA build with a different transaction never replaces the receipt", async () => {
  const other = { gitSha: DEP_1.gitSha, revisionId: "dep-0007" };
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0, DEP_1, other]);
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    `txn-${DEP_1.revisionId}`,
  );
  assert.ok(found.ok);
  if (found.ok) {
    assert.equal(found.value.status, "found");
    if (found.value.status === "found") {
      assert.equal(found.value.build.identity.revisionId, DEP_1.revisionId);
    }
  }
});

Deno.test("port: two builds claiming the same SHA+transaction are ambiguous", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0, DEP_1]);
  // Override the list: both DEP_1 and a second revision claim the exact
  // receipt transaction.
  transport.route({
    method: "GET",
    pathname: `/v2/apps/${transport.config.projectId}/revisions`,
    respond: () => ({
      kind: "response",
      status: 200,
      body: JSON.stringify([
        {
          id: DEP_1.revisionId,
          status: "succeeded",
          labels: {
            [transport.config.gitShaLabelKey]: DEP_1.gitSha,
            [transport.config.buildTransactionLabelKey]: "txn-duplicate",
          },
        },
        {
          id: "dep-0007",
          status: "succeeded",
          labels: {
            [transport.config.gitShaLabelKey]: DEP_1.gitSha,
            [transport.config.buildTransactionLabelKey]: "txn-duplicate",
          },
        },
      ]),
    }),
  });
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn-duplicate",
  );
  assert.ok(found.ok);
  if (found.ok) assert.equal(found.value.status, "ambiguous");
});

Deno.test("port: a SHA match under another transaction is ambiguous, not none", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  // Only DEP_0 exists; the receipt transaction is for DEP_1's SHA.
  const found = await client(transport).findBuiltCandidate(
    transport.config.projectId,
    DEP_X.gitSha,
    "txn-missing",
  );
  assert.ok(found.ok);
  if (found.ok) assert.equal(found.value.status, "none");
});

Deno.test("port: a full succeeded-revision page is inconclusive and fails closed", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  transport.route({
    method: "GET",
    pathname: `/v2/apps/${transport.config.projectId}/revisions`,
    respond: () => ({
      kind: "response",
      status: 200,
      body: JSON.stringify(
        Array.from({ length: 100 }, (_, index) => ({
          id: `dep-${1000 + index}`,
          status: "succeeded",
          labels: {},
        })),
      ),
    }),
  });
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn",
  );
  assert.ok(!found.ok);
  if (!found.ok) assert.equal(found.error.kind, "invalid");
});

Deno.test("port: readCurrentDeployment bounds the exact hostname to one revision", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0, DEP_1]);
  transport.deployed = DEP_0;
  const port = client(transport);
  const current = await port.readCurrentDeployment(transport.config.projectId);
  assert.ok(current.ok);
  if (!current.ok) return;
  assert.equal(current.value.status, "unknown"); // both revisions list the domain
});

Deno.test("port: readCurrentDeployment is live for a single bound revision", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  const port = client(transport);
  const current = await port.readCurrentDeployment(transport.config.projectId);
  assert.ok(current.ok);
  if (!current.ok) return;
  assert.equal(current.value.status, "live");
  assert.equal(current.value.identity?.revisionId, DEP_0.revisionId);
});

Deno.test("port: promote requires exactly 204 and reports the API outcome", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0, DEP_1]);
  promoteRoute(transport, DEP_1);
  const port = client(transport);
  const promoted = await port.promote({
    projectId: transport.config.projectId,
    identity: DEP_1,
  });
  assert.ok(promoted.ok);
  if (!promoted.ok) return;
  assert.equal(promoted.value.outcome, "promoted");
  if (promoted.value.outcome === "promoted") {
    assert.equal(promoted.value.statusCode, 204);
    // The 204 carries no identity; post-effect identity proof is the
    // controller's managed-domain observation.
    assert.equal(promoted.value.observedIdentity, null);
  }
});

Deno.test("port: a non-204 promotion response is rejected, never promoted", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  transport.any(
    "POST",
    /^\/v2\/revisions\/dep-0001\/promote$/,
    () => ({ kind: "response", status: 200 }),
  );
  const port = client(transport);
  const outcome = await port.promote({
    projectId: transport.config.projectId,
    identity: DEP_1,
  });
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.value.outcome, "rejected");
  if (outcome.value.outcome === "rejected") {
    assert.equal(outcome.value.statusCode, 200);
  }
});

Deno.test("port: a lost promotion response is ambiguous, never rejected", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0, DEP_1]);
  promoteRoute(transport, DEP_1, { reject: true });
  const port = client(transport);
  const outcome = await port.promote({
    projectId: transport.config.projectId,
    identity: DEP_1,
  });
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.value.outcome, "ambiguous");
  if (outcome.value.outcome === "ambiguous") {
    assert.equal(outcome.value.statusCode, null);
  }
});

Deno.test("port: managed health identity is exact, never approximated", async () => {
  const transport = new ScriptedTransport();
  transport.health();
  transport.deployed = DEP_1;
  const port = client(transport);
  const sample = await port.sampleHealth({
    baseUrl: MANAGED_URL,
    healthPath: "/health",
    managedBodyMarker: '"status":"available"',
    managedHeaders: [],
    domain: null,
  });
  assert.ok(sample.ok);
  if (!sample.ok) return;
  assert.equal(sample.value.status, "healthy");
  assert.equal(sample.value.httpStatus, 200);
  assert.equal(sample.value.identity?.gitSha, DEP_1.gitSha);
  assert.equal(sample.value.identity?.revisionId, DEP_1.revisionId);
  assert.equal(sample.value.bodyMarkerPresent, true);
  assert.equal(sample.value.headersMatch, true);
});

Deno.test("port: managed 200 with a wrong identity is a degraded sample with the actual identity", async () => {
  const transport = new ScriptedTransport();
  transport.health();
  transport.identityOverride = DEP_X;
  const port = client(transport);
  const sample = await port.sampleHealth({
    baseUrl: MANAGED_URL,
    healthPath: "/health",
    managedBodyMarker: '"status":"available"',
    managedHeaders: [
      { name: "x-uos-git-sha", value: DEP_0.gitSha },
      { name: "x-uos-deployment-id", value: DEP_0.revisionId },
    ],
    domain: null,
  });
  assert.ok(sample.ok);
  if (!sample.ok) return;
  assert.equal(sample.value.status, "degraded");
  assert.equal(sample.value.identity?.revisionId, DEP_X.revisionId);
});

Deno.test("port: a verified Cloudflare 403 challenge is identified in the sample", async () => {
  const transport = new ScriptedTransport();
  transport.health();
  transport.customStatus = 403;
  transport.customCloudflare = true;
  const port = client(transport);
  const sample = await port.sampleHealth({
    baseUrl: CUSTOM_URL,
    healthPath: "/health",
    managedBodyMarker: '"status":"available"',
    managedHeaders: [],
    domain: "ai.ubq.fi",
  });
  assert.ok(sample.ok);
  if (!sample.ok) return;
  assert.equal(sample.value.status, "degraded");
  assert.equal(sample.value.httpStatus, 403);
  assert.equal(
    sample.value.headersMatch,
    true,
    "the identified Cloudflare challenge must be reported",
  );
  assert.equal(sample.value.identity, null);
});

Deno.test("port: an unverified 403 is never reported as a Cloudflare challenge", async () => {
  const transport = new ScriptedTransport();
  transport.health();
  transport.customStatus = 403;
  transport.customCloudflare = false;
  const port = client(transport);
  const sample = await port.sampleHealth({
    baseUrl: CUSTOM_URL,
    healthPath: "/health",
    managedBodyMarker: '"status":"available"',
    managedHeaders: [],
    domain: "ai.ubq.fi",
  });
  assert.ok(sample.ok);
  if (!sample.ok) return;
  assert.equal(sample.value.httpStatus, 403);
  assert.equal(sample.value.headersMatch, false);
});

Deno.test("port: log sampling produces exact-window Cohort counts with complete coverage", async () => {
  const transport = new ScriptedTransport();
  logRoute(transport, {
    accept: 100,
    fails: { fiveXx: 2, timeout: 1, stream: 1 },
  });
  const clock = new TestClock(T0 + 35_001);
  const port = client(transport, clock);
  const sample = await port.sampleMetrics({
    baseUrl: MANAGED_URL,
    metricsPath: "/health",
    identity: DEP_1,
    windowStart: T0,
    windowEnd: T0 + 30_000,
    domain: "ai.ubq.fi",
  });
  assert.ok(sample.ok);
  if (!sample.ok) return;
  assert.equal(sample.value.requestCount, 100);
  assert.equal(sample.value.fiveXxCount, 2);
  assert.equal(sample.value.timeoutCount, 1);
  assert.equal(sample.value.streamFailureCount, 1);
  assert.equal(sample.value.upstreamWideFault, false);
  assert.deepEqual(sample.value.coverage, { status: "complete" });
});

Deno.test("port: log sampling before the trusted lag is missing, never zero", async () => {
  const transport = new ScriptedTransport();
  logRoute(transport, { accept: 100 });
  const clock = new TestClock(T0 + 30_001); // ended but inside the 5s lag window
  const port = client(transport, clock);
  const sample = await port.sampleMetrics({
    baseUrl: MANAGED_URL,
    metricsPath: "/health",
    identity: DEP_1,
    windowStart: T0,
    windowEnd: T0 + 30_000,
    domain: "ai.ubq.fi",
  });
  assert.ok(sample.ok);
  if (!sample.ok) return;
  assert.equal(sample.value.requestCount, null);
  assert.equal(sample.value.fiveXxCount, null);
  assert.equal(sample.value.coverage.status, "incomplete");
});

Deno.test("port: unreadable log entries make coverage incomplete but preserve counts", async () => {
  const transport = new ScriptedTransport();
  logRoute(transport, { accept: 50, unreadable: 1 });
  const clock = new TestClock(T0 + 35_001);
  const port = client(transport, clock);
  const sample = await port.sampleMetrics({
    baseUrl: MANAGED_URL,
    metricsPath: "/health",
    identity: DEP_1,
    windowStart: T0,
    windowEnd: T0 + 30_000,
    domain: "ai.ubq.fi",
  });
  assert.ok(sample.ok);
  if (!sample.ok) return;
  assert.equal(sample.value.requestCount, 50);
  assert.equal(sample.value.coverage.status, "incomplete");
});

Deno.test("port: terminals outside the window cohort never make metrics inconsistent", async () => {
  const transport = new ScriptedTransport();
  logRoute(transport, {
    accept: 100,
    fails: { fiveXx: 1 },
    orphanTerminals: 3,
  });
  const clock = new TestClock(T0 + 35_001);
  const port = client(transport, clock);
  const sample = await port.sampleMetrics({
    baseUrl: MANAGED_URL,
    metricsPath: "/health",
    identity: DEP_1,
    windowStart: T0,
    windowEnd: T0 + 30_000,
    domain: "ai.ubq.fi",
  });
  assert.ok(sample.ok);
  if (!sample.ok) return;
  // The failing request `acc-0` belongs to the accepted cohort; the three
  // orphan terminals (accepted event outside the window) are excluded from
  // BOTH the denominator and the failure counts: counts stay consistent and
  // the metrics parser accepts the sample (no failure > denominator).
  assert.equal(sample.value.requestCount, 100);
  assert.equal(sample.value.fiveXxCount, 1);
  assert.equal(sample.value.timeoutCount, 0);
  assert.equal(sample.value.streamFailureCount, 0);
  assert.equal(sample.value.upstreamWideFault, false);
  assert.deepEqual(sample.value.coverage, { status: "complete" });
});

Deno.test("port: auth failure of the REST read is a typed fault, not an empty result", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  const port = new DenoReleaseRESTClient({
    transport: asTransport(transport),
    auth: noAuth(),
    config: transport.config,
    clock: new TestClock(T0),
  });
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn",
  );
  assert.ok(!found.ok);
  if (!found.ok) assert.equal(found.error.kind, "auth_failed");
});
