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
import type { RepairEntrypointDepsV1 } from "../../src/main.ts";
import type { ReleaseEntrypointDepsV1 } from "../../src/release-main.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import { runRepairEntrypoint } from "../../src/main.ts";
import {
  DEP_2,
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
  runReleaseWindowToEnd,
  SHA1,
  SHA2,
  SHA3,
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
      const first = await rig.run();
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
      const second = await rig.run();
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
      released.clock.advance(1);
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
      assert.equal(records[0]!.phase, "monitoring");
      assert.equal(records[0]!.receipts.promote?.ok, true);
      assert.equal(records[0]!.receipts.promote?.statusCode, 204);
      assert.equal(records[0]!.candidate.identity.gitSha, SHA3);
      assert.equal(records[0]!.prior.identity.gitSha, SHA2);
      assert.equal(records[0]!.candidate.identity.revisionId, DEP_2.revisionId);

      await runReleaseWindowToEnd(released);
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
      const third = await rig.run();
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
      const configs = repairConfigs({
        // A bounded session fits the synthetic 10-minute run deadline; the
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
        incidents: gateway.adapter,
        replay,
        model,
        budget,
      }, {
        deadline: loopClock.now() + 600_000,
        stepLimit: 4,
      });
      // KNOWN CROSS-MODULE BOUNDARY (Wave C finding, not fixed here): the
      // gateway adapter names evidence records `evidence:<incidentId>`
      // (src/adapters/gateway/incident-adapter.ts), while the repair loop
      // resolves evidence by `item.id === incidentId`
      // (src/repair/loop.ts ensureEvidence/ensureBeforeReplay). The m04
      // fixtures masked this by using identical id and incidentId values.
      // A bounded m04-lane correction (lookup by `item.incidentId`) is
      // required before this loop converges with the real producer; the
      // assertions below pin the observable boundary instead of pretending
      // convergence.
      assert.equal(result.status, "step_limit", JSON.stringify(result));
      const read = await store.readRepair();
      assert.ok(read.ok && read.value.status === "found", JSON.stringify(read));
      const snapshot = read.value.snapshot;
      // Incident discovery DID work: the summary was ingested exactly once.
      assert.equal(snapshot.incidents.length, 1);
      assert.equal(snapshot.incidents[0]!.id, INCIDENT_A);
      const work = snapshot.work[0]!;
      assert.ok(work);
      assert.equal(work.related.incidentId, INCIDENT_A);
      // The work record is still in the work step: the loop cannot converge
      // past the evidence stage with the real producer identity (the defect
      // above), so no model start, no fixture and no fakery happened.
      assert.equal(work.nextStep, "work");
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
        incidents: gateway.adapter,
        replay,
        model,
        budget,
      }, {
        deadline: loopClock.now() + 600_000,
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
