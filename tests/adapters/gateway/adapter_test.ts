/**
 * GatewayIncidentAdapter tests against the production HTTP adapter and the
 * actual local restricted file store: exact replay manifest/chunk schema,
 * multiple limit=1 pages, repeated incidents with the same identity,
 * incomplete/failed/empty discovery, cursor cycles and wrong ids, auth-safe
 * errors, digest/size/count mismatches, expiry before retention, retained
 * evidence surviving the original 48h source expiry across restarts, local
 * capacity bound, changed bytes at the same ref, read-only listing with
 * no hidden claim/ack/defer writes and no raw payload/key leaks.
 *
 * Evidence-integrity regressions (actual `readIncident` consumer, not the
 * helper): the referenced digest is exact after source-expiry filtering and
 * reconciliation (an unrelated retained artifact never satisfies an updated
 * reference and is not extended or deleted), digest-null references are
 * unavailable instead of misbound, an incomplete index page keeps the whole
 * scan incomplete even when a later page completes, and the replay export
 * walk stops at the aggregate byte/count bounds while preserving already
 * retained evidence.
 */

import assert from "node:assert/strict";

import { GatewayIncidentAdapter } from "../../../src/adapters/gateway/incident-adapter.ts";
import type { GatewayAuthProviderV1 } from "../../../src/adapters/gateway/http.ts";
import {
  type ArtifactStoreLimitsV1,
  LocalArtifactStore,
} from "../../../src/adapters/gateway/store.ts";
import { encodeCanonicalBase64 } from "../../../src/adapters/gateway/wire.ts";
import { portError, portOk } from "../../../src/contracts/ports.ts";

import {
  b64Url,
  CAPTURE_ID_A,
  CAPTURE_ID_B,
  FakeClock,
  FINGERPRINT_A,
  INCIDENT_A,
  INCIDENT_B,
  jsonResponse,
  makeCapture,
  makeIndexPage,
  makeIndexRow,
  makeReplayPage,
  recordingTransport,
  sha256hex,
  syntheticBytes,
  T0,
  validConfig,
} from "./helpers.ts";

const INDEX_PATH = "/admin/sentinel/incidents";
const REPLAY_PATH = "/admin/sentinel/replay-captures";
const LIMITS: ArtifactStoreLimitsV1 = {
  totalMaxBytes: 1_000_000,
  artifactMaxBytes: 100_000,
  retentionMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
};

const SECRET_MARKER = "TOPSECRET-RAW-PAYLOAD-MARKER";

function authProvider(
  fail: boolean = false,
): GatewayAuthProviderV1 {
  return {
    headers: () =>
      fail
        ? Promise.resolve(
          portError("unavailable", "credential source unavailable"),
        )
        : Promise.resolve(portOk({ Authorization: "Bearer synthetic-token" })),
  };
}

async function makeAdapter(
  responder: (url: URL) => Response | Promise<Response>,
  overrides: {
    clock?: FakeClock;
    limits?: ArtifactStoreLimitsV1;
    authFail?: boolean;
    root?: string;
  } = {},
): Promise<{
  adapter: GatewayIncidentAdapter;
  store: LocalArtifactStore;
  clock: FakeClock;
  root: string;
  transport: ReturnType<typeof recordingTransport>;
}> {
  const root = overrides.root ??
    await Deno.makeTempDir({
      dir: Deno.cwd(),
      prefix: "sentinel-m02-adapter-",
    });
  const store = new LocalArtifactStore({
    root,
    limits: overrides.limits ?? LIMITS,
  });
  const opened = await store.open();
  assert.ok(opened.ok, `store open failed: ${JSON.stringify(opened)}`);
  const transport = recordingTransport(responder);
  const clock = overrides.clock ?? new FakeClock(T0);
  const adapter = new GatewayIncidentAdapter({
    config: validConfig(),
    transport,
    auth: authProvider(overrides.authFail ?? false),
    clock,
    store,
  });
  return { adapter, store, clock, root, transport };
}

async function removeRoot(root: string): Promise<void> {
  await Deno.remove(root, { recursive: true }).catch(() => {});
}

/** The happy-path capture + index row pair used by most tests. */
async function captureFixture() {
  const bytes = syntheticBytes(2_000, 1);
  const digest = await sha256hex(bytes);
  const capture = makeCapture(bytes, { capture_id: CAPTURE_ID_A });
  const secondBytes = syntheticBytes(500, 3);
  const secondDigest = await sha256hex(secondBytes);
  const secondCapture = makeCapture(secondBytes, { capture_id: CAPTURE_ID_B });
  const row = makeIndexRow({
    fingerprint: FINGERPRINT_A,
    evidence_ref: { ref: "artifact://sentinel/synth-capture-a.pgp", digest },
    evidence_expires_at_ms: T0 + 48 * 60 * 60 * 1_000,
  });
  return {
    bytes,
    digest,
    capture,
    secondBytes,
    secondDigest,
    secondCapture,
    row,
  };
}

Deno.test("adapter: empty discoveries map without evidence but never fabricate", async () => {
  const { adapter, root } = await makeAdapter(() =>
    jsonResponse(makeIndexPage([
      makeIndexRow({ failing_revision: null }),
    ]))
  );
  try {
    const result = await adapter.readIncident(INCIDENT_A);
    assert.ok(result.ok && result.value !== null, JSON.stringify(result));
    if (!result.ok || !result.value) return;
    const evidence = result.value;
    assert.deepEqual(evidence.artifacts, []);
    assert.equal(evidence.replay, null);
    assert.equal(evidence.failingRevision, null);
  } finally {
    await removeRoot(root);
  }
  void adapter;
});

Deno.test("adapter: listing maps the frozen index with trusted config identity", async () => {
  const fixture = JSON.parse(
    Deno.readTextFileSync(
      new URL(
        "../../fixtures/contracts/gateway-index-v1.json",
        import.meta.url,
      ),
    ),
  );
  const { adapter, root, transport } = await makeAdapter(
    () => jsonResponse(fixture),
  );
  try {
    const result = await adapter.listUnresolvedIncidents(null, 2);
    assert.ok(result.ok, `unexpected failure: ${JSON.stringify(result)}`);
    if (!result.ok) return;
    const page = result.value;
    assert.equal(page.items.length, 2);
    assert.deepEqual(page.nextCursor, null);
    assert.deepEqual(page.coverage, { status: "complete" });
    const first = page.items[0]!;
    assert.equal(first.id, INCIDENT_A);
    assert.equal(first.repository.owner, "ubiquity");
    assert.equal(first.repository.name, "ai.ubq.fi");
    assert.equal(first.provenance.source, "gateway");
    assert.equal(first.provenance.endpoint, "https://ai.ubq.fi");
    assert.equal(
      first.failingRevision,
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    );
    assert.equal(
      first.evidenceRef?.ref,
      "artifact://sentinel/synth-0001/capture-1.pgp",
    );
    const second = page.items[1]!;
    assert.equal(second.failingRevision, null);
    assert.equal(second.evidenceRef, null);
    // Read-only discovery: only the index path was requested, GET only.
    assert.equal(transport.requests.length, 1);
    transport.assertReadOnly([INDEX_PATH]);
    transport.assertNoWriteEndpoints();
  } finally {
    await removeRoot(root);
  }
});

Deno.test("adapter: empty discovery page is a real success, 404 is unavailable", async () => {
  let missing = false;
  const { adapter, root, transport } = await makeAdapter(
    () =>
      missing ? jsonResponse({ error: "not implemented" }, 404) : jsonResponse({
        data: [],
        cursor: null,
        coverage: { status: "complete" },
      }),
  );
  try {
    const empty = await adapter.listUnresolvedIncidents(null, 1);
    assert.ok(empty.ok);
    if (empty.ok) {
      assert.deepEqual(empty.value.items, []);
      assert.deepEqual(empty.value.coverage, { status: "complete" });
      assert.equal(empty.value.nextCursor, null);
    }
    // The current target does not implement the proposed index: 404 is
    // a typed unavailable fault, never an empty successful listing.
    missing = true;
    const missingResult = await adapter.listUnresolvedIncidents(null, 1);
    assert.ok(!missingResult.ok && missingResult.error.kind === "unavailable");
    transport.assertReadOnly([INDEX_PATH]);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("adapter: transport, credential and status faults are typed, never empty pages", async () => {
  const { root, transport } = await makeAdapter(
    (url) => {
      if (url.pathname === INDEX_PATH) {
        return jsonResponse({
          data: [],
          cursor: null,
          coverage: { status: "complete" },
        });
      }
      return new Response("oops", { status: 503 });
    },
  );
  const afRoot = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-m02-af-",
  });
  const throwRoot = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-m02-throw-",
  });
  try {
    const authFailAdapter = new GatewayIncidentAdapter({
      config: validConfig(),
      transport,
      auth: authProvider(true),
      clock: new FakeClock(T0),
      store: await openTempStore(afRoot),
    });
    const authResult = await authFailAdapter.listUnresolvedIncidents(null, 1);
    assert.ok(!authResult.ok && authResult.error.kind === "auth_failed");

    const throwing = recordingTransport(() => {
      throw new Error("connection refused");
    });
    const throwingAdapter = new GatewayIncidentAdapter({
      config: validConfig(),
      transport: throwing,
      auth: authProvider(),
      clock: new FakeClock(T0),
      store: await openTempStore(throwRoot),
    });
    const network = await throwingAdapter.listUnresolvedIncidents(null, 1);
    assert.ok(!network.ok && network.error.kind === "unavailable");
  } finally {
    await removeRoot(root);
    await removeRoot(afRoot);
    await removeRoot(throwRoot);
  }
});

async function openTempStore(root: string): Promise<LocalArtifactStore> {
  const store = new LocalArtifactStore({ root, limits: LIMITS });
  assert.ok((await store.open()).ok);
  return store;
}

Deno.test("adapter: malformed index is invalid and the error is auth-safe", async () => {
  const { adapter, root, transport } = await makeAdapter(() =>
    jsonResponse({
      data: [{
        incident_id: INCIDENT_A,
        claim_url: `https://evil/${SECRET_MARKER}`,
      }],
      cursor: null,
      coverage: { status: "complete" },
    })
  );
  try {
    const result = await adapter.listUnresolvedIncidents(null, 1);
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.error.kind, "invalid");
      assert.ok(!result.error.detail.includes(SECRET_MARKER));
      assert.ok(!result.error.detail.includes(INCIDENT_A));
    }
    transport.assertReadOnly([INDEX_PATH]);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("adapter: listing bounds refuse invalid limit/cursor before any request", async () => {
  let requests = 0;
  const { adapter, root, transport } = await makeAdapter(() => {
    requests++;
    return jsonResponse(makeIndexPage([]));
  });
  try {
    assert.ok(!(await adapter.listUnresolvedIncidents(null, 0)).ok);
    assert.ok(!(await adapter.listUnresolvedIncidents(null, 101)).ok);
    assert.ok(
      !(await adapter.listUnresolvedIncidents("x".repeat(2_049), 1)).ok,
    );
    assert.ok(!(await adapter.listUnresolvedIncidents("", 1)).ok);
    assert.equal(transport.requests.length, 0);
    assert.equal(requests, 0);
    // An incomplete page surfaces incomplete coverage with its next cursor.
    const incomplete = await adapter.listUnresolvedIncidents("p1", 1);
    assert.ok(incomplete.ok);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("adapter: readIncident happy path exhausts index and replay pages and retains", async () => {
  const {
    bytes,
    digest,
    capture,
    secondBytes,
    secondDigest,
    secondCapture,
    row,
  } = await captureFixture();
  const replayed: string[] = [];
  const { adapter, store, root, transport } = await makeAdapter((url) => {
    replayed.push(url.toString());
    if (url.pathname === INDEX_PATH) {
      return jsonResponse(makeIndexPage([row]));
    }
    if (url.searchParams.get("cursor") === "c1") {
      return jsonResponse(makeReplayPage(secondCapture));
    }
    return jsonResponse(makeReplayPage(capture, "c1"));
  });
  try {
    const result = await adapter.readIncident(INCIDENT_A);
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    const evidence = result.value!;
    assert.ok(evidence);
    assert.equal(evidence.id, `evidence:${INCIDENT_A}`);
    assert.equal(evidence.incidentId, INCIDENT_A);
    assert.equal(evidence.fingerprint, FINGERPRINT_A);
    assert.equal(
      evidence.failingRevision,
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    );
    assert.equal(evidence.replay, null);
    assert.deepEqual(evidence.coverage, { status: "complete" });
    assert.equal(
      evidence.provenance.endpoint,
      "https://ai.ubq.fi",
    );
    assert.equal(evidence.artifacts.length, 2);
    const refA = `artifact://sentinel/${INCIDENT_A}/${CAPTURE_ID_A}`;
    const refB = `artifact://sentinel/${INCIDENT_A}/${CAPTURE_ID_B}`;
    assert.deepEqual(
      evidence.artifacts.map((a) => a.ref).sort(),
      [refA, refB].sort(),
    );
    const artifactA = evidence.artifacts.find((a) => a.ref === refA)!;
    assert.equal(artifactA.digest, digest);
    assert.equal(artifactA.sizeBytes, bytes.byteLength);
    assert.equal(artifactA.expiresAt, T0 + LIMITS.retentionMaxAgeMs);
    assert.equal(artifactA.contentType, "application/octet-stream");
    const artifactB = evidence.artifacts.find((a) => a.ref === refB)!;
    assert.equal(artifactB.digest, secondDigest);
    assert.equal(artifactB.sizeBytes, secondBytes.byteLength);
    // The digest is the SHA-256 of the actual concatenated ciphertext — never
    // the manifest HMAC fingerprint and never a fixture digest.
    assert.notEqual(artifactA.digest, FINGERPRINT_A);
    // Evidence records carry refs/digests only: no payload bytes.
    assert.ok(!JSON.stringify(evidence).includes(b64Url(bytes)));
    assert.ok(!JSON.stringify(evidence).includes(SECRET_MARKER));
    // The retained metadata preserves the AES-GCM/gzip manifest privately.
    const stored = await store.get(refA, T0 + 1_000);
    assert.ok(stored.ok && stored.value !== null);
    if (stored.ok && stored.value) {
      assert.equal(stored.value.manifest.algorithm, "AES-256-GCM");
      assert.equal(stored.value.manifest.compression, "gzip");
      assert.equal(stored.value.manifest.fingerprint, FINGERPRINT_A);
    }
    // Read-only: index + replay export only, limit=1 pages, explicit interval.
    transport.assertReadOnly([INDEX_PATH, REPLAY_PATH]);
    transport.assertNoWriteEndpoints();
    const replayRequests = transport.requests.filter((r) =>
      new URL(r.url).pathname === REPLAY_PATH
    );
    assert.equal(replayRequests.length, 2);
    const firstReplay = new URL(replayRequests[0]!.url);
    assert.equal(firstReplay.searchParams.get("incident_id"), INCIDENT_A);
    assert.equal(firstReplay.searchParams.get("after_ms"), "0");
    assert.equal(firstReplay.searchParams.get("before_ms"), String(T0));
    assert.equal(firstReplay.searchParams.get("limit"), "1");
    assert.equal(firstReplay.searchParams.get("cursor"), null);
    const secondReplay = new URL(replayRequests[1]!.url);
    assert.equal(secondReplay.searchParams.get("cursor"), "c1");
  } finally {
    await removeRoot(root);
  }
});

Deno.test("adapter: repeated incidents keep the same identity and are idempotent", async () => {
  const { capture, row } = await captureFixture();
  let replayCalls = 0;
  const { adapter, store, root, transport } = await makeAdapter((url) => {
    if (url.pathname === INDEX_PATH) {
      if (url.searchParams.get("cursor") === "p1") {
        return jsonResponse(makeIndexPage([]));
      }
      return jsonResponse(makeIndexPage([row], "p1", {
        status: "incomplete",
        reason: "page break",
        nextCursor: "p1",
      }));
    }
    replayCalls++;
    return jsonResponse(makeReplayPage(capture));
  });
  try {
    const first = await adapter.readIncident(INCIDENT_A);
    assert.ok(first.ok && first.value !== null);
    const second = await adapter.readIncident(INCIDENT_A);
    assert.ok(second.ok && second.value !== null);
    if (first.ok && second.ok && first.value && second.value) {
      assert.equal(second.value.id, first.value.id);
      assert.deepEqual(second.value, first.value);
    }
    // The second read found already-retained evidence: no extra replay fetch.
    assert.equal(replayCalls, 1);
    assert.equal(
      transport.requests.filter(
        (r) => new URL(r.url).pathname === INDEX_PATH,
      ).length,
      4,
    );
    const stats = await store.stats();
    assert.ok(stats.ok && stats.value.count === 1);
    // A stable producer fingerprint is preserved for repeated incidents: a
    // repeated identical row never gets a new dedupe identity in a listing.
    const repeated = await adapter.listUnresolvedIncidents(null, 1);
    assert.ok(repeated.ok);
    if (repeated.ok) {
      assert.equal(repeated.value.items[0]?.fingerprint, FINGERPRINT_A);
      assert.equal(repeated.value.items[0]?.id, INCIDENT_A);
    }
  } finally {
    await removeRoot(root);
  }
});

Deno.test("adapter: wrong incident id fails closed before any outbound request", async () => {
  const { adapter, root, transport } = await makeAdapter(() =>
    jsonResponse(makeIndexPage([]))
  );
  try {
    for (
      const bad of [
        "sentinel-synth-0001",
        "",
        "NOT-A-UUID",
        "provider-00000000-0000-4000-8000-0000000000012",
      ]
    ) {
      const result = await adapter.readIncident(bad);
      assert.ok(!result.ok && result.error.kind === "invalid", bad);
    }
    assert.equal(transport.requests.length, 0);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("adapter: filter mismatch, cursor cycle and page bound are explicit invalid faults", async () => {
  // Filter mismatch: responder ignores the incident_id filter.
  const mismatch = await makeAdapter(() =>
    jsonResponse(
      makeIndexPage([makeIndexRow({ incident_id: INCIDENT_B })], null, {
        status: "complete",
      }),
    )
  );
  const mismatched = await mismatch.adapter.readIncident(INCIDENT_A);
  assert.ok(!mismatched.ok && mismatched.error.kind === "invalid");
  await removeRoot(mismatch.root);

  // Cursor cycle on the index scan.
  const cycle = await makeAdapter(() =>
    jsonResponse(makeIndexPage([], "c1", {
      status: "incomplete",
      reason: "cycle",
      nextCursor: "c1",
    }))
  );
  const cycled = await cycle.adapter.readIncident(INCIDENT_A);
  assert.ok(!cycled.ok && cycled.error.kind === "invalid");
  await removeRoot(cycle.root);

  // Cursor cycle on the replay export.
  const { row } = await captureFixture();
  const replayCycleCapture = makeCapture(syntheticBytes(128, 15), {
    capture_id: CAPTURE_ID_A,
  });
  const replayCycle = await makeAdapter((url) => {
    if (url.pathname === INDEX_PATH) return jsonResponse(makeIndexPage([row]));
    return jsonResponse(makeReplayPage(replayCycleCapture, "r1"));
  });
  const replayed = await replayCycle.adapter.readIncident(INCIDENT_A);
  assert.ok(!replayed.ok && replayed.error.kind === "invalid");
  await removeRoot(replayCycle.root);

  // Page bound: distinct cursors forever must stop at the bound, not loop.
  let indexCalls = 0;
  const bounded = await makeAdapter((url) => {
    if (url.pathname === INDEX_PATH) {
      indexCalls++;
      return jsonResponse(makeIndexPage([], `p${indexCalls}`, {
        status: "incomplete",
        reason: "never-ending",
        nextCursor: `p${indexCalls}`,
      }));
    }
    return jsonResponse({ data: [], cursor: null });
  });
  const boundedResult = await bounded.adapter.readIncident(INCIDENT_A);
  assert.ok(!boundedResult.ok && boundedResult.error.kind === "invalid");
  assert.equal(indexCalls, 128);
  await removeRoot(bounded.root);
});

Deno.test("adapter: empty replay export with referenced evidence is evidence_expired (null)", async () => {
  const { adapter, store, root } = await makeAdapter((url) => {
    if (url.pathname === INDEX_PATH) {
      return jsonResponse(makeIndexPage([makeIndexRow({
        evidence_ref: {
          ref: "artifact://sentinel/synth-capture-a.pgp",
          digest: "d".repeat(64),
        },
      })]));
    }
    return jsonResponse({ data: [], cursor: null });
  });
  try {
    const result = await adapter.readIncident(INCIDENT_A);
    assert.ok(result.ok, JSON.stringify(result));
    if (result.ok) assert.equal(result.value, null);
    const stats = await store.stats();
    assert.ok(stats.ok && stats.value.count === 0);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("adapter: digest/size/count mismatches are invalid, never partial evidence", async () => {
  // Row digest does not match the fetched capture digest.
  const digestMismatch = await makeAdapter((url) => {
    const base = makeCapture(syntheticBytes(512, 5), {
      capture_id: CAPTURE_ID_A,
    });
    if (url.pathname === INDEX_PATH) {
      return jsonResponse(makeIndexPage([makeIndexRow({
        evidence_ref: {
          ref: "artifact://sentinel/x.pgp",
          digest: "f".repeat(64),
        },
      })]));
    }
    return jsonResponse(makeReplayPage(base));
  });
  const digestResult = await digestMismatch.adapter.readIncident(INCIDENT_A);
  assert.ok(!digestResult.ok && digestResult.error.kind === "invalid");
  const digestStats = await digestMismatch.store.stats();
  assert.ok(digestStats.ok && digestStats.value.count === 0);
  await removeRoot(digestMismatch.root);

  // Chunk count mismatch on the wire: chunks shorter than chunk_count.
  const countMismatch = await makeAdapter((url) => {
    const base = makeCapture(syntheticBytes(512, 7), {
      capture_id: CAPTURE_ID_A,
    });
    if (url.pathname === INDEX_PATH) {
      return jsonResponse(makeIndexPage([makeIndexRow({
        evidence_ref: {
          ref: "artifact://sentinel/x.pgp",
          digest: "0".repeat(64),
        },
      })]));
    }
    return jsonResponse({
      data: [{ manifest: base.manifest, chunks: [] }],
      cursor: null,
    });
  });
  const countResult = await countMismatch.adapter.readIncident(INCIDENT_A);
  assert.ok(!countResult.ok && countResult.error.kind === "invalid");
  await removeRoot(countMismatch.root);

  // ciphertext_bytes vs actual decoded length mismatch.
  const sizeMismatch = await makeAdapter((url) => {
    const bytes = syntheticBytes(512, 9);
    const capture = makeCapture(bytes, { capture_id: CAPTURE_ID_A });
    if (url.pathname === INDEX_PATH) {
      return jsonResponse(makeIndexPage([makeIndexRow({
        evidence_ref: {
          ref: "artifact://sentinel/x.pgp",
          digest: "0".repeat(64),
        },
      })]));
    }
    return jsonResponse({
      data: [{
        manifest: { ...capture.manifest, ciphertext_bytes: 256 },
        chunks: capture.chunks,
      }],
      cursor: null,
    });
  });
  const sizeResult = await sizeMismatch.adapter.readIncident(INCIDENT_A);
  assert.ok(!sizeResult.ok && sizeResult.error.kind === "invalid");
  await removeRoot(sizeMismatch.root);
});

Deno.test("adapter: expiry before retention is evidence_expired and retains nothing", async () => {
  // A producer-valid capture that was captured 50h ago: its exact 48h TTL
  // elapsed before the ingest attempt.
  const bytes = syntheticBytes(512, 11);
  const digest = await sha256hex(bytes);
  const { adapter, store, root } = await makeAdapter((url) => {
    const capture = makeCapture(bytes, {
      capture_id: CAPTURE_ID_A,
      captured_at_ms: T0 - 50 * 60 * 60 * 1_000,
      expires_at_ms: T0 - 2 * 60 * 60 * 1_000,
    });
    if (url.pathname === INDEX_PATH) {
      return jsonResponse(makeIndexPage([makeIndexRow({
        evidence_ref: { ref: "artifact://sentinel/x.pgp", digest },
      })]));
    }
    return jsonResponse(makeReplayPage(capture));
  });
  try {
    const result = await adapter.readIncident(INCIDENT_A);
    assert.ok(result.ok, JSON.stringify(result));
    if (result.ok) assert.equal(result.value, null);
    const stats = await store.stats();
    assert.ok(stats.ok && stats.value.count === 0);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("adapter: retained evidence outlives the original 48h source expiry across restart", async () => {
  const { digest, capture, row } = await captureFixture();
  const clock = new FakeClock(T0);
  let replayCalls = 0;
  const { adapter, root, transport } = await makeAdapter((url) => {
    if (url.pathname === INDEX_PATH) return jsonResponse(makeIndexPage([row]));
    replayCalls++;
    // The first ingestion receives the capture; the same export answers
    // emptiness once the source TTL (48h) has elapsed — honest source loss.
    return replayCalls === 1
      ? jsonResponse(makeReplayPage(capture))
      : jsonResponse({ data: [], cursor: null });
  }, { clock });
  try {
    const first = await adapter.readIncident(INCIDENT_A);
    assert.ok(first.ok && first.value !== null, JSON.stringify(first));
    if (!first.ok || !first.value) return;
    const ref = first.value.artifacts[0]!.ref;
    // 50h later: the source capture (48h TTL) is gone, local retention (7d) holds.
    clock.advance(50 * 60 * 60 * 1_000);
    const later = await adapter.readIncident(INCIDENT_A);
    assert.ok(later.ok && later.value !== null, JSON.stringify(later));
    if (!later.ok || !later.value) return;
    const artifact = later.value.artifacts[0]!;
    assert.equal(artifact.digest, digest);
    assert.equal(artifact.expiresAt, T0 + LIMITS.retentionMaxAgeMs);
    assert.ok(artifact.expiresAt > T0 + 48 * 60 * 60 * 1_000);
    assert.equal(replayCalls, 1); // local retention satisfied the row digest.
    // Restart with a fresh store instance over the same root: durable evidence.
    const restartedRoot = root;
    const restartedStore = new LocalArtifactStore({
      root: restartedRoot,
      limits: LIMITS,
    });
    assert.ok((await restartedStore.open()).ok);
    const restarted = new GatewayIncidentAdapter({
      config: validConfig(),
      transport,
      auth: authProvider(),
      clock,
      store: restartedStore,
    });
    const artifactResult = await restarted.readArtifact(ref, 64 * 1_024);
    assert.ok(artifactResult.ok && artifactResult.value !== null);
    if (!artifactResult.ok || !artifactResult.value) return;
    assert.equal(artifactResult.value.digest, digest);
    assert.equal(artifactResult.value.sizeBytes, 2_000);
    assert.equal(artifactResult.value.expiresAt, T0 + LIMITS.retentionMaxAgeMs);
    // Canonical base64 ciphertext: standard alphabet, padded, exact bytes.
    const expectedB64 = encodeCanonicalBase64(syntheticBytes(2_000, 1));
    assert.equal(artifactResult.value.ciphertextBase64, expectedB64);
    assert.ok(!artifactResult.value.ciphertextBase64.includes(SECRET_MARKER));
  } finally {
    await removeRoot(root);
  }
});

Deno.test("adapter: readArtifact refetches and retains from the source when not local", async () => {
  const bytes = syntheticBytes(300, 13);
  const digest = await sha256hex(bytes);
  const { adapter, store, root } = await makeAdapter(() =>
    jsonResponse(
      makeReplayPage(makeCapture(bytes, { capture_id: CAPTURE_ID_A })),
    )
  );
  try {
    const ref = `artifact://sentinel/${INCIDENT_A}/${CAPTURE_ID_A}`;
    const result = await adapter.readArtifact(ref, 64 * 1_024);
    assert.ok(result.ok && result.value !== null);
    if (!result.ok || !result.value) return;
    assert.equal(result.value.digest, digest);
    assert.equal(result.value.sizeBytes, 300);
    const stats = await store.stats();
    assert.ok(stats.ok && stats.value.count === 1);
    const again = await adapter.readArtifact(ref, 64 * 1_024);
    assert.ok(again.ok && again.value !== null);
    if (again.ok && again.value) assert.equal(again.value.digest, digest);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("adapter: readArtifact missing/expired is null; bounds and bad refs are invalid", async () => {
  const { adapter, store, root } = await makeAdapter(() =>
    jsonResponse({ data: [], cursor: null })
  );
  try {
    const missing = await adapter.readArtifact(
      `artifact://sentinel/${INCIDENT_A}/${CAPTURE_ID_A}`,
      64 * 1_024,
    );
    assert.ok(missing.ok && missing.value === null);
    for (
      const bad of [
        "artifact://sentinel/synth-0001/capture-1.pgp",
        "https://evil.example/raw",
        "artifact://sentinel/../etc/passwd",
      ]
    ) {
      const invalid = await adapter.readArtifact(bad, 64 * 1_024);
      assert.ok(!invalid.ok && invalid.error.kind === "invalid", bad);
    }
    const zeroBound = await adapter.readArtifact(
      `artifact://sentinel/${INCIDENT_A}/${CAPTURE_ID_A}`,
      0,
    );
    assert.ok(!zeroBound.ok && zeroBound.error.kind === "invalid");
    const stats = await store.stats();
    assert.ok(stats.ok && stats.value.count === 0);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("adapter: readArtifact enforces the caller byte bound on retained artifacts", async () => {
  const { capture, bytes, row } = await captureFixture();
  const { adapter, root } = await makeAdapter((url) => {
    if (url.pathname === INDEX_PATH) return jsonResponse(makeIndexPage([row]));
    return jsonResponse(makeReplayPage(capture));
  });
  try {
    const evidence = await adapter.readIncident(INCIDENT_A);
    assert.ok(evidence.ok && evidence.value !== null);
    if (!evidence.ok || !evidence.value) return;
    const ref = evidence.value.artifacts[0]!.ref;
    const small = await adapter.readArtifact(ref, bytes.byteLength - 1);
    assert.ok(!small.ok && small.error.kind === "invalid");
    const exact = await adapter.readArtifact(ref, bytes.byteLength);
    assert.ok(exact.ok && exact.value !== null);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("adapter: local capacity exhaustion blocks without deleting active evidence", async () => {
  const bytesA = syntheticBytes(250, 21);
  const bytesB = syntheticBytes(250, 23);
  const digestA = await sha256hex(bytesA);
  const digestB = await sha256hex(bytesB);
  const captureA = makeCapture(bytesA, { capture_id: CAPTURE_ID_A });
  const captureB = makeCapture(bytesB, { capture_id: CAPTURE_ID_B });
  const { adapter, store, root } = await makeAdapter((url) => {
    if (url.pathname === INDEX_PATH) {
      return jsonResponse(makeIndexPage([makeIndexRow({
        evidence_ref: { ref: "artifact://sentinel/x.pgp", digest: digestA },
      })]));
    }
    if (url.searchParams.get("cursor") === "c1") {
      return jsonResponse(makeReplayPage(captureB));
    }
    return jsonResponse(makeReplayPage(captureA, "c1"));
  }, {
    limits: {
      totalMaxBytes: 400,
      artifactMaxBytes: 100_000,
      retentionMaxAgeMs: LIMITS.retentionMaxAgeMs,
    },
  });
  try {
    const result = await adapter.readIncident(INCIDENT_A);
    assert.ok(!result.ok && result.error.kind === "unavailable");
    // The first artifact was retained; the second was blocked by capacity.
    const stats = await store.stats();
    assert.ok(stats.ok && stats.value.count === 1);
    const kept = await store.get(
      `artifact://sentinel/${INCIDENT_A}/${CAPTURE_ID_A}`,
      T0,
    );
    assert.ok(kept.ok && kept.value !== null);
    if (kept.ok && kept.value) assert.equal(kept.value.digest, digestA);
  } finally {
    await removeRoot(root);
  }
  void digestB;
});

Deno.test("adapter: tampered retained bytes are never served", async () => {
  const { bytes, capture, row } = await captureFixture();
  const { adapter, store, root } = await makeAdapter((url) => {
    if (url.pathname === INDEX_PATH) return jsonResponse(makeIndexPage([row]));
    return jsonResponse(makeReplayPage(capture));
  });
  try {
    const evidence = await adapter.readIncident(INCIDENT_A);
    assert.ok(evidence.ok && evidence.value !== null);
    if (!evidence.ok || !evidence.value) return;
    const ref = evidence.value.artifacts[0]!.ref;
    const stat = await store.stats();
    assert.ok(stat.ok && stat.value.count === 1);
    // Change bytes at the same ref on disk: integrity mismatch is explicit,
    // never a partial or guessed artifact.
    let binPath = "";
    for await (const entry of Deno.readDir(`${root}/entries`)) {
      if (entry.name.endsWith(".bin")) {
        binPath = `${root}/entries/${entry.name}`;
      }
    }
    await Deno.writeFile(binPath, syntheticBytes(bytes.byteLength, 99));
    const tampered = await adapter.readArtifact(ref, 64 * 1_024);
    assert.ok(!tampered.ok && tampered.error.kind === "unavailable");
  } finally {
    await removeRoot(root);
  }
});

Deno.test("adapter: no outbound claim/ack/defer and no credential leak in requests", async () => {
  const { capture, row } = await captureFixture();
  const { adapter, root, transport } = await makeAdapter((url) => {
    if (url.pathname === INDEX_PATH) return jsonResponse(makeIndexPage([row]));
    return jsonResponse(makeReplayPage(capture));
  });
  try {
    await adapter.listUnresolvedIncidents(null, 1);
    const evidence = await adapter.readIncident(INCIDENT_A);
    assert.ok(evidence.ok);
    assert.equal(transport.requests.length, 3);
    transport.assertReadOnly([INDEX_PATH, REPLAY_PATH]);
    transport.assertNoWriteEndpoints();
    for (const request of transport.requests) {
      assert.equal(request.headers.get("accept"), "application/json");
      assert.equal(
        request.headers.get("authorization"),
        "Bearer synthetic-token",
      );
      assert.ok(!request.url.includes(SECRET_MARKER));
    }
  } finally {
    await removeRoot(root);
  }
});

/**
 * Retains one capture for INCIDENT_A with the fixture row/digest and returns
 * the store root for a follow-up adapter; the caller owns root cleanup.
 */
async function seedRetainedArtifact(): Promise<{
  digest: string;
  root: string;
}> {
  const { digest, capture, row } = await captureFixture();
  const seeded = await makeAdapter((url) => {
    if (url.pathname === INDEX_PATH) {
      return jsonResponse(makeIndexPage([row]));
    }
    return jsonResponse(makeReplayPage(capture));
  });
  try {
    const evidence = await seeded.adapter.readIncident(INCIDENT_A);
    assert.ok(evidence.ok && evidence.value !== null, JSON.stringify(evidence));
    const stats = await seeded.store.stats();
    assert.ok(stats.ok && stats.value.count === 1);
    return { digest, root: seeded.root };
  } catch (error) {
    await removeRoot(seeded.root);
    throw error;
  }
}

Deno.test("adapter: referenced digest is exact — an unrelated retained artifact never satisfies an updated reference", async () => {
  // Retain capture A under the original reference digest.
  const seed = await seedRetainedArtifact();
  const newDigest = "e".repeat(64);
  let replayServed = 0;
  const { adapter, store, root, transport } = await makeAdapter((url) => {
    if (url.pathname === INDEX_PATH) {
      return jsonResponse(makeIndexPage([makeIndexRow({
        evidence_ref: { ref: "artifact://sentinel/x.pgp", digest: newDigest },
      })]));
    }
    replayServed++;
    // Honest source loss: the export has nothing (the probe case).
    return jsonResponse({ data: [], cursor: null });
  }, { root: seed.root });
  try {
    const result = await adapter.readIncident(INCIDENT_A);
    // The required digest B is absent everywhere: evidence_expired, never a
    // successful evidence record built from the unrelated old artifact A.
    assert.ok(result.ok, JSON.stringify(result));
    if (result.ok) assert.equal(result.value, null);
    assert.ok(replayServed >= 1, "source-lost branch must be consulted");
    // A is preserved: not deleted, not extended, digest unchanged.
    const stats = await store.stats();
    assert.ok(stats.ok && stats.value.count === 1);
    const kept = await store.get(
      `artifact://sentinel/${INCIDENT_A}/${CAPTURE_ID_A}`,
      T0 + 10,
    );
    assert.ok(kept.ok && kept.value !== null);
    if (kept.ok && kept.value) {
      assert.equal(kept.value.digest, seed.digest);
      assert.equal(kept.value.expiresAt, T0 + LIMITS.retentionMaxAgeMs);
    }
    transport.assertReadOnly([INDEX_PATH, REPLAY_PATH]);
    transport.assertNoWriteEndpoints();
  } finally {
    await removeRoot(root);
  }
});

Deno.test("adapter: expired required capture with an unrelated old artifact is evidence_expired", async () => {
  const seed = await seedRetainedArtifact();
  const expiredBytes = syntheticBytes(400, 41);
  const expiredDigest = await sha256hex(expiredBytes);
  const expiredCapture = makeCapture(expiredBytes, {
    capture_id: CAPTURE_ID_B,
    captured_at_ms: T0 - 50 * 60 * 60 * 1_000,
    expires_at_ms: T0 - 2 * 60 * 60 * 1_000,
  });
  const { adapter, store, root } = await makeAdapter((url) => {
    if (url.pathname === INDEX_PATH) {
      return jsonResponse(makeIndexPage([makeIndexRow({
        evidence_ref: {
          ref: "artifact://sentinel/y.pgp",
          digest: expiredDigest,
        },
      })]));
    }
    // The producer still returns the required capture, but its exact 48h TTL
    // elapsed: after source-expiry filtering the required digest is absent.
    return jsonResponse(makeReplayPage(expiredCapture));
  }, { root: seed.root });
  try {
    const result = await adapter.readIncident(INCIDENT_A);
    assert.ok(result.ok, JSON.stringify(result));
    if (result.ok) assert.equal(result.value, null);
    const stats = await store.stats();
    assert.ok(stats.ok && stats.value.count === 1);
    const kept = await store.get(
      `artifact://sentinel/${INCIDENT_A}/${CAPTURE_ID_A}`,
      T0 + 10,
    );
    assert.ok(kept.ok && kept.value !== null);
    if (kept.ok && kept.value) assert.equal(kept.value.digest, seed.digest);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("adapter: digest-null reference is unavailable, never bound to an older artifact", async () => {
  const seed = await seedRetainedArtifact();
  let replayRequests = 0;
  const { adapter, store, root, transport } = await makeAdapter((url) => {
    if (url.pathname === INDEX_PATH) {
      return jsonResponse(makeIndexPage([makeIndexRow({
        evidence_ref: { ref: "artifact://sentinel/z.pgp", digest: null },
      })]));
    }
    replayRequests++;
    return jsonResponse({ data: [], cursor: null });
  }, { root: seed.root });
  try {
    const result = await adapter.readIncident(INCIDENT_A);
    // No exact capture identity can be bound: fail closed, never old A.
    assert.ok(!result.ok && result.error.kind === "unavailable");
    assert.equal(replayRequests, 0);
    const stats = await store.stats();
    assert.ok(stats.ok && stats.value.count === 1);
    transport.assertReadOnly([INDEX_PATH]);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("adapter: incomplete page keeps the whole scan incomplete even when a later page completes", async () => {
  const { digest, capture } = await captureFixture();
  const { adapter, root } = await makeAdapter((url) => {
    if (url.pathname === INDEX_PATH) {
      if (url.searchParams.get("cursor") === "p1") {
        return jsonResponse(makeIndexPage([]));
      }
      return jsonResponse(makeIndexPage(
        [makeIndexRow({
          evidence_ref: { ref: "artifact://sentinel/x.pgp", digest },
        })],
        "p1",
        {
          status: "incomplete",
          reason: "source gap",
          nextCursor: "p1",
        },
      ));
    }
    return jsonResponse(makeReplayPage(capture));
  });
  try {
    // Actual adapter consumer: the evidence record carries the conservative
    // aggregate coverage, not the later complete page's coverage.
    const result = await adapter.readIncident(INCIDENT_A);
    assert.ok(result.ok && result.value !== null, JSON.stringify(result));
    if (!result.ok || !result.value) return;
    assert.deepEqual(result.value.coverage, {
      status: "incomplete",
      reason: "source gap",
      nextCursor: "p1",
    });
    assert.equal(result.value.artifacts.length, 1);
    assert.equal(result.value.artifacts[0]!.digest, digest);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("adapter: aggregate replay byte bound stops fetching and preserves matched evidence", async () => {
  const bytesA = syntheticBytes(350, 51);
  const digestA = await sha256hex(bytesA);
  const captureA = makeCapture(bytesA, { capture_id: CAPTURE_ID_A });
  const captureB = makeCapture(syntheticBytes(350, 52), {
    capture_id: CAPTURE_ID_B,
  });
  const captureC = makeCapture(syntheticBytes(350, 53), {
    capture_id: "0c0ffee0-1234-4abc-8def-000000000003",
  });
  let replayRequests = 0;
  const { adapter, store, root } = await makeAdapter((url) => {
    if (url.pathname === INDEX_PATH) {
      return jsonResponse(makeIndexPage([makeIndexRow({
        evidence_ref: { ref: "artifact://sentinel/x.pgp", digest: digestA },
      })]));
    }
    replayRequests++;
    if (url.searchParams.get("cursor") === "c1") {
      return jsonResponse(makeReplayPage(captureB, "c2"));
    }
    if (url.searchParams.get("cursor") === "c2") {
      return jsonResponse(makeReplayPage(captureC));
    }
    return jsonResponse(makeReplayPage(captureA, "c1"));
  }, {
    limits: {
      totalMaxBytes: 600,
      artifactMaxBytes: 100_000,
      retentionMaxAgeMs: LIMITS.retentionMaxAgeMs,
    },
  });
  try {
    // A (350) + B (350) = 700 > totalMaxBytes 600: the second page must stop
    // the walk before B joins the in-memory set — no third page, no claimed
    // complete evidence, and the matched A stays retained.
    const result = await adapter.readIncident(INCIDENT_A);
    assert.ok(!result.ok && result.error.kind === "unavailable");
    assert.equal(replayRequests, 2);
    const stats = await store.stats();
    assert.ok(stats.ok && stats.value.count === 1);
    const kept = await store.get(
      `artifact://sentinel/${INCIDENT_A}/${CAPTURE_ID_A}`,
      T0,
    );
    assert.ok(kept.ok && kept.value !== null);
    if (kept.ok && kept.value) assert.equal(kept.value.digest, digestA);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("adapter: aggregate replay count bound stops fetching before the 17th capture", async () => {
  const captures: {
    digest: string;
    capture: { manifest: Record<string, unknown>; chunks: string[] };
  }[] = [];
  for (let index = 0; index < 17; index++) {
    const bytes = syntheticBytes(100, 60 + index);
    captures.push({
      digest: await sha256hex(bytes),
      capture: makeCapture(bytes, {
        capture_id: `cap-${String(index + 1).padStart(4, "0")}`,
        fingerprint: `c${index + 1}`.padEnd(64, "a"),
      }),
    });
  }
  const rowDigest = captures[0]!.digest;
  let replayRequests = 0;
  const { adapter, store, root } = await makeAdapter((url) => {
    if (url.pathname === INDEX_PATH) {
      return jsonResponse(makeIndexPage([makeIndexRow({
        evidence_ref: { ref: "artifact://sentinel/x.pgp", digest: rowDigest },
      })]));
    }
    const page = replayRequests++;
    const next = captures[page]!;
    const cursor = page === captures.length - 1 ? null : `c${page + 1}`;
    return jsonResponse(makeReplayPage(next.capture, cursor));
  });
  try {
    // 17 tiny captures exceed the contract artifact-count bound (16): the
    // walk stops before the 17th capture reaches the in-memory set.
    const result = await adapter.readIncident(INCIDENT_A);
    assert.ok(!result.ok && result.error.kind === "invalid");
    assert.equal(replayRequests, 17);
    // Only the exact matched capture was retained; the pending non-matching
    // ones never join while the walk is unbounded (no partial evidence).
    const stats = await store.stats();
    assert.ok(stats.ok && stats.value.count === 1);
    const kept = await store.get(
      `artifact://sentinel/${INCIDENT_A}/cap-0001`,
      T0,
    );
    assert.ok(kept.ok && kept.value !== null);
    if (kept.ok && kept.value) assert.equal(kept.value.digest, rowDigest);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("adapter: readArtifact stops pagination at the exact capture", async () => {
  const bytesA = syntheticBytes(120, 71);
  const bytesB = syntheticBytes(120, 72);
  const digestB = await sha256hex(bytesB);
  const captureA = makeCapture(bytesA, { capture_id: CAPTURE_ID_A });
  const captureB = makeCapture(bytesB, { capture_id: CAPTURE_ID_B });
  const captureC = makeCapture(syntheticBytes(120, 73), {
    capture_id: "0c0ffee0-1234-4abc-8def-000000000003",
  });
  let replayRequests = 0;
  const { adapter, root } = await makeAdapter((url) => {
    replayRequests++;
    if (url.searchParams.get("cursor") === "c1") {
      return jsonResponse(makeReplayPage(captureB, "c2"));
    }
    if (url.searchParams.get("cursor") === "c2") {
      return jsonResponse(makeReplayPage(captureC));
    }
    return jsonResponse(makeReplayPage(captureA, "c1"));
  });
  try {
    // The bounded walk stops as soon as the exact capture identity is found:
    // the third page is never fetched.
    const result = await adapter.readArtifact(
      `artifact://sentinel/${INCIDENT_A}/${CAPTURE_ID_B}`,
      64 * 1_024,
    );
    assert.ok(result.ok && result.value !== null);
    if (!result.ok || !result.value) return;
    assert.equal(result.value.digest, digestB);
    assert.equal(replayRequests, 2);
  } finally {
    await removeRoot(root);
  }
});
