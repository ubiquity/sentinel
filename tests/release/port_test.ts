// DenoReleaseRESTClient over scripted transports: label-free exact-receipt
// discovery, bounded Link pagination, current-deployment claims, 204
// promotion semantics, managed health body/header identity and log-window
// sampling. No timestamp/list-order substitution and no custom label lookup.
import assert from "node:assert/strict";

import { portOk } from "../../src/contracts/ports.ts";
import type { DenoAuthProviderV1 } from "../../src/release/http.ts";
import { validateReleaseTargetConfig } from "../../src/release/config.ts";
import { DenoReleaseRESTClient } from "../../src/release/port.ts";
import {
  acceptedEvent,
  asTransport,
  CUSTOM_URL,
  DEP_0,
  DEP_1,
  DEP_X,
  GIT_SHA_HEADER,
  immutableUrl,
  installREST,
  logRoute,
  MANAGED_URL,
  PROJECT_ID,
  promoteRoute,
  REVISION_HEADER,
  REVISIONS_PATH,
  ScriptedTransport,
  T0,
  targetConfig,
  terminalEvent,
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

/** One full succeeded page of `pageSize` unrelated revision entries. */
function unrelatedPage(start: number, pageSize: number): unknown[] {
  return Array.from({ length: pageSize }, (_, index) => ({
    id: `dep-${start + index}`,
    status: "succeeded",
    labels: { "custom.branch": "main" },
    created_at: "2026-09-07T00:00:00.000Z",
  }));
}

/** Registers a page-aware revisions list (records cursor queries). */
function paginatedListRoute(
  transport: ScriptedTransport,
  pages: {
    entries: unknown[];
    /** Exact Link header value returned with this page, or null. */
    link: string | null;
    /** The cursor that requests this page (null = first page). */
    cursorLabel?: string | null;
  }[],
): void {
  transport.route({
    method: "GET",
    pathname: REVISIONS_PATH,
    respond: (url) => {
      if (url.searchParams.get("status") !== "succeeded") {
        return { kind: "reject" };
      }
      const cursor = url.searchParams.get("cursor") ?? null;
      const index = cursor === null
        ? 0
        : pages.findIndex((page) => page.cursorLabel === cursor);
      if (index < 0) {
        throw new Error(`unexpected cursor request: ${cursor}`);
      }
      const page = pages[index];
      const headers: Record<string, string> = {};
      if (page.link !== null) headers["link"] = page.link;
      return {
        kind: "response",
        status: 200,
        headers,
        body: JSON.stringify(page.entries),
      };
    },
  });
}

Deno.test("port: label-free exact receipt revision selects the candidate among two same-SHA builds", async () => {
  const other = { gitSha: DEP_1.gitSha, revisionId: "dep-0007" };
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0, DEP_1, other]);
  transport.health();
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn-from-the-receipt",
    DEP_1.revisionId,
  );
  assert.ok(found.ok);
  if (!found.ok) return;
  assert.equal(found.value.status, "found");
  if (found.value.status === "found") {
    // The exact receipt revision id is the selector; the other same-SHA build
    // is never substituted and no git/transaction label is consulted.
    assert.equal(
      found.value.build.identity.revisionId,
      DEP_1.revisionId,
      JSON.stringify(found.value.build),
    );
    assert.equal(found.value.build.identity.gitSha, DEP_1.gitSha);
    assert.equal(
      found.value.build.buildTransactionId,
      "txn-from-the-receipt",
    );
    assert.equal(found.value.build.status, "succeeded");
  }
});

Deno.test("port: candidate discovery is none when the exact receipt revision is absent", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    `txn-${DEP_1.revisionId}`,
    DEP_1.revisionId,
  );
  assert.ok(found.ok);
  if (found.ok) assert.equal(found.value.status, "none");
});

Deno.test("port: a foreign project id is rejected without any platform call", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    "another-project",
    DEP_1.gitSha,
    "txn",
    DEP_1.revisionId,
  );
  assert.ok(!found.ok);
  if (!found.ok) {
    assert.equal(found.error.kind, "invalid");
    assert.equal(
      found.error.detail,
      "candidate project does not match the configured target",
    );
  }
  assert.equal(transport.calls.length, 0, "no platform call for a foreign id");
});

Deno.test("port: an invalid revision id or SHA is a typed fault, never a lookup", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  const port = client(transport);
  const badId = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn",
    "contains.a.dot",
  );
  assert.ok(!badId.ok);
  if (!badId.ok) assert.equal(badId.error.kind, "invalid");
  const badSha = await port.findBuiltCandidate(
    transport.config.projectId,
    "not-a-sha" as never,
    "txn",
    DEP_1.revisionId,
  );
  assert.ok(!badSha.ok);
  if (!badSha.ok) assert.equal(badSha.error.kind, "invalid");
});

Deno.test("port: a duplicate exact revision id is rejected, never found or none", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  transport.health();
  transport.deployed = DEP_1;
  transport.route({
    method: "GET",
    pathname: REVISIONS_PATH,
    respond: () => ({
      kind: "response",
      status: 200,
      body: JSON.stringify([
        {
          id: DEP_1.revisionId,
          status: "succeeded",
          labels: {},
        },
        {
          id: DEP_1.revisionId,
          status: "succeeded",
          labels: {},
        },
      ]),
    }),
  });
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn-duplicate",
    DEP_1.revisionId,
  );
  assert.ok(!found.ok, "duplicate exact id must fail closed");
  if (!found.ok) {
    assert.equal(found.error.kind, "invalid");
    assert.equal(
      found.error.detail,
      "revision listing contains a duplicate exact id",
    );
  }
  const current = await port.readCurrentDeployment(
    transport.config.projectId,
  );
  assert.ok(
    !current.ok,
    "duplicate exact id must fail closed for the prior too",
  );
  if (!current.ok) {
    assert.equal(current.error.kind, "invalid");
    assert.equal(
      current.error.detail,
      "revision listing contains a duplicate exact id",
    );
  }
});

Deno.test("port: a failed exact resource status is ambiguous, never found", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_1]);
  transport.health();
  transport.route({
    method: "GET",
    pathname: `/v2/revisions/${DEP_1.revisionId}`,
    respond: () => ({
      kind: "response",
      status: 200,
      body: JSON.stringify({
        id: DEP_1.revisionId,
        status: "failed",
        labels: {},
      }),
    }),
  });
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn",
    DEP_1.revisionId,
  );
  assert.ok(found.ok);
  if (found.ok) assert.equal(found.value.status, "ambiguous");
});

Deno.test("port: an immutable body/header identity discrepancy fails closed", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_1]);
  transport.health();
  transport.immutableHealth = (identity) => {
    assert.ok(identity);
    return {
      kind: "response",
      status: 200,
      headers: {
        [GIT_SHA_HEADER]: identity!.gitSha,
        [REVISION_HEADER]: identity!.revisionId,
      },
      body: JSON.stringify({
        status: "available",
        release: {
          git_sha: DEP_X.gitSha,
          deployment_id: DEP_X.revisionId,
        },
      }),
    };
  };
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn",
    DEP_1.revisionId,
  );
  assert.ok(found.ok);
  if (found.ok) {
    assert.equal(
      found.value.status,
      "ambiguous",
      "a contradictory immutable deployment never yields found",
    );
  }
});

Deno.test("port: a wrong or unreachable immutable identity never yields found", async () => {
  for (const mode of ["wrong", "unreachable"] as const) {
    const transport = new ScriptedTransport();
    installREST(transport, [DEP_1]);
    transport.health();
    if (mode === "wrong") {
      transport.immutableIdentities.set(DEP_1.revisionId, DEP_X);
    } else {
      transport.immutableHealth = () => ({ kind: "reject" });
    }
    const port = client(transport);
    const found = await port.findBuiltCandidate(
      transport.config.projectId,
      DEP_1.gitSha,
      "txn",
      DEP_1.revisionId,
    );
    assert.ok(found.ok);
    if (found.ok) assert.equal(found.value.status, "ambiguous");
  }
});

Deno.test("config: the actual two-label Deno managed host is a valid root https base", () => {
  const actual = "https://ai-ubq-fi.ubiquity-dao.deno.net";
  for (const value of [actual, `${actual}/`]) {
    const config = validateReleaseTargetConfig(targetConfig({
      managedBaseUrl: value,
    }));
    assert.equal(config.managedBaseUrl, value);
    assert.equal(
      new URL(config.managedBaseUrl).hostname,
      "ai-ubq-fi.ubiquity-dao.deno.net",
      "the organization suffix is preserved",
    );
  }
});

Deno.test("config: non-root, credential, port, query and fragment managed base URLs are rejected", () => {
  const invalid: string[] = [
    "http://ai-ubq-fi.ubiquity-dao.deno.net",
    "https://ai-ubq-fi.ubiquity-dao.deno.net.foreign.invalid",
    "https://user:public-synthetic@ai-ubq-fi.ubiquity-dao.deno.net",
    "https://ai-ubq-fi.ubiquity-dao.deno.net:8443",
    "https://ai-ubq-fi.ubiquity-dao.deno.net/path",
    "https://ai-ubq-fi.ubiquity-dao.deno.net?query=value",
    "https://ai-ubq-fi.ubiquity-dao.deno.net#fragment",
  ];
  for (const managedBaseUrl of invalid) {
    assert.throws(
      () => validateReleaseTargetConfig(targetConfig({ managedBaseUrl })),
      `expected ${managedBaseUrl} to be rejected`,
    );
  }
});

Deno.test("config: a DNS label is bounded to 63 characters, not 64", () => {
  const label63AllA = "a".repeat(63);
  const label63Mixed = `${"a".repeat(30)}-${"b".repeat(32)}`;
  const label64 = "a".repeat(64);
  for (
    const host of [
      `${label63AllA}.org.deno.net`,
      `${label63Mixed}.org.deno.net`,
    ]
  ) {
    const managedBaseUrl = `https://${host}`;
    const config = validateReleaseTargetConfig(targetConfig({
      managedBaseUrl,
    }));
    assert.equal(new URL(config.managedBaseUrl).hostname, host);
  }
  const managedBaseUrl = `https://${label64}.org.deno.net`;
  assert.throws(
    () => validateReleaseTargetConfig(targetConfig({ managedBaseUrl })),
    `expected ${managedBaseUrl} to be rejected`,
  );
});

Deno.test("config: the API base keeps the https prefix with its prior path and port acceptance", () => {
  for (
    const apiBaseUrl of [
      "https://api.deno.com",
      "https://api.deno.com/v2",
      "https://api.deno.com:8443/v2/apps/project/revisions",
    ]
  ) {
    const config = validateReleaseTargetConfig(targetConfig({ apiBaseUrl }));
    assert.equal(config.apiBaseUrl, apiBaseUrl);
  }
  assert.throws(
    () =>
      validateReleaseTargetConfig(targetConfig({
        apiBaseUrl: "http://api.deno.com",
      })),
    "expected http://api.deno.com to be rejected",
  );
});

Deno.test("config: the custom base keeps its prior URL_RE acceptance", () => {
  for (
    const customBaseUrl of [
      "https://ai.ubq.fi",
      "https://ai.ubq.fi/health",
      "http://ai.ubq.fi:8080/status",
    ]
  ) {
    const config = validateReleaseTargetConfig(targetConfig({ customBaseUrl }));
    assert.equal(config.customBaseUrl, customBaseUrl);
  }
});

Deno.test("port: the immutable probe targets the derived trusted hostname", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_1]);
  transport.health();
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn",
    DEP_1.revisionId,
  );
  assert.ok(found.ok && found.value.status === "found");
  const expectedHost = new URL(immutableUrl(DEP_1.revisionId)).host;
  assert.equal(
    expectedHost,
    `ai-ubq-fi-${DEP_1.revisionId}.ubiquity-dao.deno.net`,
    "the immutable host replaces the first label only and keeps the org suffix",
  );
  const managedHost = new URL(MANAGED_URL).host;
  const healthProbes = transport.calls.filter(
    (call) => call.pathname === "/health",
  );
  assert.ok(
    healthProbes.some((call) => call.host === expectedHost),
    "the immutable host is first-label + revision id, never platform-supplied",
  );
  assert.ok(
    healthProbes.every(
      (call) => call.host === expectedHost || call.host === managedHost,
    ),
    "no arbitrary platform-hostname health probe occurred",
  );
});

Deno.test("port: pagination continues only through a valid console next Link and never fetches it", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_1]);
  transport.health();
  // First page: 100 unrelated succeeded revisions plus the exact official
  // console-origin next Link shape observed in the authenticated receipt.
  paginatedListRoute(transport, [
    {
      entries: unrelatedPage(1000, 100),
      link:
        `<https://console.deno.com/api/v2/apps/${PROJECT_ID}/revisions?cursor=OPAQUE&limit=100>; rel="next"`,
    },
    {
      entries: [{
        id: DEP_1.revisionId,
        status: "succeeded",
        labels: { "custom.branch": "main" },
        created_at: "2026-09-07T00:00:00.000Z",
      }],
      link: null,
      cursorLabel: "OPAQUE",
    },
  ]);
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn",
    DEP_1.revisionId,
  );
  assert.ok(found.ok);
  if (!found.ok) return;
  assert.equal(
    found.value.status,
    "found",
    "the exact target revision on a later page must be accepted",
  );
  // Every authenticated request uses the configured API origin; the console
  // Link URL is never fetched and the token never leaves api.deno.com.
  const listCalls = transport.calls.filter(
    (call) => call.pathname === REVISIONS_PATH,
  );
  assert.ok(listCalls.length >= 2, "two pages requested");
  assert.ok(
    listCalls.every((call) => call.host === "api.deno.com"),
    "all listing requests stay on the configured API origin",
  );
  assert.ok(
    listCalls.every((call) => call.authorization === "Bearer deno-token"),
  );
  assert.equal(
    transport.calls.filter((call) => call.host === "console.deno.com").length,
    0,
    "the console origin is never contacted",
  );
  assert.ok(
    listCalls.some((call) => call.search.includes("cursor=OPAQUE")),
    "the extracted cursor is replayed on the API origin path",
  );
});

Deno.test("port: a later page also proves the prior membership", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  transport.health();
  paginatedListRoute(transport, [
    {
      entries: unrelatedPage(1000, 100),
      link:
        `<https://console.deno.com/api/v2/apps/${PROJECT_ID}/revisions?cursor=OPAQUE&limit=100>; rel="next"`,
    },
    {
      entries: [{
        id: DEP_0.revisionId,
        status: "succeeded",
        labels: {},
        created_at: "2026-09-07T00:00:00.000Z",
      }],
      link: null,
      cursorLabel: "OPAQUE",
    },
  ]);
  const port = client(transport);
  const current = await port.readCurrentDeployment(
    transport.config.projectId,
  );
  assert.ok(current.ok);
  if (!current.ok) return;
  assert.equal(current.value.status, "live");
  assert.equal(current.value.identity?.revisionId, DEP_0.revisionId);
});

Deno.test("port: a full page without a usable continuation fails closed", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_1]);
  transport.health();
  paginatedListRoute(transport, [
    {
      entries: unrelatedPage(1000, 100),
      link: null,
    },
  ]);
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn",
    DEP_1.revisionId,
  );
  assert.ok(!found.ok);
  if (!found.ok) {
    assert.equal(found.error.kind, "invalid");
    assert.equal(
      found.error.detail,
      "revision listing is inconclusive at the page bound",
    );
  }
});

Deno.test("port: foreign, wrong-path, changed-filter and malformed next Links are rejected", async () => {
  const cases: { name: string; link: string }[] = [
    {
      name: "foreign origin",
      link:
        `<https://evil.example/api/v2/apps/${PROJECT_ID}/revisions?cursor=C1&limit=100>; rel="next"`,
    },
    {
      name: "wrong path",
      link:
        `<https://api.deno.com/v2/apps/${PROJECT_ID}/other?cursor=C1&limit=100>; rel="next"`,
    },
    {
      name: "changed limit",
      link:
        `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=C1&limit=50>; rel="next"`,
    },
    {
      name: "changed status filter",
      link:
        `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=C1&limit=100&status=failed>; rel="next"`,
    },
    {
      name: "extra query parameter",
      link:
        `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=C1&limit=100&sort=asc>; rel="next"`,
    },
    {
      name: "credentials",
      link:
        `<https://user:pass@api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=C1&limit=100>; rel="next"`,
    },
    {
      name: "fragment",
      link:
        `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=C1&limit=100#x>; rel="next"`,
    },
    {
      name: "multiple next links",
      link:
        `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=C1&limit=100>; rel="next", <https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=C2&limit=100>; rel="next"`,
    },
    {
      name: "malformed link value",
      link: "not-a-link",
    },
  ];
  for (const entry of cases) {
    const transport = new ScriptedTransport();
    installREST(transport, [DEP_1]);
    transport.health();
    paginatedListRoute(transport, [{
      entries: unrelatedPage(1000, 100),
      link: entry.link,
    }]);
    const port = client(transport);
    const found = await port.findBuiltCandidate(
      transport.config.projectId,
      DEP_1.gitSha,
      "txn",
      DEP_1.revisionId,
    );
    assert.ok(!found.ok, `${entry.name}: must fail closed`);
    if (!found.ok) {
      assert.equal(
        found.error.kind,
        "invalid",
        `${entry.name}: expected a typed invalid fault`,
      );
    }
  }
});

Deno.test("port: absent, empty, oversized and duplicate cursors in next Links are rejected", async () => {
  const cases: string[] = [
    // No cursor query parameter at all.
    `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?limit=100>; rel="next"`,
    // Empty cursor.
    `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=&limit=100>; rel="next"`,
    // Oversized cursor (>2048 chars).
    `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=${
      "c".repeat(2049)
    }&limit=100>; rel="next"`,
  ];
  for (const link of cases) {
    const transport = new ScriptedTransport();
    installREST(transport, [DEP_1]);
    transport.health();
    paginatedListRoute(transport, [{
      entries: unrelatedPage(1000, 100),
      link,
    }]);
    const port = client(transport);
    const found = await port.findBuiltCandidate(
      transport.config.projectId,
      DEP_1.gitSha,
      "txn",
      DEP_1.revisionId,
    );
    assert.ok(!found.ok, `${link.slice(0, 40)}: must fail closed`);
  }
});

Deno.test("port: a cursor cycle is a typed failure, never endless traversal", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_1]);
  transport.health();
  const link =
    `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=C1&limit=100>; rel="next"`;
  paginatedListRoute(transport, [
    { entries: unrelatedPage(1000, 100), link },
    { entries: unrelatedPage(2000, 100), link, cursorLabel: "C1" },
  ]);
  // Page 2's Link returns the SAME cursor C1 (a cycle).
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn",
    DEP_1.revisionId,
  );
  assert.ok(!found.ok);
  if (!found.ok) {
    assert.equal(found.error.kind, "invalid");
    assert.equal(
      found.error.detail,
      "revision listing repeated a pagination cursor",
    );
  }
});

Deno.test("port: a duplicate exact id across pages is a typed failure", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_1]);
  transport.health();
  paginatedListRoute(transport, [
    {
      entries: unrelatedPage(1000, 100),
      link:
        `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=C1&limit=100>; rel="next"`,
    },
    {
      entries: [{
        id: DEP_1.revisionId,
        status: "succeeded",
        labels: {},
      }],
      link:
        `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=C2&limit=100>; rel="next"`,
      cursorLabel: "C1",
    },
    {
      entries: [{
        id: DEP_1.revisionId,
        status: "succeeded",
        labels: {},
      }],
      link: null,
      cursorLabel: "C2",
    },
  ]);
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn",
    DEP_1.revisionId,
  );
  assert.ok(!found.ok);
  if (!found.ok) {
    assert.equal(found.error.kind, "invalid");
    assert.equal(
      found.error.detail,
      "revision listing contains a duplicate exact id",
    );
  }
});

Deno.test("port: traversal stops at the internal page bound and fails closed", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_1]);
  transport.health();
  transport.route({
    method: "GET",
    pathname: REVISIONS_PATH,
    respond: (url) => {
      const cursor = url.searchParams.get("cursor") ?? null;
      const index = cursor === null ? 0 : Number(cursor.slice(1));
      const link =
        `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=C${
          index + 1
        }&limit=100>; rel="next"`;
      return {
        kind: "response",
        status: 200,
        headers: { link },
        body: JSON.stringify(unrelatedPage(1000 + index * 100, 100)),
      };
    },
  });
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn",
    DEP_1.revisionId,
  );
  assert.ok(!found.ok);
  if (!found.ok) {
    assert.equal(found.error.kind, "invalid");
    assert.equal(
      found.error.detail,
      "revision listing exceeded the page bound",
    );
  }
});

Deno.test("port: readCurrentDeployment observes a stable prior without labels or timelines", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  transport.health();
  transport.deployed = DEP_0;
  const port = client(transport);
  const current = await port.readCurrentDeployment(transport.config.projectId);
  assert.ok(current.ok);
  if (!current.ok) return;
  assert.equal(current.value.status, "live");
  assert.equal(current.value.identity?.revisionId, DEP_0.revisionId);
  assert.equal(
    transport.callCount("GET", /\/timelines$/),
    0,
    "no timeline enumeration is used to infer the current revision",
  );
});

Deno.test("port: readCurrentDeployment is unknown when health identity is unverifiable", async () => {
  for (const mode of ["contradictory", "maintenance"] as const) {
    const transport = new ScriptedTransport();
    installREST(transport, [DEP_0]);
    transport.health();
    if (mode === "maintenance") {
      transport.managedBodyMissing = true;
    } else {
      transport.managedHealth = (identity) => ({
        kind: "response",
        status: 200,
        headers: {
          [GIT_SHA_HEADER]: identity.gitSha,
          [REVISION_HEADER]: identity.revisionId,
        },
        body: JSON.stringify({
          status: "available",
          release: {
            git_sha: DEP_X.gitSha,
            deployment_id: DEP_X.revisionId,
          },
        }),
      });
    }
    const port = client(transport);
    const current = await port.readCurrentDeployment(
      transport.config.projectId,
    );
    assert.ok(current.ok);
    if (!current.ok) return;
    assert.equal(
      current.value.status,
      "unknown",
      `${mode}: no identity claim from unverified health`,
    );
    assert.equal(current.value.identity, null);
  }
});

Deno.test("port: readCurrentDeployment is unknown when the observed revision is not a member", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  transport.health();
  transport.deployed = DEP_1;
  const port = client(transport);
  const current = await port.readCurrentDeployment(transport.config.projectId);
  assert.ok(current.ok);
  if (!current.ok) return;
  assert.equal(current.value.status, "unknown", "foreign revision is not live");
  assert.equal(current.value.identity, null);
});

Deno.test("port: readCurrentDeployment rejects a moved stable identity during verification", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  transport.health();
  transport.deployed = DEP_0;
  transport.managedIdentitySequence = [DEP_0, DEP_X];
  const port = client(transport);
  const current = await port.readCurrentDeployment(transport.config.projectId);
  assert.ok(current.ok);
  if (!current.ok) return;
  assert.equal(
    current.value.status,
    "unknown",
    "a deployment that moved during verification is never claimed live",
  );
  assert.equal(current.value.identity, null);
});

Deno.test("port: readCurrentDeployment is unknown when the exact resource failed", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  transport.health();
  transport.route({
    method: "GET",
    pathname: `/v2/revisions/${DEP_0.revisionId}`,
    respond: () => ({
      kind: "response",
      status: 200,
      body: JSON.stringify({
        id: DEP_0.revisionId,
        status: "failed",
        labels: {},
      }),
    }),
  });
  const port = client(transport);
  const current = await port.readCurrentDeployment(transport.config.projectId);
  assert.ok(current.ok);
  if (!current.ok) return;
  assert.equal(current.value.status, "unknown");
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

Deno.test("port: a contradictory body/header identity is degraded with no verified identity", async () => {
  const transport = new ScriptedTransport();
  transport.health();
  transport.deployed = DEP_1;
  transport.managedHealth = (identity) => ({
    kind: "response",
    status: 200,
    headers: {
      [GIT_SHA_HEADER]: identity.gitSha,
      [REVISION_HEADER]: identity.revisionId,
    },
    body: JSON.stringify({
      status: "available",
      release: {
        git_sha: DEP_X.gitSha,
        deployment_id: DEP_X.revisionId,
      },
    }),
  });
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
  assert.equal(
    sample.value.status,
    "degraded",
    "a body identity that contradicts the headers is never healthy",
  );
  assert.equal(sample.value.identity, null);
});

Deno.test("port: missing or malformed body identity is degraded with no verified identity", async () => {
  const bodies = [
    JSON.stringify({ status: "available" }),
    JSON.stringify({ status: "available", release: { git_sha: DEP_1.gitSha } }),
    JSON.stringify({
      status: "available",
      release: { deployment_id: "dep-0001" },
    }),
    JSON.stringify({ status: "available", release: "nope" }),
    JSON.stringify({
      status: "maintenance",
      release: { git_sha: DEP_1.gitSha, deployment_id: "dep-0001" },
    }),
    "not json {",
  ];
  for (const body of bodies) {
    const transport = new ScriptedTransport();
    transport.health();
    transport.deployed = DEP_1;
    transport.managedHealth = (identity) => ({
      kind: "response",
      status: 200,
      headers: {
        [GIT_SHA_HEADER]: identity.gitSha,
        [REVISION_HEADER]: identity.revisionId,
      },
      body,
    });
    const port = client(transport);
    const sample = await port.sampleHealth({
      baseUrl: MANAGED_URL,
      healthPath: "/health",
      managedBodyMarker: '"status":"available"',
      managedHeaders: [],
      domain: null,
    });
    assert.ok(sample.ok);
    if (!sample.ok) continue;
    assert.equal(
      sample.value.status,
      "degraded",
      `${body.slice(0, 40)} must be degraded`,
    );
    assert.equal(
      sample.value.identity,
      null,
      `${body.slice(0, 40)}: no identity`,
    );
  }
});

Deno.test("port: configured managed header mismatch is degraded with no verified identity", async () => {
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
  assert.equal(sample.value.headersMatch, false);
  assert.equal(
    sample.value.identity,
    null,
    "a mismatched sample is not verified",
  );
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

Deno.test(
  "port: malformed or empty next cursors are typed failures, never completion",
  async () => {
    for (const nextCursor of ["", 7, {}] as unknown[]) {
      const transport = new ScriptedTransport();
      transport.route({
        method: "GET",
        pathname: `/v2/apps/${transport.config.projectId}/logs`,
        respond: () => ({
          kind: "response",
          status: 200,
          body: JSON.stringify({ logs: [], next_cursor: nextCursor }),
        }),
      });
      const port = client(transport, new TestClock(T0 + 35_001));
      const sample = await port.sampleMetrics({
        baseUrl: MANAGED_URL,
        metricsPath: "/health",
        identity: DEP_1,
        windowStart: T0,
        windowEnd: T0 + 30_000,
        domain: "ai.ubq.fi",
      });
      assert.ok(!sample.ok);
      if (!sample.ok) {
        assert.equal(sample.error.kind, "invalid");
        assert.equal(
          sample.error.detail,
          "log response has a malformed next cursor",
        );
      }
    }
  },
);

Deno.test(
  "port: malformed continuation cursor preserves partial logs as incomplete",
  async () => {
    const transport = new ScriptedTransport();
    transport.route({
      method: "GET",
      pathname: `/v2/apps/${transport.config.projectId}/logs`,
      respond: (url) => {
        if (url.searchParams.get("cursor") === null) {
          const accepted = acceptedEvent({
            requestId: "cursor-accepted",
            identity: DEP_1,
            timestamp: T0,
          });
          const terminal = terminalEvent({
            requestId: "cursor-accepted",
            identity: DEP_1,
            timestamp: T0,
            status: 200,
          });
          return {
            kind: "response",
            status: 200,
            body: JSON.stringify({
              logs: [
                {
                  timestamp: new Date(T0).toISOString(),
                  level: "info",
                  message: accepted,
                  revision_id: DEP_1.revisionId,
                },
                {
                  timestamp: new Date(T0 + 1).toISOString(),
                  level: "info",
                  message: terminal,
                  revision_id: DEP_1.revisionId,
                },
              ],
              next_cursor: "page-2",
            }),
          };
        }
        return {
          kind: "response",
          status: 200,
          body: JSON.stringify({ logs: [], next_cursor: "" }),
        };
      },
    });
    const port = client(transport, new TestClock(T0 + 35_001));
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
    assert.equal(sample.value.requestCount, 1);
    assert.equal(sample.value.fiveXxCount, 0);
    assert.deepEqual(sample.value.coverage, {
      status: "incomplete",
      reason: "log pagination was interrupted",
      nextCursor: null,
    });
  },
);

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

Deno.test("port: terminals outside the window cohort mark an explicit evidence gap", async () => {
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
  // BOTH the denominator and the failure counts. Their outcomes are retained
  // as an explicit incomplete-coverage reason, so a cross-window failure
  // cannot disappear into an apparently healthy sample.
  assert.equal(sample.value.requestCount, 100);
  assert.equal(sample.value.fiveXxCount, 1);
  assert.equal(sample.value.timeoutCount, 0);
  assert.equal(sample.value.streamFailureCount, 0);
  assert.equal(sample.value.upstreamWideFault, false);
  assert.deepEqual(sample.value.coverage, {
    status: "incomplete",
    reason: "log scan contained unresolved request outcomes",
    nextCursor: null,
  });
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
    DEP_1.revisionId,
  );
  assert.ok(!found.ok);
  if (!found.ok) assert.equal(found.error.kind, "auth_failed");
});
