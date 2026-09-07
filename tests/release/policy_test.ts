// Deterministic policy compatibility and acceptance evaluation: no guessed
// thresholds; every limit comes from the enabled policy, and incomplete
// evidence is insufficient rather than an objective failure.
import assert from "node:assert/strict";

import {
  RELEASE_SAMPLE_INTERVAL_MS,
  RELEASE_WINDOW_MS,
  validateStabilityPolicy,
} from "../../src/release/config.ts";
import {
  evaluateAcceptance,
  slotMissed,
} from "../../src/release/acceptance.ts";
import { DEP_0, DEP_1, stabilityPolicy } from "./helpers.ts";
import type { MetricsSampleV1 } from "../../src/contracts/shared.ts";

function completeSample(
  identity: typeof DEP_1,
  requestCount: number,
  fiveXx: number,
): MetricsSampleV1 {
  return {
    identity,
    windowStart: 0,
    windowEnd: 30_000,
    sampledAt: 30_001,
    domain: "ai.ubq.fi",
    requestCount,
    fiveXxCount: fiveXx,
    timeoutCount: 0,
    streamFailureCount: 0,
    upstreamWideFault: false,
    coverage: { status: "complete" },
  };
}

function windowSamples(
  identity: typeof DEP_1,
  fiveXxPerSample: number,
): MetricsSampleV1[] {
  return Array.from(
    { length: 60 },
    () => completeSample(identity, 100, fiveXxPerSample),
  );
}

Deno.test("release policy: the plan-mandated window/interval is required", () => {
  assert.ok(validateStabilityPolicy(stabilityPolicy()).ok);
  const wrongWindow = stabilityPolicy({ windowMs: 10 * 60 * 1000 });
  assert.ok(!validateStabilityPolicy(wrongWindow).ok);
  const wrongInterval = stabilityPolicy({ sampleIntervalMs: 60_000 });
  assert.ok(!validateStabilityPolicy(wrongInterval).ok);
  const wrongMinimums = stabilityPolicy({ minSamples: 30 });
  assert.ok(!validateStabilityPolicy(wrongMinimums).ok);
  assert.ok(!validateStabilityPolicy(null).ok);
  assert.ok(
    validateStabilityPolicy(
      stabilityPolicy({
        baselineWindowMs: 15 * 60 * 1000,
        baselineMinSamples: 30,
      }),
    ).ok,
  );
  assert.ok(
    !validateStabilityPolicy(
      stabilityPolicy({
        baselineWindowMs: 17 * 60 * 1000,
        baselineMinSamples: 30,
      }),
    ).ok,
  );
  assert.equal(RELEASE_WINDOW_MS / RELEASE_SAMPLE_INTERVAL_MS, 60);
});

Deno.test("release policy: threshold breach with complete evidence is objective failure", () => {
  const policy = stabilityPolicy({
    thresholds: [
      { metric: "five_xx_rate", maxRate: 0.005, maxIncrease: 0 },
      { metric: "timeout_rate", maxRate: 0.01, maxIncrease: 0.01 },
      { metric: "stream_failure_rate", maxRate: 0.01, maxIncrease: 0.01 },
    ],
  });
  const evaluation = evaluateAcceptance(
    policy,
    windowSamples(DEP_0, 0),
    windowSamples(DEP_1, 10), // 10% five_xx > 0.5% maxRate
  );
  assert.equal(evaluation.objectiveFailure, true);
  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.insufficientReasons.length, 0);
});

Deno.test("release policy: sparse traffic and missing telemetry are insufficient, never objective", () => {
  const policy = stabilityPolicy({ minRequests: 500 });
  const sparse = evaluateAcceptance(
    policy,
    windowSamples(DEP_0, 0),
    windowSamples(DEP_1, 10),
  );
  assert.equal(sparse.objectiveFailure, false);
  assert.ok(sparse.insufficientReasons.length > 0);
  const missing = evaluateAcceptance(
    policy,
    windowSamples(DEP_0, 0),
    Array.from({ length: 60 }, (_, index) => ({
      ...completeSample(DEP_1, 100, 0),
      requestCount: null,
      fiveXxCount: null,
      timeoutCount: null,
      streamFailureCount: null,
      upstreamWideFault: null,
      windowStart: index * 30_000,
      windowEnd: index * 30_000 + 30_000,
      sampledAt: index * 30_000 + 30_001,
    })),
  );
  assert.equal(missing.objectiveFailure, false);
  assert.equal(missing.passed, false);
});

Deno.test("release policy: upstream-wide faults cannot become stable", () => {
  const policy = stabilityPolicy();
  const samples = windowSamples(DEP_1, 0).map((sample, index) =>
    index === 30 ? { ...sample, upstreamWideFault: true } : sample
  );
  const evaluation = evaluateAcceptance(
    policy,
    windowSamples(DEP_0, 0),
    samples,
  );
  assert.equal(evaluation.objectiveFailure, false);
  assert.equal(evaluation.passed, false);
  assert.ok(
    evaluation.insufficientReasons.some((reason) =>
      reason.includes("upstream-wide")
    ),
  );
});

Deno.test("release policy: a monitoring gap beyond one interval is a missed slot", () => {
  assert.equal(slotMissed(0, 30_000, 0, 35_000, 5_000), false);
  assert.equal(slotMissed(0, 30_000, 1, 65_000, 5_000), false);
  assert.equal(slotMissed(0, 30_000, 0, 65_000, 5_000), true);
});
