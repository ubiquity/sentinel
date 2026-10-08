/** Authenticated Actions artifact boundary; no shared state writes. */
import type { GitSha, WorkItemId } from "../contracts/brands.ts";
import type {
  MatrixCellResultV1,
  MatrixPlanV1,
  MatrixRunIdentityV1,
} from "../contracts/matrix.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type {
  HostedExecutionIntentV1,
  HostedRunProofV1,
} from "../contracts/hosted-supervisor.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import type { ModelRunRequestV1 } from "../contracts/ports.ts";

export const MATRIX_ARTIFACT_RECOVERY_MAX_MS = 120_000;

/** Shared wire value: artifact readers must not import their executable caller. */
export const HISTORICAL_MATRIX_QUARANTINE =
  "authenticated historical matrix manifest rejected: reservation_after_manifest; model outcome uncertain";

/**
 * Authenticated per-cell evidence for one legacy manifest rejection. Every
 * field was re-read from the exact authenticated cell artifact and its job
 * marker; a missing or malformed artifact contributes no evidence at all.
 */
export interface MatrixRejectedCellEvidenceV1 {
  cellId: string;
  taskId: WorkItemId;
  reservationId: string;
  status: MatrixCellResultV1["status"];
  /** True only when the authenticated result carries no receipt. */
  receiptNull: boolean;
  /** True only when the authenticated result carries no bundle. */
  bundleNull: boolean;
  completedAt: number;
  /** Digest of the exact authenticated result payload. */
  resultDigest: string;
}

/** Rejection-only evidence; these bytes never authorize historical ingestion. */
export interface MatrixRejectedWaveV1 {
  reason: "reservation_after_manifest";
  proof: HostedRunProofV1;
  planDigest: string;
  plannerJobId: number;
  /** Authenticated planner job interval that contains the legacy admission. */
  plannerStartedAt: string;
  plannerCompletedAt: string;
  affected: readonly {
    request: ModelRunRequestV1;
    requestDigest: string;
    work: WorkRecordV1;
    workDigest: string;
    reservation: BudgetReservationV1;
    reservationDigest: string;
  }[];
  /**
   * Authenticated per-cell evidence in plan order. A cell whose artifact was
   * missing or malformed is absent, never inferred.
   */
  cells: readonly MatrixRejectedCellEvidenceV1[];
}

export interface MatrixArtifactRequestV1 {
  taskId: WorkItemId;
  repository: RepositoryIdentityV1;
  reservationId: string;
  intentKey: string;
  expectedBase: GitSha;
  attempt: number;
}
export interface MatrixAuthenticatedWaveV1 {
  plan: MatrixPlanV1;
  planDigest: string;
  results: readonly MatrixCellResultV1[];
  bundlesDir: string;
  provenance: {
    run: MatrixRunIdentityV1;
    plannerJobId: number;
    cellJobIds: readonly number[];
  };
}
/** Rejection-only evidence. No historical result or bundle crosses this boundary. */
export class MatrixHistoricalRuntimeMismatch extends Error {
  constructor(
    readonly evidence: {
      consumerRun: MatrixRunIdentityV1;
      expectedRuntimeSha: GitSha;
      run: MatrixRunIdentityV1;
      runtimeSha: GitSha;
      generation: number;
      repairHead: GitSha;
      planDigest: string;
      planArtifactId: number;
      planArchiveDigest: string;
      plannerJobId: number;
      affected: readonly {
        work: WorkRecordV1;
        reservation: BudgetReservationV1;
        cell: MatrixRejectedCellEvidenceV1;
      }[];
    },
  ) {
    super("authenticated historical matrix runtime mismatch");
  }
}

export interface MatrixArtifactTransportV1 {
  /** Exact current attempt and exhaustive native jobs must all be completed. */
  confirmCompletedExecution?(
    execution: HostedExecutionIntentV1,
  ): Promise<boolean>;
  /**
   * Selects only the exact freshly saved, natively settled execution. The
   * proof-based not-started revalidation of already-quarantined records is
   * enabled ONLY when the trusted caller explicitly asks for it; the default
   * rejection pass keeps every already-quarantined record closed.
   */
  rejectHistorical?(input: {
    proof: HostedRunProofV1;
    revalidateNotStarted?: boolean;
  }): Promise<readonly MatrixRejectedWaveV1[]>;
  recover(input: {
    requests: readonly MatrixArtifactRequestV1[];
    runtimeSha: GitSha;
    launcherSha: GitSha;
    /** Exact native execution when known; omitted for reservation-based recovery. */
    currentRun?: MatrixRunIdentityV1;
    /** Consumer identity only; never narrows historical artifact discovery. */
    consumerRun?: MatrixRunIdentityV1;
    /** Absolute shortening-only deadline shared by one logical recovery scan. */
    deadline?: number;
  }): Promise<readonly MatrixAuthenticatedWaveV1[]>;
}
