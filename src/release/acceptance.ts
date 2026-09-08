/**
 * Deterministic acceptance evaluation and monitoring continuity.
 *
 * The window schedule is derived ONLY from persisted state: slot k covers
 * [start + k*interval, start + (k+1)*interval). A monitor that misses a slot
 * (its observation time moved past the next slot's end by more than one
 * interval) is interrupted: continuity resets, a new window starts at the
 * next aligned boundary, and missing samples are never reconstructed.
 *
 * Evaluation uses the configured owner policy only. Do not guess live
 * thresholds: every rate limit comes from StabilityPolicyV1. An objective
 * failure is a declared threshold breach; missing telemetry, incomplete
 * coverage, too-sparse traffic and unreadable evidence are insufficient, not
 * failure.
 */

import type {
  StabilityPolicyV1,
  StabilityThresholdV1,
} from "../contracts/repository-config.ts";
import type {
  AcceptanceResultV1,
  AcceptanceThresholdResultV1,
} from "../contracts/release.ts";
import type {
  DeploymentIdentityV1,
  MetricsSampleV1,
} from "../contracts/shared.ts";
import {
  RELEASE_EXPECTED_SAMPLES,
  RELEASE_SAMPLE_INTERVAL_MS,
  RELEASE_WINDOW_MS,
} from "./config.ts";

/** The due slot index for an observation time and a persisted window start. */
export function dueSlotIndex(
  windowStart: number,
  intervalMs: number,
  observedAt: number,
): number {
  return Math.floor((observedAt - windowStart) / intervalMs);
}

/**
 * Whether collecting the next slot is overdue by more than one interval:
 * an interrupted monitor, not a reconstructible gap.
 */
export function slotMissed(
  windowStart: number,
  intervalMs: number,
  collected: number,
  observedAt: number,
  lagMs: number,
): boolean {
  const observedSlots = dueSlotIndex(
    windowStart,
    intervalMs,
    observedAt - lagMs,
  );
  return observedSlots - collected >= 2;
}

/**
 * The next aligned window start for a monitor restart: the first interval
 * boundary after the observation time (ceil), so a restarted window always
 * samples on exact interval boundaries ("30-second samples").
 */
export function nextAlignedWindowStart(
  intervalMs: number,
  observedAt: number,
): number {
  return Math.ceil(observedAt / intervalMs) * intervalMs;
}

export interface AcceptanceEvaluationV1 {
  /** Evaluated threshold results (one per policy threshold). */
  thresholds: AcceptanceThresholdResultV1[];
  /** Overall verdict: threshold breach is objective failure. */
  objectiveFailure: boolean;
  /** Every reason the aggregate evidence is insufficient. */
  insufficientReasons: string[];
  passed: boolean;
}

/**
 * Evaluates one acceptance window. `baseline` and `samples` are the persisted
 * evidence; every rate uses the summed denominators (request counts per
 * identity), never a per-sample average.
 */
export function evaluateAcceptance(
  policy: StabilityPolicyV1,
  baseline: MetricsSampleV1[],
  samples: MetricsSampleV1[],
): AcceptanceEvaluationV1 {
  const insufficientReasons: string[] = [];
  const thresholdMetrics = [
    ...new Set(policy.thresholds.map((threshold) => threshold.metric)),
  ];
  for (
    const [name, list] of [
      ["baseline", baseline],
      ["samples", samples],
    ] as const
  ) {
    if (list.length < 1) {
      insufficientReasons.push(`${name} evidence is missing`);
      continue;
    }
    for (const [index, sample] of list.entries()) {
      if (sample.coverage.status !== "complete") {
        insufficientReasons.push(`${name}[${index}] has incomplete coverage`);
      }
      if (sample.requestCount === null) {
        insufficientReasons.push(
          `${name}[${index}] has missing telemetry`,
        );
        continue;
      }
      for (const metric of thresholdMetrics) {
        if (failureCountForMetric(sample, metric) === null) {
          insufficientReasons.push(
            `${name}[${index}] has a missing ${metric} counter`,
          );
        }
      }
      if (sample.requestCount < policy.minRequests) {
        insufficientReasons.push(
          `${name}[${index}] is below the minimum request count`,
        );
      }
      if (sample.upstreamWideFault === true) {
        insufficientReasons.push(
          `${name}[${index}] shows an upstream-wide fault`,
        );
      }
    }
  }

  const thresholdResults = policy.thresholds.map((threshold) =>
    evaluateThreshold(
      threshold,
      baseline,
      samples,
      insufficientReasons.length === 0,
    )
  );
  // Thresholds are only judged against complete evidence: with missing,
  // sparse or upstream-wide-attributed data the outcome is insufficient, not
  // an objective controlled-candidate failure (which alone permits rollback).
  const objectiveFailure = insufficientReasons.length === 0 &&
    thresholdResults.some((result) => !result.passed);
  const passed = insufficientReasons.length === 0 && !objectiveFailure &&
    samples.length >= RELEASE_EXPECTED_SAMPLES &&
    baseline.length >= expectedBaselineSamples(policy);
  return {
    thresholds: thresholdResults,
    objectiveFailure,
    insufficientReasons,
    passed,
  };
}

function evaluateThreshold(
  threshold: StabilityThresholdV1,
  baseline: MetricsSampleV1[],
  samples: MetricsSampleV1[],
  dataComplete: boolean,
): AcceptanceThresholdResultV1 {
  const observedRate = aggregateRate(samples, threshold.metric);
  const baselineRate = aggregateRate(baseline, threshold.metric);
  let passed = false;
  if (dataComplete && observedRate !== null && baselineRate !== null) {
    passed = observedRate <= threshold.maxRate &&
      observedRate <= baselineRate + threshold.maxIncrease;
  }
  return {
    metric: threshold.metric,
    observedRate,
    baselineRate,
    maxRate: threshold.maxRate,
    maxIncrease: threshold.maxIncrease,
    passed,
  };
}

function aggregateRate(
  samples: MetricsSampleV1[],
  metric: "five_xx_rate" | "timeout_rate" | "stream_failure_rate",
): number | null {
  let denominator = 0;
  let failures = 0;
  let missing = false;
  for (const sample of samples) {
    if (sample.requestCount === null) {
      missing = true;
      continue;
    }
    denominator += sample.requestCount;
    const count = failureCountForMetric(sample, metric);
    if (count === null) {
      missing = true;
      continue;
    }
    failures += count;
  }
  if (missing || denominator === 0) return null;
  return failures / denominator;
}

function failureCountForMetric(
  sample: MetricsSampleV1,
  metric: "five_xx_rate" | "timeout_rate" | "stream_failure_rate",
): number | null {
  return metric === "five_xx_rate"
    ? sample.fiveXxCount
    : metric === "timeout_rate"
    ? sample.timeoutCount
    : sample.streamFailureCount;
}

function expectedBaselineSamples(policy: StabilityPolicyV1): number {
  return policy.baselineWindowMs / RELEASE_SAMPLE_INTERVAL_MS;
}

/**
 * Builds the persisted acceptance document for one window. When the evidence
 * is not yet complete this is a diagnostic (passed: false) that carries the
 * exact persisted samples and windows; at completion it is the final
 * acceptance verdict.
 */
export function buildAcceptanceResult(
  identity: DeploymentIdentityV1,
  baseline: MetricsSampleV1[],
  samples: MetricsSampleV1[],
  evaluation: AcceptanceEvaluationV1,
): AcceptanceResultV1 {
  return {
    identity,
    windowMs: RELEASE_WINDOW_MS,
    sampleIntervalMs: RELEASE_SAMPLE_INTERVAL_MS,
    continuous: true,
    baseline,
    samples,
    thresholdResults: evaluation.thresholds,
    passed: evaluation.passed,
  };
}
