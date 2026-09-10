/**
 * Wave C integrated lifecycle acceptance through the ACTUAL production
 * entrypoints (`src/main.ts`, `src/release-main.ts`) with fake external
 * transports and disposable real local Git repositories.
 *
 * Covered:
 * - capability fence: the repair entrypoint never receives release write
 *   capability or a Deno release port; the release entrypoint never receives
 *   repair write capability, a model port or budget authority (compile-time).
 * - the complete repair lifecycle: incident discovery (real gateway adapter
 *   in the gateway test; scripted incident port here), artifact retention,
 *   intended before-failure replay, bounded model candidate, after-pass
 *   regression, deterministic PR, review wait, exact-head merge, release
 *   request.
 * - the real release controller through the release entrypoint against the
 *   real DenoReleaseRESTClient + scripted platform: build receipt binding,
 *   prior attestation, 204 promotion with post-effect identity proof, the
 *   30-minute window, acceptance, and terminal completion of the repair
 *   record.
 * - release build receipt stays unavailable unless a trusted resolver is
 *   explicitly injected: without one the controller waits and never promotes.
 * - gateway discovery + local retention through the repair entrypoint, and
 *   fail-closed `evidence_expired` never fabricates a fixture.
 *
 * No network, no model call, no credentials; every checkout/state write is a
 * disposable local bare repository. Run with: deno task test:integration.
 */
import assert from "node:assert/strict";

import {
  CAPTURE_ID_A,
  FINGERPRINT_A,
  INCIDENT_A,
  jsonResponse,
  makeCapture,
  makeIndexPage,
  makeIndexRow,
  makeReplayPage,
  sha256hex,
  SOURCE_TTL_MS,
  syntheticBytes,
} from "../adapters/gateway/helpers.ts";
import { ScriptedResolver } from "../release/helpers.ts";
import { REPO_2, repositoryConfig } from "../budget/helpers.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { ReviewDrainReportV1 } from "../../src/contracts/ports.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import { GitHubCodexReviewTransport } from "../../src/github/codex-review-transport.ts";
import type {
  PreparedStructuredReviewV1,
  StructuredReviewOutcomeV1,
  StructuredReviewPrepareV1,
} from "../../src/github/codex-reviewer.ts";
import type { HttpRequestV1, HttpResponseV1 } from "../../src/github/http.ts";
import {
  REVIEW_MODEL,
  REVIEW_REASONING,
  type ReviewJournalExecutionV1,
  type ReviewJournalReadyExecutionV1,
  type ReviewResultV1,
} from "../../src/github/review-journal.ts";
import {
  reviewSnapshotDigest,
  type ReviewSnapshotV1,
} from "../../src/github/review-snapshot.ts";
import {
  OPERATION_MARGIN_MS,
  REPAIR_RUN_CEILING_MS,
} from "../../src/repair/loop.ts";
import {
  REPAIR_REVIEW_DRAIN_ERROR_MESSAGE,
  type RepairEntrypointDepsV1,
  RepairReviewDrainError,
  runRepairEntrypoint,
} from "../../src/main.ts";
import { FakeAuthProvider, FakeCooldownGate } from "../github/helpers.ts";
import { incidentEvidence, incidentSummary } from "../state/helpers.ts";
import type { ReleaseEntrypointDepsV1 } from "../../src/release-main.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import {
  DEP_2,
  evidenceFixture,
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  FINGERPRINT,
  gatewayLimits,
  makeGatewayRig,
  makeIntegrationCtx,
  makeReleaseRig,
  makeRepairRig,
  repairConfigs,
  REPO,
  SHA1,
  SHA2,
  SHA3,
  summaryFixture,
  T0,
} from "./helpers.ts";

const INDEX_PATH = "/admin/sentinel/incidents";
const REPLAY_PATH = "/admin/sentinel/replay-captures";
const DAY_MS = 24 * 60 * 60 * 1_000;

Deno.test(
  "capability fence: entrypoint capability separation is compile-time enforced",
  () => {
    // The repair entrypoint receives the repair read/write view plus the
    // ports; release write capability, a Deno release port and release
    // records are impossible at the type boundary.
    const repairFence = (deps: RepairEntrypointDepsV1) => {
      // @ts-expect-error the repair entrypoint never receives release write capability
      deps.state.writeRelease;
      // @ts-expect-error the repair entrypoint never receives a Deno release port
      deps.deno;
      // @ts-expect-error the repair entrypoint never receives release records
      deps.releases;
    };
    // The release entrypoint receives only the release writer plus the shared
    // read view; repair write capability, budget reservations, model
    // admission and the implementation port are impossible.
    const releaseFence = (deps: ReleaseEntrypointDepsV1) => {
      // @ts-expect-error the release entrypoint never receives repair write capability
      deps.stateWrite.writeRepair;
      // @ts-expect-error the release entrypoint never receives budget admission
      deps.budget;
      // @ts-expect-error the release entrypoint never receives an implementation port
      deps.model;
      // @ts-expect-error the release entrypoint never receives work records
      deps.work;
    };
    assert.equal(typeof repairFence, "function");
    assert.equal(typeof releaseFence, "function");
  },
);

Deno.test(
  "repair entrypoint: conflicting global live-start caps fail closed before any port call",
  async () => {
    // Two repositories with different caps are a host wiring fault: the
    // entrypoint must refuse before the loop (and any external port) runs.
    const clock = new FakeClock(T0);
    const ctx = await makeIntegrationCtx("config-conflict");
    try {
      const store = createRepairStateStore({
        scratchDir: `${ctx.tmp}/scratch-repair`,
        remoteUrl: ctx.remoteUrl,
      });
      const githubCooldown = new DurableGitHubCooldownGate({
        state: store,
        clock,
      });
      const configs = [
        ...repairConfigs(),
        repositoryConfig(REPO_2, { perHour: 3, perSevenDays: 9 }),
      ];
      const budget = new RollingStartBudget({
        clock,
        state: store,
        configs,
      });
      const github = new FakeGithub({ baseSha: SHA1 });
      let fault: string | null = null;
      try {
        await runRepairEntrypoint({
          clock,
          state: store,
          configs,
          controllerSha: SHA1,
          github,
          githubCooldown,
          incidents: new FakeIncidents({ summaries: [], evidence: null }),
          replay: new FakeReplay(),
          model: new FakeModel(),
          budget,
        }, {
          deadline: clock.now() + 600_000,
        });
      } catch (error) {
        fault = String(error);
      }
      assert.match(
        fault ?? "",
        /conflicting global live-start limits/,
        "the entrypoint must fail closed on a caps conflict",
      );
      // Nothing was written and no external call was attempted: the state
      // branch is still absent and no port was touched.
      const read = await store.readRepair();
      assert.ok(
        read.ok && read.value.status === "absent",
        JSON.stringify(read),
      );
      assert.equal(
        github.calls.length,
        0,
        "no github call before fail-closed",
      );
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "lifecycle: actual entrypoints drive discovery, work, review, merge, release promotion/acceptance and closure",
  async () => {
    const rig = await makeRepairRig("lifecycle");
    try {
      // Run 1: intake -> evidence -> intended before-failure -> model ->
      // after-pass regression -> deterministic PR -> review request ->
      // review_pending wait. Everything runs through runRepairEntrypoint.
      const first = await rig.run(60 * 60_000);
      assert.equal(first.status, "idle", JSON.stringify(first));
      assert.equal(rig.model.requests.length, 1, "exactly one model start");
      let state = await rig.snapshot();
      const work = state.work[0]!;
      assert.ok(work, "one work record");
      assert.equal(work.nextStep, "review");
      assert.equal(work.wait?.reason, "review_pending");
      assert.equal(work.target.pr, 7);
      assert.equal(work.target.head, SHA3);
      assert.equal(work.counters.attempts, 1);
      assert.equal(state.replays.length, 1, "one causal before/after result");
      const replayResult = state.replays[0]!;
      assert.equal(replayResult.original.revision, SHA2);
      assert.equal(replayResult.original.outcome, "failed");
      assert.equal(replayResult.original.failure?.intended, true);
      assert.equal(replayResult.candidate.revision, SHA3);
      assert.equal(replayResult.candidate.outcome, "passed");
      assert.equal(replayResult.limitations.length, 0);
      // One durable reservation per independently admitted start.
      assert.equal(state.reservations.length, 2);
      assert.deepEqual(
        state.reservations.map((r) => r.purpose),
        ["implementation", "review_request"],
      );
      assert.ok(
        state.reservations.every((r) => r.outcome === "submitted"),
        "both starts confirmed submitted",
      );
      assert.equal(rig.github.pushes.length, 1, "one exact push");
      assert.ok(rig.github.calls.includes("createPr"));
      assert.ok(rig.github.calls.includes("requestReview"));

      // Run 2: completed review -> exact-head merge -> release request ->
      // waiting for the release controller.
      rig.clock.advance(15 * 60_000 + 1);
      rig.github.completeReview([], rig.clock.now());
      const second = await rig.run(60 * 60_000);
      assert.equal(second.status, "idle", JSON.stringify(second));
      assert.equal(
        rig.github.calls.filter((call) => call === "merge").length,
        1,
        "one exact merge",
      );
      state = await rig.snapshot();
      assert.equal(state.work[0]!.nextStep, "delivery");
      assert.equal(state.work[0]!.wait?.reason, "unavailable");
      assert.equal(state.releaseRequests.length, 1);
      const requestId = state.releaseRequests[0]!.id;
      assert.equal(state.releaseRequests[0]!.revision, SHA3);
      assert.equal(state.releaseRequests[0]!.source.pullRequest, 7);

      // Release entrypoint WITHOUT a trusted resolver: the receipt capability
      // is unavailable, so the controller waits and never promotes.
      const noResolver = await makeReleaseRig(rig.ctx);
      const waiting = await noResolver.run();
      assert.ok(waiting.ok, JSON.stringify(waiting));
      if (waiting.ok) {
        assert.equal(
          waiting.value.status,
          "waiting",
          JSON.stringify(waiting.value),
        );
        assert.equal(waiting.value.detail, "build receipt is unavailable");
      }
      assert.equal(
        noResolver.promoteCalls(),
        0,
        "never promotes without a receipt",
      );
      assert.equal((await noResolver.records()).length, 0, "no release record");

      // Release entrypoint WITH an explicitly injected trusted resolver bound
      // to the exact accepted merged SHA: candidate/prior attestation, 204
      // promotion, post-effect identity proof, 30-minute window acceptance.
      const released = await makeReleaseRig(rig.ctx, {
        resolver: new ScriptedResolver(),
      });
      released.resolver!.outcome = {
        ok: true,
        value: {
          status: "found",
          receipt: {
            buildTransactionId: `txn-${DEP_2.revisionId}`,
            identity: DEP_2,
          },
        },
      } as const;
      const begun = await released.run();
      assert.ok(begun.ok, JSON.stringify(begun));
      if (begun.ok) {
        assert.equal(
          begun.value.status,
          "advanced",
          JSON.stringify(begun.value),
        );
      }
      const promoted = await released.run();
      assert.ok(promoted.ok, JSON.stringify(promoted));
      if (promoted.ok) {
        assert.equal(
          promoted.value.status,
          "advanced",
          JSON.stringify(promoted.value),
        );
      }
      assert.equal(released.promoteCalls(), 1, "one promotion");
      let records = await released.records();
      assert.equal(records.length, 1);
      // A scheduled entrypoint keeps the active monitoring window alive and
      // completes all 60 required 30-second samples before returning.
      assert.equal(records[0]!.phase, "accepted");
      assert.equal(records[0]!.receipts.promote?.ok, true);
      assert.equal(records[0]!.receipts.promote?.statusCode, 204);
      assert.equal(records[0]!.candidate.identity.gitSha, SHA3);
      assert.equal(records[0]!.prior.identity.gitSha, SHA2);
      assert.equal(records[0]!.candidate.identity.revisionId, DEP_2.revisionId);
      records = await released.records();
      assert.equal(records[0]!.phase, "accepted");
      const acceptance = records[0]!.acceptance;
      assert.ok(acceptance, "accepted record carries the persisted evidence");
      assert.equal(acceptance!.samples.length, 60);
      assert.equal(acceptance!.baseline.length, 60);
      assert.equal(acceptance!.continuous, true);
      assert.equal(acceptance!.passed, true);
      assert.equal(
        released.promoteCalls(),
        1,
        "no rollback, no repeat promotion",
      );

      // Run 3: the repair entrypoint observes the accepted release record and
      // completes the record; incident tasks have no issue to close.
      rig.clock.advance(5 * 60_000 + 1);
      const third = await rig.run(60 * 60_000);
      assert.equal(third.status, "idle", JSON.stringify(third));
      state = await rig.snapshot();
      assert.equal(state.work[0]!.nextStep, "done");
      assert.equal(state.releaseRequests.length, 1);
      assert.equal(
        state.releaseRequests[0]!.id,
        requestId,
        "request identity stable",
      );
      assert.equal(state.releaseRequests[0]!.status, "open");
      assert.equal(rig.model.requests.length, 1, "no duplicate model starts");
      assert.equal(
        rig.github.calls.some((call) => call.startsWith("closeIssue:")),
        false,
        "incident tasks have no issue to close",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "gateway: real adapter discovery and local retention through the repair entrypoint",
  async () => {
    const ctx = await makeIntegrationCtx("gateway");
    const loopClock = new FakeClock(T0);
    const bytes = syntheticBytes(2_000, 1);
    const digest = await sha256hex(bytes);
    const capture = makeCapture(bytes, {
      capture_id: CAPTURE_ID_A,
      captured_at_ms: T0,
      expires_at_ms: T0 + SOURCE_TTL_MS,
    });
    const row = makeIndexRow({
      incident_id: INCIDENT_A,
      fingerprint: FINGERPRINT_A,
      first_seen_at_ms: T0,
      last_seen_at_ms: T0 + 3_000,
      count: 7,
      evidence_ref: {
        ref: "artifact://sentinel/synth-capture-a.pgp",
        digest,
      },
      evidence_expires_at_ms: T0 + SOURCE_TTL_MS,
      provenance: {
        endpoint: "https://ai.ubq.fi",
        captured_at_ms: T0,
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
        // A bounded session fits the positive 60-minute run deadline; the
        // declared operation margin check must not stop the evidence stage.
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
      const result = await runRepairEntrypoint({
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
        deadline: loopClock.now() + 60 * 60_000,
        // Bounded: intake, branch assignment, evidence retention and the
        // missing-fixture blocker need 4 progress transitions; 6 leaves the
        // margin to reach the idle ranking inside the 4-8 window.
        stepLimit: 6,
      });
      // Wave C identity correction: the repair loop resolves evidence by
      // incidentId + exact repository identity (never by the evidence id
      // `evidence:<incidentId>`), so the real gateway evidence is found and
      // the loop converges to the truthful blocker — the producer emits
      // replay:null, so no fixture exists and no captured-request repair is
      // fabricated. (tests/integration/evidence-identity_test.ts proves the
      // no-refetch/no-repeat-persistence/collision cases in depth.)
      assert.equal(result.status, "idle", JSON.stringify(result));
      const read = await store.readRepair();
      assert.ok(read.ok && read.value.status === "found", JSON.stringify(read));
      const snapshot = read.value.snapshot;
      // Incident discovery DID work: the summary was ingested exactly once.
      assert.equal(snapshot.incidents.length, 1);
      assert.equal(snapshot.incidents[0]!.id, INCIDENT_A);
      const work = snapshot.work[0]!;
      assert.ok(work);
      assert.equal(work.related.incidentId, INCIDENT_A);
      // The record is blocked on the missing replay fixture; no model start,
      // no fixture and no fakery happened.
      assert.equal(work.nextStep, "blocked");
      assert.equal(work.blocker?.kind, "missing_evidence");
      assert.equal(work.blocker?.message, "incident has no replay fixture");
      assert.equal(model.requests.length, 0);
      assert.equal(snapshot.replays.length, 0);
      // The evidence WAS fetched and retained with exact artifact identity;
      // the local store retention (7 days) outlives the source 48-hour TTL:
      // retention is secured by deterministic ingestion, never by claiming
      // the producer TTL is sufficient.
      assert.equal(snapshot.evidence.length, 1);
      const evidence = snapshot.evidence[0]!;
      assert.equal(evidence.incidentId, INCIDENT_A);
      assert.equal(evidence.artifacts.length, 1);
      const artifact = evidence.artifacts[0]!;
      assert.equal(
        artifact.ref,
        `artifact://sentinel/${INCIDENT_A}/${CAPTURE_ID_A}`,
      );
      assert.equal(artifact.digest, digest);
      assert.equal(artifact.sizeBytes, bytes.byteLength);
      assert.equal(
        artifact.expiresAt,
        T0 + gatewayLimits().retentionMaxAgeMs,
      );
      assert.ok(
        artifact.expiresAt > T0 + SOURCE_TTL_MS,
        "local retention outlives the 48-hour source TTL",
      );
      const stored = await gateway.store.get(artifact.ref, T0);
      assert.ok(stored.ok && stored.value !== null, JSON.stringify(stored));
      if (stored.ok && stored.value) {
        assert.equal(stored.value.sizeBytes, bytes.byteLength);
        assert.equal(stored.value.manifest.algorithm, "AES-256-GCM");
        assert.equal(stored.value.manifest.compression, "gzip");
      }
      // Read-only: index + replay export only; no claim/ack/defer writes.
      gateway.transport.assertReadOnly([INDEX_PATH, REPLAY_PATH]);
    } finally {
      await gateway.cleanup();
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "gateway: expired evidence blocks with evidence_expired and never fabricates a fixture",
  async () => {
    const ctx = await makeIntegrationCtx("gateway-expiry");
    const loopClock = new FakeClock(T0 + 8 * DAY_MS);
    const bytes = syntheticBytes(1_000, 2);
    const digest = await sha256hex(bytes);
    const capture = makeCapture(bytes, {
      capture_id: CAPTURE_ID_A,
      captured_at_ms: T0,
      expires_at_ms: T0 + SOURCE_TTL_MS,
    });
    const row = makeIndexRow({
      incident_id: INCIDENT_A,
      fingerprint: FINGERPRINT_A,
      first_seen_at_ms: T0,
      last_seen_at_ms: T0 + 3_000,
      count: 7,
      evidence_ref: {
        ref: "artifact://sentinel/synth-capture-a.pgp",
        digest,
      },
      evidence_expires_at_ms: T0 + SOURCE_TTL_MS,
      provenance: {
        endpoint: "https://ai.ubq.fi",
        captured_at_ms: T0,
        captured_by: "gateway",
      },
    });
    // The adapter clock stays frozen at capture time while the loop clock is
    // past the accepted local retention window.
    const gateway = await makeGatewayRig((url) => {
      if (url.pathname === INDEX_PATH) {
        return jsonResponse(makeIndexPage([row]));
      }
      assert.equal(url.pathname, REPLAY_PATH);
      return jsonResponse(makeReplayPage(capture));
    }, { clock: new FakeClock(T0) });
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
        // See the discovery test above for the bounded session rationale.
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
      const result = await runRepairEntrypoint({
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
        deadline: loopClock.now() + 60 * 60_000,
        stepLimit: 16,
      });
      assert.equal(result.status, "idle", JSON.stringify(result));
      const read = await store.readRepair();
      assert.ok(read.ok && read.value.status === "found", JSON.stringify(read));
      const snapshot = read.value.snapshot;
      const work = snapshot.work[0]!;
      assert.ok(work);
      assert.equal(work.nextStep, "blocked");
      assert.equal(work.blocker?.kind, "evidence_expired");
      // No evidence record and no fixture were invented.
      assert.equal(snapshot.evidence.length, 0);
      assert.equal(snapshot.replays.length, 0);
      assert.equal(model.requests.length, 0);
      // The capture was still retained inside the trusted store before the
      // expiry decision; the blocker is the evidence boundary, not the store.
      const stored = await gateway.store.get(
        `artifact://sentinel/${INCIDENT_A}/${CAPTURE_ID_A}`,
        T0,
      );
      assert.ok(stored.ok && stored.value !== null, JSON.stringify(stored));
      gateway.transport.assertReadOnly([INDEX_PATH, REPLAY_PATH]);
    } finally {
      await gateway.cleanup();
      await ctx.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// T03 v3: mandatory review drain through the ACTUAL repair entrypoint.
//
// `github.requestReview` submits through the real concrete
// `GitHubCodexReviewTransport` and `github.drainReviews` is the same
// transport's mandatory entrypoint drain — the entrypoint itself invokes it.
// The only doubles are the external HTTP surface (an in-memory review REST
// store), the trusted snapshot capture and the producer prepare capability
// (no model session is opened). No multi-second sleeps: the delayed review
// settles after a finite millisecond timer.
// ---------------------------------------------------------------------------

const TRANSPORT_PUBLISHER = "chatgpt-codex-connector[bot]";
const TRANSPORT_REVIEW_ID = 100;
const SECOND_HEAD = "9".repeat(40) as GitSha;
const SECOND_FINGERPRINT = "c".repeat(64);

const CLEAN_REVIEW_RESULT: ReviewResultV1 = {
  verdict: "clean",
  summary: "The supplied change matches the specification.",
  findings: [],
};

interface StoredReviewV1 {
  id: number;
  prNumber: number;
  author: string;
  state: "pending" | "commented";
  body: string | null;
  head: GitSha;
  submittedAt: number | null;
}

function transportResponse(status: number, value: unknown): HttpResponseV1 {
  return {
    status,
    headers: new Headers({ "content-type": "application/json" }),
    bodyText: JSON.stringify(value),
  };
}

function storedReviewJson(review: StoredReviewV1): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    id: review.id,
    user: { login: review.author },
    state: review.state === "pending" ? "PENDING" : "COMMENTED",
    body: review.body,
    commit_id: review.head,
  };
  if (review.state === "commented") {
    wire.submitted_at = new Date(review.submittedAt ?? T0).toISOString();
  }
  return wire;
}

/** Minimal in-memory GitHub review REST surface (external HTTP only). */
class ReviewRestStore {
  readonly reviews = new Map<number, StoredReviewV1>();
  nextId = TRANSPORT_REVIEW_ID;
  creates = 0;
  updates = 0;
  submits = 0;

  handle = (request: HttpRequestV1): Promise<HttpResponseV1> => {
    const path = request.url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const list = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews$/.exec(path);
    const exact = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews\/(\d+)$/.exec(
      path,
    );
    const events =
      /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews\/(\d+)\/events$/.exec(
        path,
      );
    if (request.method === "GET" && list !== null) {
      const prNumber = Number(list[1]);
      return Promise.resolve(transportResponse(
        200,
        [...this.reviews.values()]
          .filter((review) => review.prNumber === prNumber)
          .map(storedReviewJson),
      ));
    }
    if (request.method === "GET" && exact !== null) {
      const review = this.reviews.get(Number(exact[2]));
      if (review === undefined) {
        return Promise.resolve(
          transportResponse(404, { message: "Not Found" }),
        );
      }
      return Promise.resolve(transportResponse(200, storedReviewJson(review)));
    }
    if (request.method === "POST" && list !== null) {
      this.creates++;
      const payload = JSON.parse(request.body ?? "{}") as {
        commit_id: GitSha;
        body: string;
      };
      const created: StoredReviewV1 = {
        id: this.nextId++,
        prNumber: Number(list[1]),
        author: TRANSPORT_PUBLISHER,
        state: "pending",
        body: payload.body,
        head: payload.commit_id,
        submittedAt: null,
      };
      this.reviews.set(created.id, created);
      return Promise.resolve(transportResponse(201, storedReviewJson(created)));
    }
    if (request.method === "PUT" && exact !== null) {
      this.updates++;
      const review = this.reviews.get(Number(exact[2]));
      if (review === undefined) {
        return Promise.resolve(
          transportResponse(404, { message: "Not Found" }),
        );
      }
      const payload = JSON.parse(request.body ?? "{}") as { body: string };
      review.body = payload.body;
      return Promise.resolve(transportResponse(200, storedReviewJson(review)));
    }
    if (request.method === "POST" && events !== null) {
      this.submits++;
      const review = this.reviews.get(Number(events[2]));
      if (review === undefined) {
        return Promise.resolve(
          transportResponse(404, { message: "Not Found" }),
        );
      }
      const payload = JSON.parse(request.body ?? "{}") as {
        event: string;
        body: string;
      };
      assert.equal(payload.event, "COMMENT");
      review.state = "commented";
      review.submittedAt = T0;
      review.body = payload.body;
      return Promise.resolve(transportResponse(200, storedReviewJson(review)));
    }
    return Promise.resolve(transportResponse(404, { message: "unexpected" }));
  };
}

async function trustedSnapshot(
  base: GitSha,
  head: GitSha,
): Promise<ReviewSnapshotV1> {
  const draft: ReviewSnapshotV1 = {
    version: "v1",
    base,
    head,
    mergeBase: base,
    diff: "diff --git a/src/app.ts b/src/app.ts\n",
    files: [],
    digest: "",
  };
  return { ...draft, digest: await reviewSnapshotDigest(draft) };
}

/** Delayed clean producer session: `start` settles after a finite timer. */
function preparedCleanReview(
  request: StructuredReviewPrepareV1,
  delayMs: number,
): PreparedStructuredReviewV1 {
  // Prepared/running identity: exactly ReviewJournalExecutionV1. The transport
  // persists this object into the RUNNING journal before `start`, whose parser
  // rejects terminal-only keys (turnId/resultId/actual).
  const execution: ReviewJournalExecutionV1 = {
    ownerRunId: request.ownerRunId,
    invocationId: request.invocationId,
    threadId: "thread-1",
    submittedProvider: "openai",
    model: REVIEW_MODEL,
    reasoning: REVIEW_REASONING,
    startMayOccur: true,
  };
  let attempted = false;
  return {
    execution,
    threadId: "thread-1",
    invocationId: request.invocationId,
    requestId: request.requestId,
    ownerRunId: request.ownerRunId,
    latestStartAt: request.latestStartAt,
    settleBy: request.settleBy,
    startAttempted: () => attempted,
    start: async () => {
      attempted = true;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      // Terminal fields exist only on the successful start outcome, which the
      // transport persists into the READY journal.
      const ready: ReviewJournalReadyExecutionV1 = {
        ...execution,
        turnId: "turn-1",
        resultId: "result-9",
        actual: {
          evidenceKind: "request-runtime",
          provider: "openai",
          threadId: "thread-1",
          turnId: "turn-1",
          terminalOrigin: "runtime",
          observedTerminalStatus: "completed",
          observedModel: REVIEW_MODEL,
          observedReasoning: REVIEW_REASONING,
          durationMs: 5,
          outputChars: 10,
        },
      };
      return portOk(
        {
          status: "clean",
          result: CLEAN_REVIEW_RESULT,
          resultId: ready.resultId,
          actual: ready.actual,
          execution: ready,
          detail: null,
        } satisfies StructuredReviewOutcomeV1,
      );
    },
    close: () =>
      Promise.resolve({ settled: true, failure: null, timedOut: false }),
  };
}

/**
 * Wire the concrete review transport into the exact GitHubPort instance the
 * entrypoint consumes: submission and the mandatory drain both flow through
 * the real transport (the port's other operations stay the deterministic
 * lifecycle fake).
 */
function wireConcreteReviewTransport(
  github: FakeGithub,
  transport: GitHubCodexReviewTransport,
  reports: ReviewDrainReportV1[],
  now: () => number,
): void {
  github.requestReview = async (request) => {
    github.calls.push("requestReview");
    const submitted = await transport.submitReview(
      request as Parameters<GitHubCodexReviewTransport["submitReview"]>[0],
    );
    if (!submitted.ok) return submitted;
    switch (submitted.value.status) {
      case "submitted":
        return portOk({
          outcome: "applied" as const,
          requestId: submitted.value.requestId,
          requestedAt: submitted.value.requestedAt,
        });
      case "ambiguous":
        return portOk({
          outcome: "ambiguous" as const,
          requestId: null,
          requestedAt: now(),
        });
      case "rejected":
        return portError("conflict", "review request was rejected");
      default:
        return portError("unavailable", "review submission status is unknown");
    }
  };
  github.drainReviews = async (request) => {
    const result = await transport.drain(request);
    reports.push(result);
    return portOk(result);
  };
}

/** Force the next repair-state read to throw (an actual cycle fault). */
function throwOnRepairRead(
  store: { readRepair: () => Promise<unknown> },
  error: Error,
): void {
  store.readRepair = () => {
    throw error;
  };
}

function secondIncidentSummary(): ReturnType<typeof incidentSummary> {
  return incidentSummary("inc-b", {
    fingerprint: SECOND_FINGERPRINT,
    severity: "P1",
    failingRevision: SHA2,
    evidenceRef: {
      ref: "artifact://inbox/inc-b.pgp",
      digest: "e".repeat(64),
    },
  });
}

function secondIncidentEvidence(): ReturnType<typeof incidentEvidence> {
  return incidentEvidence("inc-b", {
    incidentId: "inc-b",
    fingerprint: SECOND_FINGERPRINT,
    failingRevision: SHA2,
    replay: {
      fixtureRef: "fixture://sentinel/regression-b.json",
      fixtureDigest: "a".repeat(64) as never,
      upstreamCaptured: true,
      commandId: "replay_capture",
      reproducedAt: T0,
    },
  });
}

Deno.test(
  "entrypoint: mandatory drain settles a delayed clean review through the concrete transport port",
  async () => {
    const rig = await makeRepairRig("drain-concrete-transport");
    try {
      const store = new ReviewRestStore();
      const preparedSessions: PreparedStructuredReviewV1[] = [];
      const transport = new GitHubCodexReviewTransport({
        client: new GitHubApiClient({
          repository: REPO,
          apiBaseUrl: "https://api.github.com",
          http: (request) => store.handle(request),
          auth: new FakeAuthProvider(),
          cooldownGate: new FakeCooldownGate(),
          clock: rig.clock,
        }),
        repository: REPO,
        publisher: TRANSPORT_PUBLISHER,
        clock: rig.clock,
        ownerRunId: "run-integration-transport",
        snapshot: {
          capture: async (input) =>
            portOk(await trustedSnapshot(input.base, input.head)),
        },
        reviewer: {
          prepare: (request) => {
            const session = preparedCleanReview(request, 25);
            preparedSessions.push(session);
            return Promise.resolve(portOk(session));
          },
        },
      });
      const reports: ReviewDrainReportV1[] = [];
      wireConcreteReviewTransport(
        rig.github,
        transport,
        reports,
        () => rig.clock.now(),
      );

      // The cycle submits the review through the concrete transport, reaches
      // the review_pending wait and the entrypoint's mandatory drain runs.
      // A 60-minute caller ceiling keeps the full review bound (10 minutes)
      // plus the five-minute reserved loop margin inside the positive window.
      const result = await rig.run(60 * 60_000);
      assert.equal(result.status, "idle", JSON.stringify(result));
      assert.equal(store.creates, 1, "one durable pending review was created");
      assert.equal(store.submits, 1, "the drain published exactly one COMMENT");
      assert.equal(
        preparedSessions.at(-1)?.startAttempted(),
        true,
        "the concrete drain actually started the delayed review",
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        1,
      );

      assert.equal(
        reports.length,
        1,
        "the entrypoint invoked the concrete transport drain exactly once",
      );
      const report = reports[0];
      assert.equal(report.ok, true, JSON.stringify(report));
      assert.equal(
        report.interrupted,
        false,
        "healthy delayed work is awaited, never interrupted",
      );
      assert.equal(report.operations.length, 1);
      assert.equal(report.operations[0].outcome, "settled");
      assert.equal(report.operations[0].processSettled, true);
      assert.equal(report.operations[0].durable, true);
      const standing = [...store.reviews.values()][0]!;
      assert.equal(standing.state, "commented");
      assert.equal(standing.submittedAt, T0);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "entrypoint: original cycle outcome and error survive a successful mandatory drain",
  async () => {
    // (1) Successful cycle + successful drain: the original outcome returns.
    const rig = await makeRepairRig("drain-preserve-outcome");
    try {
      const outcome = await rig.run(30 * 60_000);
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      assert.equal(rig.github.drains.length, 1);
      assert.equal(rig.github.drains[0].interrupt, true);
    } finally {
      await rig.ctx.cleanup();
    }

    // (2) Cycle error + successful drain: the ORIGINAL error is rethrown.
    const thrown = await makeRepairRig("drain-preserve-error");
    try {
      const cycleError = new Error("synthetic cycle fault");
      throwOnRepairRead(thrown.store, cycleError);
      await assert.rejects(() => thrown.run(), (error: unknown) => {
        assert.equal(error, cycleError);
        return true;
      });
      assert.equal(
        thrown.github.drains.length,
        1,
        "the drain still ran on the error path",
      );
    } finally {
      await thrown.ctx.cleanup();
    }
  },
);

Deno.test(
  "entrypoint: a failed mandatory drain raises RepairReviewDrainError preserving the original failure",
  async () => {
    // (3) Successful cycle + failed drain: typed failure, original outcome.
    const rig = await makeRepairRig("drain-failure-outcome");
    try {
      rig.github.drainResult = portOk({
        ok: false,
        operations: [{
          operationKey: "review:work-1",
          outcome: "faulted",
          processSettled: false,
          durable: true,
          phase: "running",
          fault: "review transport: review operation state is unavailable",
        }],
        faults: ["review transport: review operation state is unavailable"],
        deadline: T0,
        interrupted: true,
        completedAt: T0,
      });
      await assert.rejects(() => rig.run(30 * 60_000), (error: unknown) => {
        assert.ok(error instanceof RepairReviewDrainError);
        assert.equal(error.message, REPAIR_REVIEW_DRAIN_ERROR_MESSAGE);
        assert.equal(error.report?.ok, false);
        assert.equal(error.outcome?.status, "idle");
        return true;
      });
    } finally {
      await rig.ctx.cleanup();
    }

    // (4) Cycle error + drain error: the original cycle error is the cause.
    const both = await makeRepairRig("drain-double-failure");
    try {
      const cycleError = new Error("synthetic simultaneous cycle fault");
      throwOnRepairRead(both.store, cycleError);
      both.github.drainReviews = () =>
        Promise.reject(new Error("synthetic drain transport fault"));
      await assert.rejects(() => both.run(), (error: unknown) => {
        assert.ok(error instanceof RepairReviewDrainError);
        assert.equal(error.message, REPAIR_REVIEW_DRAIN_ERROR_MESSAGE);
        assert.equal((error as { cause?: unknown }).cause, cycleError);
        assert.equal(error.outcome, null);
        return true;
      });
    } finally {
      await both.ctx.cleanup();
    }
  },
);

Deno.test(
  "entrypoint: drain receives the original hard deadline and the loop keeps its five-minute reserve and model cutoff",
  async () => {
    const rig = await makeRepairRig("drain-hard-deadline");
    try {
      const start = rig.clock.now();
      const bounds: { latestStartAt: number; settleBy: number }[] = [];
      const originalRequest = rig.github.requestReview.bind(rig.github);
      rig.github.requestReview = (request) => {
        bounds.push(request as { latestStartAt: number; settleBy: number });
        return originalRequest(request);
      };
      const outcome = await rig.run(200 * 60_000);
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      // The caller ceiling above 120 minutes is clamped by the fixed run
      // ceiling, and the drain receives that ORIGINAL hard deadline.
      const hardDeadline = start + REPAIR_RUN_CEILING_MS;
      assert.deepEqual(rig.github.drains, [
        { deadline: hardDeadline, interrupt: true },
      ]);
      // The deterministic loop work stopped exactly one operation margin
      // (five minutes) before that ceiling: no review start may claim work
      // inside the reserved publication/validation margin.
      assert.equal(bounds.length, 1);
      assert.ok(
        bounds[0].settleBy <= hardDeadline - OPERATION_MARGIN_MS,
        `review settleBy ${
          bounds[0].settleBy
        } must stay inside the loop deadline`,
      );
      assert.ok(
        bounds[0].latestStartAt < bounds[0].settleBy,
        "the review start bound must remain in the future",
      );
    } finally {
      await rig.ctx.cleanup();
    }

    // The 90-minute model-start cutoff is unchanged: a clock jump past it
    // before the implementation step leaves no model start and no reservation.
    const cutoffRig = await makeRepairRig("drain-model-cutoff");
    try {
      const originalReplay = cutoffRig.replay.runReplay.bind(cutoffRig.replay);
      let advanced = false;
      cutoffRig.replay.runReplay = (request) => {
        if (!advanced) {
          advanced = true;
          cutoffRig.clock.advance(91 * 60_000);
        }
        return originalReplay(request);
      };
      const outcome = await cutoffRig.run(200 * 60_000);
      // Past the 90-minute model cutoff every remaining operation is model
      // work, so the loop reports the typed no-work margin: no model start and
      // no review admission is ever fabricated past the bounds.
      assert.equal(outcome.status, "margin", JSON.stringify(outcome));
      assert.equal(
        cutoffRig.model.requests.length,
        0,
        "no model work starts after the 90-minute cutoff",
      );
      assert.equal(
        cutoffRig.github.calls.filter((call) => call === "requestReview")
          .length,
        0,
        "no review start when the full bound cannot fit",
      );
      const snapshot = await cutoffRig.snapshot();
      assert.equal(
        snapshot.reservations.length,
        0,
        "no durable start reservation past the cutoff",
      );
      assert.equal(cutoffRig.github.drains.length, 1);
    } finally {
      await cutoffRig.ctx.cleanup();
    }
  },
);

Deno.test(
  "entrypoint: a second implementation task advances while the first review is pending with one writer",
  async () => {
    const rig = await makeRepairRig("dual-task-progress", {
      model: { heads: [SHA3, SECOND_HEAD] },
    });
    try {
      rig.incidents.setSummaries([summaryFixture(), secondIncidentSummary()]);
      rig.incidents.setEvidence([evidenceFixture(), secondIncidentEvidence()]);

      const first = await rig.run(30 * 60_000);
      assert.equal(first.status, "idle", JSON.stringify(first));
      const afterFirst = await rig.snapshot();
      assert.equal(afterFirst.work.length, 2, "two work records");
      // The single implementation writer advanced BOTH tasks to their review
      // wait while the first review is still pending.
      assert.equal(rig.model.requests.length, 2);
      assert.equal(
        afterFirst.reservations.filter((entry) =>
          entry.purpose === "implementation"
        ).length,
        2,
      );
      assert.equal(
        afterFirst.reservations.filter((entry) =>
          entry.purpose === "review_request"
        ).length,
        2,
      );
      assert.deepEqual(
        afterFirst.work.map((record) => record.nextStep),
        ["review", "review"],
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "merge").length,
        0,
        "a pending review never merges",
      );

      // The review observation never starts a model: a second cycle with both
      // reviews still pending adds no start, no duplicate review request and
      // no new budget reservation.
      rig.clock.advance(15 * 60_000 + 1);
      const second = await rig.run(30 * 60_000);
      assert.equal(second.status, "idle", JSON.stringify(second));
      assert.equal(rig.model.requests.length, 2, "no duplicate model start");
      const afterSecond = await rig.snapshot();
      assert.equal(
        afterSecond.reservations.length,
        afterFirst.reservations.length,
        "observation and drain reserve no budget",
      );
      assert.equal(
        afterSecond.reservations.filter((entry) =>
          entry.purpose === "review_request"
        ).length,
        2,
        "no duplicate review request while the first review is pending",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

// Compile-time + runtime re-verification that the entrypoints accept the
// exact rig capabilities (also exercised by the lifecycle test above).
Deno.test("entrypoint rigs type-check against the frozen capability shapes", async () => {
  assert.equal(typeof runRepairEntrypoint, "function");
  assert.equal(
    typeof (await import("../../src/release-main.ts")).runReleaseEntrypoint,
    "function",
  );
  // The rig identity is the one trusted repository (REPO) everywhere.
  assert.equal(REPO.name, "ai.ubq.fi");
  assert.equal(FINGERPRINT.length, 64);
});
