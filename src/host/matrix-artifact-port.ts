/** Authenticated Actions artifact boundary; no shared state writes. */
import type { GitSha, WorkItemId } from "../contracts/brands.ts";
import type {
  MatrixCellResultV1,
  MatrixPlanV1,
  MatrixRunIdentityV1,
} from "../contracts/matrix.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";

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
  recover(input: {
    requests: readonly MatrixArtifactRequestV1[];
    runtimeSha: GitSha;
    launcherSha: GitSha;
    /** Exact native execution when known; omitted for reservation-based recovery. */
    currentRun?: MatrixRunIdentityV1;
  }): Promise<readonly MatrixAuthenticatedWaveV1[]>;
}
