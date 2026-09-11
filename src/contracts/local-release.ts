/**
 * Local activation contract (Wave C): the trusted local supervisor's separate
 * receipt for installing, verifying and (when required) rolling back one
 * exact reviewed and merged Sentinel repair.
 *
 * This contract is deliberately NOT the Deno `ReleaseRecordV1`. A Deno
 * release records a hosted deployment identity observed through the release
 * controller; a local activation records the exact Git revision a trusted
 * local supervisor made active and the actual bounded repair runs that proved
 * it. No Deno release identity is valid for local activation and no local
 * receipt can be written by a repair process.
 *
 * Every field is strict and bounded: the full `ReleaseRequestV1` (never an
 * issue body or any model text), the exact prior Git SHA, one explicit phase,
 * the exact prior Git SHA, and the candidate/prior run proofs. A proof carries
 * only the child invocation identity, the exact controller SHA it ran, the
 * observed start/finish timestamps and the observed repair outcome status.
 * Success can never be encoded by intent: `accepted` requires a candidate run
 * proof for `request.revision`, `rolled_back` requires a prior run proof for
 * the exact prior revision, and no phase may carry a proof for any other
 * revision.
 *
 * The stored target is fixed to the local Sentinel scope: repository
 * `ubiquity/sentinel` with `installationId` 0 (the explicit no-App owner
 * credential scope) and the `production` environment.
 */

import { canonicalStringify } from "./canonical.ts";
import type { GitSha } from "./brands.ts";
import { parseReleaseRequestV1, type ReleaseRequestV1 } from "./release.ts";
import { MaxText } from "./validation.ts";
import {
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectNullable,
  expectRecord,
  expectTimestamp,
  expectVersion,
  fail,
} from "./validation.ts";

/** Explicit phases of one local activation. */
export type LocalReleasePhaseV1 =
  | "installing"
  | "verifying"
  | "accepted"
  | "rollback_pending"
  | "rolled_back"
  | "failed";

export const LOCAL_RELEASE_PHASES: readonly LocalReleasePhaseV1[] = [
  "installing",
  "verifying",
  "accepted",
  "rollback_pending",
  "rolled_back",
  "failed",
];

/**
 * The observed repair outcome statuses a bounded local run may report. These
 * mirror `RepairCycleOutcomeV1["status"]` exactly; a healthy ordinary run is
 * `idle`, `margin` or `step_limit` (an empty queue, a budget wait or the read
 * bound are not startup failures), while `state_error` and `source_error` are
 * never acceptance and drive rollback of an unverified candidate.
 */
export type LocalRunOutcomeStatusV1 =
  | "idle"
  | "margin"
  | "step_limit"
  | "state_error"
  | "source_error";

export const LOCAL_RUN_OUTCOME_STATUSES: readonly LocalRunOutcomeStatusV1[] = [
  "idle",
  "margin",
  "step_limit",
  "state_error",
  "source_error",
];

/** Outcome statuses that prove a healthy ordinary run; never acceptance alone. */
export const LOCAL_RUN_HEALTHY_STATUSES: readonly LocalRunOutcomeStatusV1[] = [
  "idle",
  "margin",
  "step_limit",
];

/** Outcome statuses that are objective run failures; never acceptance. */
export const LOCAL_RUN_FAILED_STATUSES: readonly LocalRunOutcomeStatusV1[] = [
  "state_error",
  "source_error",
];

/** A run proof: identities and observed times only, never a body or credential. */
export interface LocalRunProofV1 {
  /** Exact child invocation id observed in the private status receipt. */
  invocationId: string;
  /** Exact controller SHA the child actually ran (never an intended one). */
  controllerSha: GitSha;
  startedAt: number;
  finishedAt: number;
  /** The observed repair outcome status only; no detail text is retained. */
  outcome: LocalRunOutcomeStatusV1;
}

/** One strict local activation receipt; exactly one request per receipt. */
export interface LocalReleaseReceiptV1 {
  version: "v1";
  kind: "local_release_receipt";
  /** The full strict release request this receipt is bound to. */
  request: ReleaseRequestV1;
  /** Exact Git SHA that was active immediately before this promotion. */
  priorRevision: GitSha;
  phase: LocalReleasePhaseV1;
  /** Candidate run proof, only ever for `request.revision`; null until observed. */
  candidateProof: LocalRunProofV1 | null;
  /** Prior run proof, only ever for `priorRevision`; null until observed. */
  priorProof: LocalRunProofV1 | null;
  createdAt: number;
  updatedAt: number;
}

const RECEIPT_KEYS = [
  "version",
  "kind",
  "request",
  "priorRevision",
  "phase",
  "candidateProof",
  "priorProof",
  "createdAt",
  "updatedAt",
] as const;
const PROOF_KEYS = [
  "invocationId",
  "controllerSha",
  "startedAt",
  "finishedAt",
  "outcome",
] as const;

/** Bounded private receipt size; a larger file is never parsed. */
export const LOCAL_RELEASE_RECEIPT_MAX_BYTES = 64 * 1024;

/** Phase is terminal only when it can never transition again. */
export function isLocalReleaseTerminalPhase(
  phase: LocalReleasePhaseV1,
): boolean {
  return phase === "accepted" || phase === "rolled_back" || phase === "failed";
}

/** A phase that still has work outstanding and must be reconciled. */
export function isLocalReleasePendingPhase(
  phase: LocalReleasePhaseV1,
): boolean {
  return !isLocalReleaseTerminalPhase(phase);
}

/** The exact local Sentinel scope: ubiquity/sentinel, installationId 0. */
export function isLocalSentinelRepository(
  repository: ReleaseRequestV1["target"]["repository"],
): boolean {
  return repository.owner === "ubiquity" && repository.name === "sentinel" &&
    repository.installationId === 0;
}

/** Exact request identity: any field difference is a different request. */
export function sameLocalReleaseRequestV1(
  left: ReleaseRequestV1,
  right: ReleaseRequestV1,
): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

export function parseLocalRunProofV1(
  input: unknown,
  path: string,
): LocalRunProofV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, PROOF_KEYS, path);
  const invocationId = expectNonEmptyString(
    obj.invocationId,
    `${path}.invocationId`,
    MaxText.recordId,
  );
  const controllerSha = expectGitSha(
    obj.controllerSha,
    `${path}.controllerSha`,
  );
  const startedAt = expectTimestamp(obj.startedAt, `${path}.startedAt`);
  const finishedAt = expectTimestamp(obj.finishedAt, `${path}.finishedAt`);
  if (finishedAt < startedAt) {
    fail(
      `${path}.finishedAt`,
      "invalid_lifecycle",
      "proof finished before start",
    );
  }
  const outcome = expectEnum(
    obj.outcome,
    LOCAL_RUN_OUTCOME_STATUSES,
    `${path}.outcome`,
  );
  return { invocationId, controllerSha, startedAt, finishedAt, outcome };
}

export function parseLocalReleaseReceiptV1(
  input: unknown,
): LocalReleaseReceiptV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, RECEIPT_KEYS, "$");
  expectVersion(obj.version, "$.version");
  expectEnum(obj.kind, ["local_release_receipt"], "$.kind");

  const request = parseReleaseRequestV1(obj.request);
  if (!isLocalSentinelRepository(request.target.repository)) {
    fail(
      "$.request.target.repository",
      "invalid_value",
      "local release request is not the local Sentinel repository identity",
    );
  }
  if (request.target.environment !== "production") {
    fail(
      "$.request.target.environment",
      "invalid_value",
      "local release request is not a production request",
    );
  }
  const priorRevision = expectGitSha(obj.priorRevision, "$.priorRevision");
  if (priorRevision === request.revision) {
    fail(
      "$.priorRevision",
      "invalid_lifecycle",
      "prior revision equals the candidate revision",
    );
  }
  const phase = expectEnum(obj.phase, LOCAL_RELEASE_PHASES, "$.phase");
  const candidateProof = expectNullable(
    obj.candidateProof,
    "$.candidateProof",
    parseLocalRunProofV1,
  );
  const priorProof = expectNullable(
    obj.priorProof,
    "$.priorProof",
    parseLocalRunProofV1,
  );
  const createdAt = expectTimestamp(obj.createdAt, "$.createdAt");
  const updatedAt = expectTimestamp(obj.updatedAt, "$.updatedAt");
  if (updatedAt < createdAt) {
    fail("$.updatedAt", "invalid_lifecycle", "receipt updated before creation");
  }

  // A proof can only ever attest the exact revision it belongs to.
  if (
    candidateProof !== null && candidateProof.controllerSha !== request.revision
  ) {
    fail(
      "$.candidateProof.controllerSha",
      "invalid_lifecycle",
      "candidate proof does not attest the request revision",
    );
  }
  if (priorProof !== null && priorProof.controllerSha !== priorRevision) {
    fail(
      "$.priorProof.controllerSha",
      "invalid_lifecycle",
      "prior proof does not attest the exact prior revision",
    );
  }
  if (
    candidateProof !== null && priorProof !== null &&
    candidateProof.invocationId === priorProof.invocationId
  ) {
    fail(
      "$.candidateProof.invocationId",
      "invalid_lifecycle",
      "candidate and prior proofs share one invocation",
    );
  }

  // Every observed proof is ordered within itself (enforced by the proof
  // parser) and can never have finished after the receipt update that records
  // it. A candidate proof is always observed after this receipt was created;
  // a rolled_back prior proof must be fresh rather than the pre-promotion
  // baseline. Baseline prior proofs for installing/verifying/accepted may
  // predate receipt creation.
  if (candidateProof !== null && candidateProof.finishedAt > updatedAt) {
    fail(
      "$.candidateProof.finishedAt",
      "invalid_lifecycle",
      "candidate proof finished after the receipt update",
    );
  }
  if (priorProof !== null && priorProof.finishedAt > updatedAt) {
    fail(
      "$.priorProof.finishedAt",
      "invalid_lifecycle",
      "prior proof finished after the receipt update",
    );
  }
  if (candidateProof !== null && candidateProof.startedAt < createdAt) {
    fail(
      "$.candidateProof.startedAt",
      "invalid_lifecycle",
      "candidate proof started before the receipt was created",
    );
  }
  if (
    phase === "rolled_back" && priorProof !== null &&
    priorProof.startedAt < createdAt
  ) {
    fail(
      "$.priorProof.startedAt",
      "invalid_lifecycle",
      "rolled_back requires a prior proof observed after the receipt was created",
    );
  }

  // A healthy run proof is an observed ordinary run, never a reported failure:
  // installing/verifying/rollback_pending/accepted rest on a healthy exact
  // prior proof, accepted additionally rests on a healthy candidate proof, and
  // rolled_back rests on a healthy fresh prior proof.
  if (
    (phase === "installing" || phase === "verifying" ||
      phase === "rollback_pending" || phase === "accepted") &&
    priorProof !== null && !isHealthyLocalRunProof(priorProof)
  ) {
    fail(
      "$.priorProof.outcome",
      "invalid_lifecycle",
      "phase requires a healthy exact prior run proof",
    );
  }
  if (
    phase === "accepted" && candidateProof !== null &&
    !isHealthyLocalRunProof(candidateProof)
  ) {
    fail(
      "$.candidateProof.outcome",
      "invalid_lifecycle",
      "accepted requires a healthy candidate run proof",
    );
  }
  if (
    phase === "rolled_back" && priorProof !== null &&
    !isHealthyLocalRunProof(priorProof)
  ) {
    fail(
      "$.priorProof.outcome",
      "invalid_lifecycle",
      "rolled_back requires a healthy fresh exact prior run proof",
    );
  }

  // Success is never inferred from intended state: each phase carries exactly
  // the proofs it has actually observed.
  if (phase === "installing") {
    if (priorProof === null) {
      fail(
        "$.priorProof",
        "invalid_lifecycle",
        "installing requires the exact prior healthy run proof",
      );
    }
    if (candidateProof !== null) {
      fail(
        "$.candidateProof",
        "invalid_lifecycle",
        "installing has not run the candidate yet",
      );
    }
  }
  if (phase === "verifying") {
    if (priorProof === null) {
      fail(
        "$.priorProof",
        "invalid_lifecycle",
        "verifying requires the saved prior run proof",
      );
    }
    if (candidateProof !== null) {
      fail(
        "$.candidateProof",
        "invalid_lifecycle",
        "verifying has not observed a candidate proof yet",
      );
    }
  }
  if (phase === "accepted") {
    if (candidateProof === null) {
      fail(
        "$.candidateProof",
        "invalid_lifecycle",
        "accepted requires a real candidate run proof",
      );
    }
    if (priorProof === null) {
      fail(
        "$.priorProof",
        "invalid_lifecycle",
        "accepted requires the exact prior run proof",
      );
    }
  }
  if (phase === "rollback_pending") {
    if (priorProof === null) {
      fail(
        "$.priorProof",
        "invalid_lifecycle",
        "rollback_pending requires the exact prior run proof",
      );
    }
  }
  if (phase === "rolled_back") {
    if (priorProof === null) {
      fail(
        "$.priorProof",
        "invalid_lifecycle",
        "rolled_back requires a fresh exact prior run proof",
      );
    }
  }

  return {
    version: "v1",
    kind: "local_release_receipt",
    request,
    priorRevision,
    phase,
    candidateProof,
    priorProof,
    createdAt,
    updatedAt,
  };
}

/**
 * A healthy proof: an observed ordinary run (`idle`, `margin`, `step_limit`),
 * never a reported state/source failure.
 */
export function isHealthyLocalRunProof(proof: LocalRunProofV1): boolean {
  return LOCAL_RUN_HEALTHY_STATUSES.includes(proof.outcome);
}

/**
 * The one exact prior healthy run proof required before any candidate may be
 * staged. Never derived from a pointer, a timestamp or a list order.
 */
export function localReceiptPriorHealthyProof(
  receipt: LocalReleaseReceiptV1,
): LocalRunProofV1 | null {
  const proof = receipt.priorProof;
  if (proof === null) return null;
  if (!isHealthyLocalRunProof(proof)) return null;
  if (proof.controllerSha !== receipt.priorRevision) return null;
  return proof;
}

/** Consumer-side binding check: an injected reader cannot accept other work. */
export function localReceiptBindsRequest(
  receipt: LocalReleaseReceiptV1,
  request: ReleaseRequestV1,
): boolean {
  return receipt.request.id === request.id &&
    receipt.request.revision === request.revision &&
    sameLocalReleaseRequestV1(receipt.request, request);
}
