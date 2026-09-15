/**
 * Wave C cross-module evidence identity regression (m02 gateway producer x
 * m04 repair consumer).
 *
 * The gateway adapter names evidence records `evidence:<incidentId>` (the
 * immutable record id) and carries the incident id separately (incidentId).
 * The repair-loop consumers (ensureEvidence, ensureBeforeReplay and the
 * candidate replay validation) must resolve evidence by incidentId plus the
 * EXACT repository identity (owner/name/installationId) — never by the
 * evidence id — and must validate a freshly returned record before persisting
 * or using it. The m04 fixtures masked the defect by using id === incidentId.
 *
 * Covered through ACTUAL consumers:
 * - real GatewayIncidentAdapter + LocalArtifactStore over the scripted
 *   Fetch-compatible recording transport -> actual runRepairEntrypoint with
 *   the actual GitStateStore/RollingStartBudget and disposable local bare
 *   repositories: initial artifact retention, exact identity/provenance
 *   preservation, no refetch and no re-persist on a resumed run inside a
 *   bounded stepLimit (4-8), and the truthful missing-fixture blocker — the
 *   real adapter emits replay:null, so the loop must stop there instead of
 *   fabricating a completed captured-request repair.
 * - a global evidence id collision with an already-persisted foreign record:
 *   fail closed with a typed blocker; the foreign record is never overwritten,
 *   never silently reused and no no-progress write loop is created.
 * - a freshly returned evidence record for a different incident or a
 *   different repository identity is rejected before it is persisted or used.
 * - an already-persisted trusted replay bundle carrying the real record id
 *   shape feeds the before-replay and candidate-validation consumers.
 *
 * No network, no model call, no credentials; the recording transport only
 * records and returns scripted responses. Run with: deno task test:integration.
 */
import assert from "node:assert/strict";

import {
  CAPTURE_ID_A,
  FINGERPRINT_A,
  INCIDENT_A,
  INCIDENT_B,
  jsonResponse,
  makeCapture,
  makeIndexPage,
  makeIndexRow,
  makeReplayPage,
  REPOSITORY,
  sha256hex,
  SOURCE_TTL_MS,
  syntheticBytes,
  T0 as GATEWAY_T0,
} from "../adapters/gateway/helpers.ts";
import {
  exactCandidateLifecycle,
  gatewayLimits,
  makeGatewayRig,
  makeIntegrationCtx,
} from "./helpers.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { parseIncidentEvidenceV1 } from "../../src/contracts/incident.ts";
import type {
  IncidentEvidenceV1,
  IncidentSummaryV1,
} from "../../src/contracts/incident.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type {
  IncidentAdapter,
  IncidentPageV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import { parseReplayResultV1 } from "../../src/contracts/replay-result.ts";
import type { ReplayResultV1 } from "../../src/contracts/replay-result.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import { runRepairEntrypoint } from "../../src/main.ts";
import {
  incidentSummary,
  REPO,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeModel,
  FakeReplay,
  repairConfigs,
} from "../repair/helpers.ts";

const INDEX_PATH = "/admin/sentinel/incidents";
const REPLAY_PATH = "/admin/sentinel/replay-captures";
const FIXTURE_REF = "fixture://sentinel/regression.json";
const FIXTURE_DIGEST = "f".repeat(64);
const LOCAL_RETAINED_REF = `artifact://sentinel/${INCIDENT_A}/${CAPTURE_ID_A}`;

function pathCount(requests: { url: string }[], path: string): number {
  return requests.filter((request) => new URL(request.url).pathname === path)
    .length;
}

/**
 * Evidence record in the shape the gateway adapter produces
 * (id `evidence:<incidentId>`, identity carried in `incidentId` and
 * `repository`). Default timestamps use the gateway fixture clock; seeded
 * scenarios pass explicit overrides for their own clock.
 */
function gatewayShapedEvidence(
  overrides: Partial<Record<string, unknown>> = {},
): IncidentEvidenceV1 {
  return parseIncidentEvidenceV1({
    version: "v1",
    kind: "incident_evidence",
    repository: REPOSITORY,
    id: `evidence:${INCIDENT_A}`,
    incidentId: INCIDENT_A,
    fingerprint: FINGERPRINT_A,
    failingRevision: SHA2,
    artifacts: [{
      ref: LOCAL_RETAINED_REF,
      digest: "e".repeat(64),
      sizeBytes: 4096,
      expiresAt: GATEWAY_T0 + 100_000_000,
      contentType: "application/octet-stream",
    }],
    replay: null,
    provenance: {
      source: "gateway",
      endpoint: "https://ai.ubq.fi",
      capturedAt: GATEWAY_T0,
      capturedBy: null,
    },
    coverage: { status: "complete" },
    ...overrides,
  });
}

/** Seeded repair snapshot (sequence 1) through the actual state store. */
function seededSnapshot(
  extra: Partial<RepairStateSnapshotV1> = {},
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    // Deliberately old: the state store requires a nondecreasing snapshot
    // time, and the seeded scenarios run at their own fixture clocks.
    updatedAt: 0,
    incidents: [],
    evidence: [],
    work: [],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    ...extra,
  });
}

Deno.test(
  "gateway evidence identity: real adapter converges to the truthful missing-fixture blocker and never refetches",
  async () => {
    const ctx = await makeIntegrationCtx("evidence-identity");
    const loopClock = new FakeClock(GATEWAY_T0);
    const bytes = syntheticBytes(2_000, 1);
    const digest = await sha256hex(bytes);
    const capture = makeCapture(bytes, {
      capture_id: CAPTURE_ID_A,
      captured_at_ms: GATEWAY_T0,
      expires_at_ms: GATEWAY_T0 + SOURCE_TTL_MS,
    });
    const row = makeIndexRow({
      incident_id: INCIDENT_A,
      fingerprint: FINGERPRINT_A,
      failing_revision: SHA2,
      first_seen_at_ms: GATEWAY_T0,
      last_seen_at_ms: GATEWAY_T0 + 3_000,
      count: 7,
      evidence_ref: {
        ref: "artifact://sentinel/synth-capture-a.pgp",
        digest,
      },
      evidence_expires_at_ms: GATEWAY_T0 + SOURCE_TTL_MS,
      provenance: {
        endpoint: "https://ai.ubq.fi",
        captured_at_ms: GATEWAY_T0,
        captured_by: "gateway",
      },
    });
    const gateway = await makeGatewayRig((url) => {
      if (url.pathname === INDEX_PATH) {
        return jsonResponse(makeIndexPage([row]));
      }
      assert.equal(url.pathname, REPLAY_PATH);
      return jsonResponse(makeReplayPage(capture));
    }, { clock: loopClock });
    try {
      const store = createRepairStateStore({
        scratchDir: `${ctx.tmp}/scratch-repair`,
        remoteUrl: ctx.remoteUrl,
      });
      const githubCooldown = new DurableGitHubCooldownGate({
        state: store,
        clock: loopClock,
      });
      const configs = repairConfigs({
        // The real gateway adapter is bound to its own exact repository
        // identity, so the trusted config must match it for evidence lookup.
        repository: REPOSITORY,
        // A bounded session fits the positive fixture run deadline; the
        // declared operation margin must not stop the evidence stage.
        sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
      });
      const budget = new RollingStartBudget({
        clock: loopClock,
        state: store,
        configs,
      });
      const github = new FakeGithub({ baseSha: SHA1 });
      const replay = new FakeReplay();
      const model = new FakeModel();
      const run = (stepLimit: number) =>
        runRepairEntrypoint({
          clock: loopClock,
          state: store,
          configs,
          controllerSha: SHA1,
          github,
          githubCooldown,
          incidents: gateway.adapter,
          replay,
          model,
          budget,
        }, {
          deadline: loopClock.now() + 1_200_000,
          stepLimit,
        });
      const snapshot = async () => {
        const read = await store.readRepair();
        assert.ok(
          read.ok && read.value.status === "found",
          JSON.stringify(read),
        );
        if (!read.ok || read.value.status !== "found") {
          throw new Error("no repair state");
        }
        return read.value.snapshot;
      };

      // Run 1: intake -> evidence retention -> the truthful blocker.
      const first = await run(6);
      assert.equal(first.status, "idle", JSON.stringify(first));
      let state = await snapshot();
      assert.equal(state.incidents.length, 1);
      const work = state.work[0]!;
      assert.ok(work);
      assert.equal(work.related.incidentId, INCIDENT_A);
      assert.equal(work.nextStep, "blocked");
      assert.equal(work.blocker?.kind, "missing_evidence");
      assert.equal(
        work.blocker?.message,
        "incident has no replay fixture",
        "the real adapter emits replay:null; nothing is fabricated",
      );
      assert.equal(model.requests.length, 0, "no model before a fixture");
      assert.equal(replay.requests.length, 0, "no replay before a fixture");
      // Evidence identity/provenance is preserved exactly as the adapter
      // produced it: the record id stays `evidence:<incidentId>`, while the
      // lookup identity (incidentId + repository) is intact.
      assert.equal(state.evidence.length, 1);
      const evidence = state.evidence[0]!;
      assert.equal(evidence.id, `evidence:${INCIDENT_A}`);
      assert.equal(evidence.incidentId, INCIDENT_A);
      assert.deepEqual(evidence.repository, REPOSITORY);
      assert.deepEqual(evidence.provenance, {
        source: "gateway",
        endpoint: "https://ai.ubq.fi",
        capturedAt: GATEWAY_T0,
        capturedBy: "gateway",
      });
      assert.equal(evidence.fingerprint, FINGERPRINT_A);
      assert.equal(evidence.failingRevision, SHA2);
      assert.equal(evidence.replay, null);
      // Retention: the referenced capture was retained exactly once with the
      // exact deterministic restricted ref, digest and local expiry.
      assert.equal(evidence.artifacts.length, 1);
      const artifact = evidence.artifacts[0]!;
      assert.equal(artifact.ref, LOCAL_RETAINED_REF);
      assert.equal(artifact.digest, digest);
      assert.equal(artifact.sizeBytes, bytes.byteLength);
      assert.equal(
        artifact.expiresAt,
        GATEWAY_T0 + gatewayLimits().retentionMaxAgeMs,
      );
      const stored = await gateway.store.get(artifact.ref, GATEWAY_T0);
      assert.ok(stored.ok && stored.value !== null, JSON.stringify(stored));
      if (stored.ok && stored.value !== null) {
        assert.equal(stored.value.sizeBytes, bytes.byteLength);
        assert.equal(stored.value.manifest.algorithm, "AES-256-GCM");
      }
      const replayFetchesAfterFirst = pathCount(
        gateway.transport.requests,
        REPLAY_PATH,
      );
      assert.equal(replayFetchesAfterFirst, 1, "one source replay export walk");
      const sequenceAfterFirst = state.sequence;

      // Run 2 (resume): the persisted record matches by incidentId +
      // repository identity, so no evidence is refetched and no unchanged
      // work is rewritten.
      loopClock.advance(60_000);
      const second = await run(4);
      assert.equal(second.status, "idle", JSON.stringify(second));
      state = await snapshot();
      assert.equal(
        state.sequence,
        sequenceAfterFirst,
        "no repeat persistence of unchanged work",
      );
      assert.equal(
        pathCount(gateway.transport.requests, REPLAY_PATH),
        replayFetchesAfterFirst,
        "resumed run never refetches the retained evidence",
      );
      assert.deepEqual(
        state.evidence[0],
        evidence,
        "immutable record identity preserved across runs",
      );
      assert.equal(state.work[0]!.nextStep, "blocked");
      assert.equal(model.requests.length, 0);
      assert.equal(replay.requests.length, 0);
      gateway.transport.assertReadOnly([INDEX_PATH, REPLAY_PATH]);
    } finally {
      await gateway.cleanup();
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "gateway evidence identity: a globally colliding evidence id fails closed without overwrite or a no-progress loop",
  async () => {
    const ctx = await makeIntegrationCtx("evidence-collision");
    const loopClock = new FakeClock(GATEWAY_T0);
    const bytes = syntheticBytes(1_200, 3);
    const digest = await sha256hex(bytes);
    const capture = makeCapture(bytes, {
      capture_id: CAPTURE_ID_A,
      captured_at_ms: GATEWAY_T0,
      expires_at_ms: GATEWAY_T0 + SOURCE_TTL_MS,
    });
    const row = makeIndexRow({
      incident_id: INCIDENT_A,
      fingerprint: FINGERPRINT_A,
      failing_revision: SHA2,
      first_seen_at_ms: GATEWAY_T0,
      last_seen_at_ms: GATEWAY_T0 + 3_000,
      count: 7,
      evidence_ref: {
        ref: "artifact://sentinel/synth-capture-a.pgp",
        digest,
      },
      evidence_expires_at_ms: GATEWAY_T0 + SOURCE_TTL_MS,
      provenance: {
        endpoint: "https://ai.ubq.fi",
        captured_at_ms: GATEWAY_T0,
        captured_by: "gateway",
      },
    });
    const gateway = await makeGatewayRig((url) => {
      if (url.pathname === INDEX_PATH) {
        return jsonResponse(makeIndexPage([row]));
      }
      assert.equal(url.pathname, REPLAY_PATH);
      return jsonResponse(makeReplayPage(capture));
    }, { clock: loopClock });
    try {
      const store = createRepairStateStore({
        scratchDir: `${ctx.tmp}/scratch-repair`,
        remoteUrl: ctx.remoteUrl,
      });
      const githubCooldown = new DurableGitHubCooldownGate({
        state: store,
        clock: loopClock,
      });
      const configs = repairConfigs({
        // Same exact repository identity as the real gateway adapter under
        // test; identity remains part of the evidence lookup key.
        repository: REPOSITORY,
        sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
      });
      const budget = new RollingStartBudget({
        clock: loopClock,
        state: store,
        configs,
      });
      const github = new FakeGithub({ baseSha: SHA1 });
      const replay = new FakeReplay();
      const model = new FakeModel();
      // A foreign record owns the same immutable evidence id for the same
      // incidentId in a DIFFERENT repository installation (a second gateway
      // instance sharing one repair state): the producer's
      // `evidence:<incidentId>` id namespace is not globally unique.
      const foreign = gatewayShapedEvidence({
        repository: {
          owner: "ubiquity",
          name: "ai.ubq.fi",
          installationId: 999,
        },
        artifacts: [{
          ref: "artifact://sentinel/foreign/own-capture.pgp",
          digest: "ab".repeat(32),
          sizeBytes: 512,
          expiresAt: GATEWAY_T0 + 100_000_000,
          contentType: "application/octet-stream",
        }],
        provenance: {
          source: "gateway",
          endpoint: "https://foreign.ubq.fi",
          capturedAt: GATEWAY_T0,
          capturedBy: null,
        },
      });
      const seeded = await store.writeRepair(
        seededSnapshot({ evidence: [foreign] }),
        null,
      );
      assert.ok(
        seeded.ok && seeded.value.status === "applied",
        JSON.stringify(seeded),
      );

      const run = (stepLimit: number) =>
        runRepairEntrypoint({
          clock: loopClock,
          state: store,
          configs,
          controllerSha: SHA1,
          github,
          githubCooldown,
          incidents: gateway.adapter,
          replay,
          model,
          budget,
        }, {
          deadline: loopClock.now() + 1_200_000,
          stepLimit,
        });
      const snapshot = async () => {
        const read = await store.readRepair();
        assert.ok(
          read.ok && read.value.status === "found",
          JSON.stringify(read),
        );
        if (!read.ok || read.value.status !== "found") {
          throw new Error("no repair state");
        }
        return read.value.snapshot;
      };

      const first = await run(6);
      assert.equal(first.status, "idle", JSON.stringify(first));
      let state = await snapshot();
      const work = state.work[0]!;
      assert.equal(work.related.incidentId, INCIDENT_A);
      assert.equal(work.nextStep, "blocked");
      assert.equal(work.blocker?.kind, "other", JSON.stringify(work.blocker));
      assert.match(
        work.blocker?.message ?? "",
        /evidence id collides/,
        "a clear typed blocker for the global id collision",
      );
      // The foreign record is untouched: no overwrite, no duplicate, and the
      // fresh gateway evidence was never merged into the work record.
      assert.equal(state.evidence.length, 1);
      assert.deepEqual(state.evidence[0], foreign);
      assert.ok(
        work.evidence.every((ref) => ref.ref !== LOCAL_RETAINED_REF),
        "the fresh evidence artifacts were never merged into the task",
      );
      assert.equal(model.requests.length, 0);
      assert.equal(replay.requests.length, 0);
      const sequenceAfterFirst = state.sequence;
      const replayFetchesAfterFirst = pathCount(
        gateway.transport.requests,
        REPLAY_PATH,
      );

      // A resumed run makes no further progress and never loops: the blocked
      // record is terminal and the colliding evidence is not refetched.
      loopClock.advance(60_000);
      const second = await run(4);
      assert.equal(second.status, "idle", JSON.stringify(second));
      state = await snapshot();
      assert.equal(state.sequence, sequenceAfterFirst, "no progress loop");
      assert.equal(
        pathCount(gateway.transport.requests, REPLAY_PATH),
        replayFetchesAfterFirst,
        "colliding evidence is never refetched",
      );
      assert.deepEqual(state.evidence[0], foreign, "foreign record preserved");
      gateway.transport.assertReadOnly([INDEX_PATH, REPLAY_PATH]);
    } finally {
      await gateway.cleanup();
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "repair loop: fresh evidence for a different incident or repository is rejected before use",
  async () => {
    // Wrong incident: the returned record's incidentId must match the
    // requested incident id.
    const wrongIncident = await makeEvidenceRig("wrong-incident", {
      evidence: gatewayShapedEvidence({
        repository: REPO,
        id: `evidence:${INCIDENT_B}`,
        incidentId: INCIDENT_B,
        fingerprint: FINGERPRINT_A,
      }),
    });
    try {
      const first = await wrongIncident.run(6);
      assert.equal(first.status, "idle", JSON.stringify(first));
      const state = await wrongIncident.snapshot();
      const work = state.work[0]!;
      assert.equal(work.related.incidentId, INCIDENT_A);
      assert.equal(work.nextStep, "blocked");
      assert.equal(work.blocker?.kind, "other");
      assert.match(
        work.blocker?.message ?? "",
        /different incident or repository/,
      );
      assert.equal(
        state.evidence.length,
        0,
        "foreign evidence never persisted",
      );
      assert.equal(
        wrongIncident.incidents.readCalls.length,
        1,
        "exactly one read for the requested incident",
      );
      const sequence = state.sequence;
      const second = await wrongIncident.run(4);
      assert.equal(second.status, "idle", JSON.stringify(second));
      assert.equal(
        (await wrongIncident.snapshot()).sequence,
        sequence,
        "no repeat persistence",
      );
      assert.equal(
        wrongIncident.incidents.readCalls.length,
        1,
        "blocked run never refetches evidence",
      );
    } finally {
      await wrongIncident.cleanup();
    }

    // Wrong repository: same incidentId, different installation id.
    const wrongRepository = await makeEvidenceRig("wrong-repository", {
      evidence: gatewayShapedEvidence({
        repository: { owner: REPO.owner, name: REPO.name, installationId: 999 },
      }),
    });
    try {
      const first = await wrongRepository.run(6);
      assert.equal(first.status, "idle", JSON.stringify(first));
      const state = await wrongRepository.snapshot();
      const work = state.work[0]!;
      assert.equal(work.nextStep, "blocked");
      assert.equal(work.blocker?.kind, "other");
      assert.match(
        work.blocker?.message ?? "",
        /different incident or repository/,
      );
      assert.equal(state.evidence.length, 0);
      assert.equal(wrongRepository.incidents.readCalls.length, 1);
      const sequence = state.sequence;
      const second = await wrongRepository.run(4);
      assert.equal(second.status, "idle", JSON.stringify(second));
      assert.equal((await wrongRepository.snapshot()).sequence, sequence);
    } finally {
      await wrongRepository.cleanup();
    }
  },
);

Deno.test(
  "repair loop: a persisted bundle with the real record id shape feeds the replay consumers",
  async () => {
    const workId = asWorkItemId("work:evidence-consumer");
    const bundle = gatewayShapedEvidence({
      repository: REPO,
      artifacts: [{
        ref: LOCAL_RETAINED_REF,
        digest: "e".repeat(64),
        sizeBytes: 4096,
        expiresAt: T0 + 100_000_000,
        contentType: "application/octet-stream",
      }],
      provenance: {
        source: "gateway",
        endpoint: "https://ai.ubq.fi",
        capturedAt: T0,
        capturedBy: null,
      },
      replay: {
        fixtureRef: FIXTURE_REF,
        fixtureDigest: FIXTURE_DIGEST,
        upstreamCaptured: true,
        commandId: "replay_capture",
        reproducedAt: T0,
      },
    });

    // Before-replay consumer: with the exact gateway id shape persisted,
    // ensureBeforeReplay must resolve the record and run the before replay
    // (an unavailable run is a wait, never a fabricated fixture) instead of
    // failing the evidence lookup and blocking with "incident has no replay
    // fixture".
    const beforeRig = await makeEvidenceRig("bundle-before", {
      summaries: [],
      evidence: null,
      replay: { before: { outcome: "unavailable" as const } },
      seed: {
        work: [incidentWorkRecord(workId, {
          target: {
            base: SHA1,
            branch: candidateBranch(workId),
            checkpoint: null,
            head: null,
            pr: null,
          },
        })],
        evidence: [bundle],
      },
    });
    try {
      const first = await beforeRig.run(6);
      assert.equal(first.status, "idle", JSON.stringify(first));
      const state = await beforeRig.snapshot();
      const work = state.work[0]!;
      assert.equal(work.nextStep, "work", JSON.stringify(work.blocker));
      assert.equal(work.blocker, null, "no missing-evidence fabrication");
      assert.equal(work.wait?.reason, "unavailable", JSON.stringify(work.wait));
      assert.equal(beforeRig.replay.requests.length, 1, "one before run");
      assert.equal(beforeRig.model.requests.length, 0, "no model start");
      assert.deepEqual(
        state.evidence[0],
        bundle,
        "persisted evidence untouched",
      );
    } finally {
      await beforeRig.cleanup();
    }

    // Candidate-validation consumer: a persisted causal bundle (candidate
    // passed at head SHA3) is found by incidentId + repository identity and
    // reused — no replay rerun, no model start, and the deterministic
    // publication proceeds instead of blocking on the evidence lookup.
    const candidate = buildCausalBundle(workId);
    const afterRig = await makeEvidenceRig("bundle-candidate", {
      summaries: [],
      evidence: null,
      // The seeded candidate must reach publication and review: the exact
      // lifecycle supplies the preservation capability (asserting head SHA3)
      // and the trusted base-refresh capability the review gate requires.
      github: {
        candidateLifecycle: exactCandidateLifecycle({ head: SHA3 }),
      },
      seed: {
        work: [incidentWorkRecord(workId, {
          target: {
            base: SHA1,
            branch: candidateBranch(workId),
            checkpoint: null,
            head: SHA3,
            pr: null,
          },
        })],
        evidence: [bundle],
        replays: [candidate],
      },
    });
    try {
      const first = await afterRig.run(6);
      assert.equal(first.status, "idle", JSON.stringify(first));
      const state = await afterRig.snapshot();
      const work = state.work[0]!;
      assert.equal(work.nextStep, "review", JSON.stringify(work.blocker));
      assert.equal(work.wait?.reason, "review_pending");
      assert.equal(work.target.pr, 7);
      assert.equal(work.target.head, SHA3);
      assert.equal(afterRig.model.requests.length, 0, "no model start");
      assert.equal(
        afterRig.replay.requests.length,
        0,
        "bundle reused, no rerun",
      );
      assert.ok(afterRig.github.calls.includes("createPr"));
      assert.ok(afterRig.github.calls.includes("requestReview"));
      assert.deepEqual(state.evidence[0], bundle);
      assert.deepEqual(state.replays[0], candidate);
    } finally {
      await afterRig.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Pagination fail-closed scenarios: real GatewayIncidentAdapter -> real
// runRepairEntrypoint -> temporary real Git state. The producer is scripted
// and read-only; every responder carries an emergency request bound so a
// broken implementation fails fast instead of hanging (the injected clock may
// be frozen and never cross the run deadline). No model/replay fabrication.
// ---------------------------------------------------------------------------

interface IntakeGatewayRigV1 {
  gateway: Awaited<ReturnType<typeof makeGatewayRig>>;
  store: ReturnType<typeof createRepairStateStore>;
  model: FakeModel;
  replay: FakeReplay;
  run(): Promise<Awaited<ReturnType<typeof runRepairEntrypoint>>>;
  snapshot(): Promise<RepairStateSnapshotV1>;
  cleanup(): Promise<void>;
}

async function makeIntakeGatewayRig(
  prefix: string,
  responder: (url: URL) => Response | Promise<Response>,
  options: { clock?: FakeClock } = {},
): Promise<IntakeGatewayRigV1> {
  const ctx = await makeIntegrationCtx(prefix);
  const clock = options.clock ?? new FakeClock(T0);
  const gateway = await makeGatewayRig(responder, { clock });
  const store = createRepairStateStore({
    scratchDir: `${ctx.tmp}/scratch-repair`,
    remoteUrl: ctx.remoteUrl,
  });
  const githubCooldown = new DurableGitHubCooldownGate({ state: store, clock });
  const configs = repairConfigs({
    // The real gateway adapter under test is bound to its own exact
    // repository identity, so the trusted config must match it.
    repository: REPOSITORY,
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
  });
  const budget = new RollingStartBudget({ clock, state: store, configs });
  const github = new FakeGithub({ baseSha: SHA1 });
  const replay = new FakeReplay();
  const model = new FakeModel();
  const run = () =>
    runRepairEntrypoint({
      clock,
      state: store,
      configs,
      controllerSha: SHA1,
      github,
      githubCooldown,
      incidents: gateway.adapter,
      replay,
      model,
      budget,
    }, {
      deadline: clock.now() + 1_200_000,
      stepLimit: 16,
    });
  const snapshot = async () => {
    const read = await store.readRepair();
    assert.ok(read.ok && read.value.status === "found", JSON.stringify(read));
    if (!read.ok || read.value.status !== "found") {
      throw new Error("no repair state");
    }
    return read.value.snapshot;
  };
  return {
    gateway,
    store,
    model,
    replay,
    run,
    snapshot,
    cleanup: async () => {
      await gateway.cleanup();
      await ctx.cleanup();
    },
  };
}

Deno.test(
  "repair loop: a repeated index cursor through the real adapter is a bounded source error",
  async () => {
    let requests = 0;
    const rig = await makeIntakeGatewayRig("pagination-cursor-cycle", (url) => {
      assert.equal(url.pathname, INDEX_PATH);
      requests++;
      // Emergency bound: never a hang even if the consumer loses its guard.
      assert.ok(requests <= 4, "emergency intake request bound reached");
      // Empty pages with a continuing cursor: a cycle must be detected and
      // surfaced, never followed forever and never converted into exhaustion.
      return jsonResponse(makeIndexPage([], "c1"));
    });
    try {
      const outcome = await rig.run();
      assert.equal(outcome.status, "source_error", JSON.stringify(outcome));
      assert.equal(
        outcome.status === "source_error" ? outcome.detail : null,
        "incident source cursor repeated without progress",
      );
      assert.equal(requests, 2, "the cycle is detected at the repeated cursor");
      const state = await rig.snapshot();
      assert.equal(state.sequence, 1, "no partial intake checkpoint");
      assert.equal(state.incidents.length, 0, "no incident invented");
      assert.equal(state.work.length, 0);
      assert.equal(rig.model.requests.length, 0, "no model call");
      assert.equal(rig.replay.requests.length, 0, "no replay fabrication");
      assert.ok(
        rig.gateway.transport.requests.every(
          (request) =>
            request.method === "GET" &&
            request.headers.get("authorization") === "Bearer synthetic-token",
        ),
        "every discovery request is authenticated",
      );
      rig.gateway.transport.assertReadOnly([INDEX_PATH]);
      rig.gateway.transport.assertNoWriteEndpoints();
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "repair loop: an incomplete index page through the real adapter never becomes normal exhaustion",
  async () => {
    let requests = 0;
    const rig = await makeIntakeGatewayRig("pagination-incomplete", (url) => {
      assert.equal(url.pathname, INDEX_PATH);
      requests++;
      assert.ok(requests <= 4, "emergency intake request bound reached");
      return jsonResponse(
        makeIndexPage([], null, {
          status: "incomplete",
          reason: "source gap",
          nextCursor: "p2",
        }),
      );
    });
    try {
      const outcome = await rig.run();
      assert.equal(outcome.status, "source_error", JSON.stringify(outcome));
      assert.equal(
        outcome.status === "source_error" ? outcome.detail : null,
        "incident discovery coverage incomplete",
      );
      assert.equal(requests, 1, "incomplete coverage stops the scan");
      const state = await rig.snapshot();
      assert.equal(state.sequence, 1, "no partial intake checkpoint");
      assert.equal(state.incidents.length, 0);
      assert.equal(state.work.length, 0);
      assert.equal(rig.model.requests.length, 0);
      assert.equal(rig.replay.requests.length, 0);
      rig.gateway.transport.assertReadOnly([INDEX_PATH]);
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "repair loop: a malformed index page through the real adapter is explicit, never an empty success",
  async () => {
    let requests = 0;
    const rig = await makeIntakeGatewayRig("pagination-malformed", (url) => {
      assert.equal(url.pathname, INDEX_PATH);
      requests++;
      assert.ok(requests <= 4, "emergency intake request bound reached");
      // Out-of-format identity (and an unknown payload key): the strict wire
      // parser must fail closed before any successful empty page is produced.
      return jsonResponse({
        data: [{
          incident_id: "sentinel-synth-0001",
          arbitrary: "raw",
        }],
        cursor: null,
        coverage: { status: "complete" },
      });
    });
    try {
      const outcome = await rig.run();
      assert.equal(outcome.status, "source_error", JSON.stringify(outcome));
      assert.equal(
        outcome.status === "source_error" ? outcome.detail : null,
        "incident source unavailable: invalid",
      );
      assert.equal(requests, 1);
      const state = await rig.snapshot();
      assert.equal(state.sequence, 1);
      assert.equal(state.incidents.length, 0);
      assert.equal(state.work.length, 0);
      assert.equal(rig.model.requests.length, 0);
      assert.equal(rig.replay.requests.length, 0);
      rig.gateway.transport.assertReadOnly([INDEX_PATH]);
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "repair loop: a frozen clock and endless distinct cursors stop at the finite page bound",
  async () => {
    // The injected clock never advances, so the run deadline can never bound
    // the scan; only the consumer's own finite page count can stop it.
    let requests = 0;
    const rig = await makeIntakeGatewayRig("pagination-page-bound", (url) => {
      assert.equal(url.pathname, INDEX_PATH);
      requests++;
      // Emergency bound: a broken implementation is rejected at 132 requests
      // instead of spinning forever.
      assert.ok(requests <= 132, "emergency intake request bound reached");
      return jsonResponse(makeIndexPage([], `c${requests}`));
    });
    try {
      const outcome = await rig.run();
      assert.equal(outcome.status, "source_error", JSON.stringify(outcome));
      assert.equal(
        outcome.status === "source_error" ? outcome.detail : null,
        "incident source pagination exceeded the page bound",
      );
      assert.equal(requests, 128, "the finite 128-page bound is enforced");
      const state = await rig.snapshot();
      assert.equal(state.sequence, 1);
      assert.equal(state.incidents.length, 0);
      assert.equal(state.work.length, 0);
      assert.equal(rig.model.requests.length, 0);
      assert.equal(rig.replay.requests.length, 0);
      rig.gateway.transport.assertReadOnly([INDEX_PATH]);
    } finally {
      await rig.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Local helpers for the seeded-state scenarios.
// ---------------------------------------------------------------------------

/**
 * Scripted IncidentAdapter double (no product logic): returns one canned
 * evidence record regardless of the requested incident id, so the loop's
 * fresh-record identity validation is exercised exactly as a misbehaving or
 * mis-wired producer would present it. `null` means the incident has no
 * evidence.
 */
class ScriptedIncidents implements IncidentAdapter {
  readonly readCalls: string[] = [];
  private readonly summaries: IncidentSummaryV1[];
  private readonly canned: IncidentEvidenceV1 | null;

  constructor(
    summaries: IncidentSummaryV1[],
    canned: IncidentEvidenceV1 | null,
  ) {
    this.summaries = summaries;
    this.canned = canned;
  }

  listUnresolvedIncidents(
    cursor: string | null,
    _limit: number,
  ): Promise<PortResultV1<IncidentPageV1>> {
    return Promise.resolve(portOk({
      items: cursor === null ? this.summaries : [],
      coverage: { status: "complete" },
      nextCursor: null,
    }));
  }

  readIncident(
    incidentId: string,
  ): Promise<PortResultV1<IncidentEvidenceV1 | null>> {
    this.readCalls.push(incidentId);
    return Promise.resolve(portOk(this.canned));
  }

  readArtifact(_ref: string, _maxBytes: number) {
    return Promise.resolve(portOk(null));
  }
}

interface EvidenceRigV1 {
  clock: FakeClock;
  store: ReturnType<typeof createRepairStateStore>;
  github: FakeGithub;
  incidents: ScriptedIncidents;
  replay: FakeReplay;
  model: FakeModel;
  run(
    stepLimit: number,
  ): Promise<Awaited<ReturnType<typeof runRepairEntrypoint>>>;
  snapshot(): Promise<RepairStateSnapshotV1>;
  cleanup(): Promise<void>;
}

/**
 * Actual entrypoint + actual GitStateStore/RollingStartBudget with the m04
 * port fakes, optionally seeded with one snapshot before the first run.
 */
async function makeEvidenceRig(
  prefix: string,
  options: {
    summaries?: IncidentSummaryV1[];
    evidence?: IncidentEvidenceV1 | null;
    replay?: ConstructorParameters<typeof FakeReplay>[0];
    seed?: Partial<RepairStateSnapshotV1>;
    github?: ConstructorParameters<typeof FakeGithub>[0];
  } = {},
): Promise<EvidenceRigV1> {
  const ctx = await makeIntegrationCtx(prefix);
  const clock = new FakeClock(T0);
  const store = createRepairStateStore({
    scratchDir: `${ctx.tmp}/scratch-repair`,
    remoteUrl: ctx.remoteUrl,
  });
  const githubCooldown = new DurableGitHubCooldownGate({ state: store, clock });
  const configs = repairConfigs({
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
  });
  const budget = new RollingStartBudget({ clock, state: store, configs });
  const github = new FakeGithub({ baseSha: SHA1, ...options.github });
  const incidents = new ScriptedIncidents(
    options.summaries ?? [incidentSummary(INCIDENT_A, {
      fingerprint: FINGERPRINT_A,
      severity: "P1",
      failingRevision: SHA2,
      evidenceRef: {
        ref: "artifact://inbox/synth-a.pgp",
        digest: "e".repeat(64),
      },
    })],
    options.evidence === undefined ? null : options.evidence,
  );
  const replay = new FakeReplay(options.replay);
  const model = new FakeModel();
  if (options.seed !== undefined) {
    const written = await store.writeRepair(
      seededSnapshot(options.seed),
      null,
    );
    assert.ok(
      written.ok && written.value.status === "applied",
      JSON.stringify(written),
    );
  }
  const run = (stepLimit: number) =>
    runRepairEntrypoint({
      clock,
      state: store,
      configs,
      controllerSha: SHA1,
      github,
      githubCooldown,
      incidents,
      replay,
      model,
      budget,
    }, {
      deadline: clock.now() + 2_400_000,
      stepLimit,
    });
  const snapshot = async () => {
    const read = await store.readRepair();
    assert.ok(read.ok && read.value.status === "found", JSON.stringify(read));
    if (!read.ok || read.value.status !== "found") {
      throw new Error("no repair state");
    }
    return read.value.snapshot;
  };
  return {
    clock,
    store,
    github,
    incidents,
    replay,
    model,
    run,
    snapshot,
    cleanup: async () => {
      await Deno.remove(ctx.tmp, { recursive: true }).catch(() => {});
    },
  };
}

/** Seeded incident work record owned by the one trusted repository. */
function incidentWorkRecord(
  id: ReturnType<typeof asWorkItemId>,
  overrides: Record<string, unknown> = {},
) {
  return workRecord(id, {
    source: { kind: "incident", id: INCIDENT_A, revision: SHA2 },
    related: { incidentId: INCIDENT_A, issueNumber: null },
    fingerprint: FINGERPRINT_A,
    failingRevision: SHA2,
    target: {
      base: SHA1,
      branch: candidateBranch(id),
      checkpoint: null,
      head: null,
      pr: null,
    },
    ...overrides,
  });
}

/** A causal replay result bound to the seeded work record (head SHA3). */
function buildCausalBundle(
  taskId: ReturnType<typeof asWorkItemId>,
): ReplayResultV1 {
  return parseReplayResultV1({
    version: "v1",
    kind: "replay_result",
    id: "replay:evidence-consumer",
    taskId,
    repository: REPO,
    original: {
      revision: SHA2,
      outcome: "failed",
      exitCode: 1,
      output: {
        stdoutDigest: "b".repeat(64),
        stderrDigest: null,
        truncated: false,
      },
      failure: { intended: true, reason: "fixture reproduced" },
    },
    candidate: {
      revision: SHA3,
      outcome: "passed",
      exitCode: 0,
      output: {
        stdoutDigest: "c".repeat(64),
        stderrDigest: null,
        truncated: false,
      },
      failure: null,
    },
    fixture: {
      ref: FIXTURE_REF,
      digest: FIXTURE_DIGEST,
      testIds: ["repair:regression"],
    },
    commands: { replay: "replay_capture", test: "test_ci" },
    expected: { beforeReason: "GatewayError" },
    limitations: [],
    createdAt: T0,
  });
}
