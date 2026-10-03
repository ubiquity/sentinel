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

/** Rejection-only evidence; these bytes never authorize historical ingestion. */
export interface MatrixRejectedWaveV1 {
  reason: "reservation_after_manifest";
  proof: HostedRunProofV1;
  planDigest: string;
  plannerJobId: number;
  affected: readonly {
    request: ModelRunRequestV1;
    requestDigest: string;
    work: WorkRecordV1;
    workDigest: string;
    reservation: BudgetReservationV1;
    reservationDigest: string;
  }[];
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
export interface MatrixArtifactTransportV1 {
  /** Exact current attempt and exhaustive native jobs must all be completed. */
  confirmCompletedExecution?(
    execution: HostedExecutionIntentV1,
  ): Promise<boolean>;
  /** Selects only the exact freshly saved, natively settled execution. */
  rejectHistorical?(input: {
    proof: HostedRunProofV1;
  }): Promise<readonly MatrixRejectedWaveV1[]>;
  recover(input: {
    requests: readonly MatrixArtifactRequestV1[];
    runtimeSha: GitSha;
    launcherSha: GitSha;
    /** Exact native execution when known; omitted for reservation-based recovery. */
    currentRun?: MatrixRunIdentityV1;
  }): Promise<readonly MatrixAuthenticatedWaveV1[]>;
}
