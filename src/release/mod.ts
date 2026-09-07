/**
 * m05-release: DenoReleasePort implementation, build-receipt seam and the
 * deterministic release state machine. See MASTER-PLAN.md §m05-release.
 *
 * This module owns `src/release/**`; it consumes frozen contracts
 * (`src/contracts/**`) and the foundation state store (`src/state/**`) only.
 * No environment variable, CLI flag or secret-literal surface exists; the
 * trusted host injects transports, credentials, config and clock.
 */

export {
  DENO_DEFAULT_TIMEOUT_MS,
  DENO_LOGS_PAGE_LIMIT,
  DENO_MAX_LOG_PAGE_BYTES,
  DENO_MAX_LOG_PAGES,
  DENO_MAX_RESPONSE_BYTES,
  DENO_REVISIONS_PAGE_LIMIT,
  RELEASE_EXPECTED_SAMPLES,
  RELEASE_MAX_SLOTS_PER_RUN,
  RELEASE_SAMPLE_INTERVAL_MS,
  RELEASE_WINDOW_MS,
  validateReleaseTargetConfig,
  validateStabilityPolicy,
} from "./config.ts";
export type {
  ReleaseTargetConfigV1,
  StabilityPolicyCheckV1,
} from "./config.ts";
export { denoRestCall } from "./http.ts";
export type {
  DenoAuthProviderV1,
  DenoHttpTransportV1,
  DenoRestRequestV1,
  DenoRestResponseV1,
} from "./http.ts";
export {
  aggregateCohortCounts,
  CohortAccumulatorV1,
  parseCohortMessage,
} from "./log-cohort.ts";
export type {
  CohortAcceptedV1,
  CohortCountsV1,
  CohortKindsV1,
  CohortParseV1,
  CohortTerminalV1,
} from "./log-cohort.ts";
export { DenoReleaseRESTClient } from "./port.ts";
export type { DenoReleasePortOptions } from "./port.ts";
export { UnavailableBuildReceiptResolver } from "./resolver.ts";
export type {
  BuildReceiptLookupV1,
  BuildReceiptResolverV1,
  BuildReceiptV1,
} from "./resolver.ts";
export {
  buildAcceptanceResult,
  dueSlotIndex,
  evaluateAcceptance,
  nextAlignedWindowStart,
  slotMissed,
} from "./acceptance.ts";
export type { AcceptanceEvaluationV1 } from "./acceptance.ts";
export { ReleaseController } from "./controller.ts";
export type {
  ReleaseControllerOptions,
  ReleaseCycleResultV1,
} from "./controller.ts";
