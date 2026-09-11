/**
 * Native GitHub issue dependency gating tests.
 *
 * These drive the REAL `GitHubApiClient` over the synthetic scripted HTTP
 * transport plus fake auth/cooldown capabilities (no network, no timers, no
 * Git, no credentials). They prove that the trusted `includeIssueRelations`
 * opt-in enriches actual REST issue records from the native GraphQL
 * `blockedBy`/sub-issue read, that closed blockers are excluded while open
 * cross-repository blockers are retained, and that every GraphQL error,
 * malformed shape, identity mismatch or truncated page fails closed instead
 * of ever producing an empty success.
 */
import assert from "node:assert/strict";

import { GitHubApiClient } from "../../src/github/client.ts";
import {
  FakeAuthProvider,
  FakeClock,
  FakeCooldownGate,
  httpRespond,
  issueWire,
  pullWire,
  REPO,
  ScriptedHttpTransport,
  type ScriptEntry,
  T0,
} from "./helpers.ts";

const API = "https://api.github.com";

function makeClient(
  script: ScriptEntry[],
  includeIssueRelations?: boolean,
): {
  client: GitHubApiClient;
  transport: ScriptedHttpTransport;
  auth: FakeAuthProvider;
  gate: FakeCooldownGate;
} {
  const transport = new ScriptedHttpTransport(script);
  const auth = new FakeAuthProvider();
  const gate = new FakeCooldownGate();
  const client = new GitHubApiClient({
    repository: REPO,
    apiBaseUrl: API,
    http: transport.fetch.bind(transport),
    auth,
    cooldownGate: gate,
    clock: new FakeClock(T0),
    includeIssueRelations,
  });
  return { client, transport, auth, gate };
}

/** Native relations GraphQL envelope for issue 7 (complete, untruncated). */
function relationsWire(
  issue: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    data: {
      repository: {
        issue: {
          number: 7,
          blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
          subIssues: { totalCount: 0 },
          ...issue,
        },
      },
    },
  };
}

function blocker(
  number: number,
  state: string,
  nameWithOwner = "ubiquity/sentinel",
): Record<string, unknown> {
  return { number, state, repository: { nameWithOwner } };
}

function blockedBy(nodes: unknown[], hasNextPage = false): Record<string, unknown> {
  return { nodes, pageInfo: { hasNextPage } };
}

Deno.test(
  "issue relations: readIssue enriches open, closed and cross-repository blockers and parent metadata",
  async () => {
    const { client, transport, auth, gate } = makeClient([
      httpRespond("GET", "/issues/7", 200, issueWire()),
      httpRespond(
        "POST",
        "/graphql",
        200,
        relationsWire({
          blockedBy: blockedBy([
            blocker(101, "OPEN"),
            blocker(102, "CLOSED"),
            blocker(55, "OPEN", "other-org/other-repo"),
            blocker(101, "OPEN"),
          ]),
          subIssues: { totalCount: 2 },
        }),
      ),
    ], true);

    const result = await client.readIssue(7);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.value?.number, 7);
    assert.equal(result.value?.state, "open");
    // Closed native blockers are authoritative as satisfied and excluded;
    // open blockers are retained even across repositories; duplicates collapse.
    assert.deepEqual(result.value?.relations, {
      openBlockers: [
        { owner: "ubiquity", name: "sentinel", number: 101 },
        { owner: "other-org", name: "other-repo", number: 55 },
      ],
      subIssueCount: 2,
    });

    // Same authenticated transport discipline as every other read: the
    // cooldown gate and auth provider run once for the REST read and once for
    // the GraphQL read, with the exact verified query and variables.
    assert.equal(auth.calls, 2);
    // The gate is checked before and immediately before each of the two
    // requests (REST read + GraphQL read), exactly as every other read path.
    assert.equal(gate.beforeRequests.length, 4);
    assert.ok(
      gate.beforeRequests.every((id) => id === REPO.installationId),
    );
    assert.equal(transport.requests.length, 2);
    const graphql = transport.requests[1];
    assert.equal(graphql.method, "POST");
    assert.equal(graphql.url, `${API}/graphql`);
    const body = JSON.parse(graphql.body ?? "{}");
    assert.deepEqual(body.variables, {
      owner: REPO.owner,
      name: REPO.name,
      number: 7,
    });
    assert.match(String(body.query), /blockedBy\(first: 100\)/);
    assert.match(String(body.query), /subIssues\(first: 1\)/);
    assert.match(String(body.query), /hasNextPage/);
  },
);

Deno.test(
  "issue relations: a closed actual issue keeps its native closed state",
  async () => {
    const { client } = makeClient([
      httpRespond(
        "GET",
        "/issues/9",
        200,
        issueWire({
          number: 9,
          state: "closed",
          closed_at: "2026-09-07T02:00:00Z",
        }),
      ),
      httpRespond("POST", "/graphql", 200, relationsWire({ number: 9 })),
    ], true);

    const result = await client.readIssue(9);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value?.state, "closed");
    // The client reports native state; it never rewrites an open relation into
    // a completed WorkRecord or fabricates a delivery proof.
    assert.deepEqual(result.value?.relations, {
      openBlockers: [],
      subIssueCount: 0,
    });
  },
);

Deno.test(
  "issue relations: listOpenIssues enriches actual issues and skips pull requests",
  async () => {
    const { client, transport } = makeClient([
      httpRespond("GET", "/issues", 200, [
        issueWire({ number: 7 }),
        pullWire({ number: 8, pull_request: {} }),
      ]),
      httpRespond(
        "POST",
        "/graphql",
        200,
        relationsWire({ subIssues: { totalCount: 1 } }),
      ),
    ], true);

    const result = await client.listOpenIssues();
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.value.length, 1);
    assert.equal(result.value[0].number, 7);
    assert.deepEqual(result.value[0].relations, {
      openBlockers: [],
      subIssueCount: 1,
    });
    // A pull request row is never enriched and never becomes an issue.
    assert.equal(
      transport.requests.filter((request) => request.method === "POST").length,
      1,
    );
  },
);

Deno.test(
  "issue relations: absence of the trusted opt-in leaves relations unknown and performs no extra read",
  async () => {
    const { client, transport } = makeClient([
      httpRespond("GET", "/issues/7", 200, issueWire()),
    ]);

    const result = await client.readIssue(7);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    // Unknown, NOT empty: the caller must treat a missing value as a source
    // failure rather than an unblocked issue.
    assert.equal(result.value?.relations, undefined);
    assert.equal(transport.requests.length, 1);
    assert.equal(transport.requests[0].method, "GET");
  },
);

Deno.test(
  "issue relations: GraphQL errors, malformed shapes and truncated pages fail closed",
  async () => {
    const failures: {
      label: string;
      wire: unknown;
      kind: "invalid" | "unavailable";
    }[] = [
      {
        label: "graphql errors present",
        wire: { errors: [{ message: "boom" }], data: null },
        kind: "invalid",
      },
      {
        label: "empty errors array with no data",
        wire: { errors: [], data: null },
        kind: "invalid",
      },
      {
        label: "missing blockedBy",
        wire: {
          data: {
            repository: { issue: { number: 7, subIssues: { totalCount: 0 } } },
          },
        },
        kind: "invalid",
      },
      {
        label: "missing issue",
        wire: { data: { repository: { issue: null } } },
        kind: "invalid",
      },
      {
        label: "wrong issue number",
        wire: relationsWire({ number: 8 }),
        kind: "invalid",
      },
      {
        label: "truncated blockedBy page",
        wire: relationsWire({ blockedBy: blockedBy([], true) }),
        kind: "unavailable",
      },
      {
        label: "invalid blocker state",
        wire: relationsWire({
          blockedBy: blockedBy([blocker(3, "MERGED")]),
        }),
        kind: "invalid",
      },
      {
        label: "invalid blocker identity",
        wire: relationsWire({
          blockedBy: blockedBy([blocker(3, "OPEN", "noslash")]),
        }),
        kind: "invalid",
      },
      {
        label: "invalid sub-issue count",
        wire: relationsWire({ subIssues: { totalCount: -1 } }),
        kind: "invalid",
      },
      {
        label: "missing sub-issue total",
        wire: relationsWire({ subIssues: {} }),
        kind: "invalid",
      },
    ];

    for (const failure of failures) {
      const { client } = makeClient([
        httpRespond("GET", "/issues/7", 200, issueWire()),
        httpRespond("POST", "/graphql", 200, failure.wire),
      ], true);
      const result = await client.readIssue(7);
      assert.equal(result.ok, false, failure.label);
      if (!result.ok) {
        assert.equal(result.error.kind, failure.kind, failure.label);
      }
    }
  },
);

Deno.test(
  "issue relations: HTTP failures map to the same typed errors as every other read",
  async () => {
    const unauthorized = makeClient([
      httpRespond("GET", "/issues/7", 200, issueWire()),
      httpRespond("POST", "/graphql", 401, { message: "bad credentials" }),
    ], true);
    const denied = await unauthorized.client.readIssue(7);
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.kind, "auth_failed");

    const broken = makeClient([
      httpRespond("GET", "/issues/7", 200, issueWire()),
      httpRespond("POST", "/graphql", 500, { message: "server error" }),
    ], true);
    const failed = await broken.client.readIssue(7);
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.error.kind, "unavailable");
  },
);

Deno.test(
  "issue relations: listOpenIssues fails the whole list when one relation read fails",
  async () => {
    const { client, transport } = makeClient([
      httpRespond("GET", "/issues", 200, [
        issueWire({ number: 7 }),
        issueWire({ number: 8 }),
      ]),
      httpRespond("POST", "/graphql", 200, relationsWire()),
      httpRespond(
        "POST",
        "/graphql",
        200,
        { errors: [{ message: "boom" }], data: null },
      ),
    ], true);

    const result = await client.listOpenIssues();
    assert.equal(result.ok, false, JSON.stringify(result));
    if (!result.ok) assert.equal(result.error.kind, "invalid");
    // Both relation reads were attempted (one per actual issue); the partial
    // list is never returned as a success.
    assert.equal(
      transport.requests.filter((request) => request.method === "POST").length,
      2,
    );
  },
);
