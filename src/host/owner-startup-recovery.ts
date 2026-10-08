/** One explicitly approved startup recovery; no configurable candidate or general admission bypass. */
import { isGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import { parseHostedRunProofV1 } from "../contracts/hosted-supervisor.ts";
import type {
  HostedRunProofV1,
  HostedRuntimeRecordV1,
} from "../contracts/hosted-supervisor.ts";
import { tryParse } from "../contracts/validation.ts";
import type { OwnerDevelopmentInstallPlanV1 } from "./owner-development-install.ts";

export const OWNER_STARTUP_RECOVERY_CANDIDATE =
  "d77d3169fdd268c955dda24ae2bae7b35c5e2295" as GitSha;
export const OWNER_STARTUP_RECOVERY_FAILED =
  "e4cef46332cf124a8c283d798a963cf5f66e45c2" as GitSha;
export const OWNER_STARTUP_RECOVERY_WITNESS =
  "bfd8d4304a04696a7692ab21e0a06d05bad41641" as GitSha;
/** Public immutable identity, compared to actual trusted historical state; never itself execution proof. */
const HEALTHY_PROOF_CANONICAL =
  '{"baseSha":"f79a890d1020be13b5b650968430e80b51fc35e1","execution":{"createdAt":1791417309456,"generation":63,"id":"37704666277:1:repair","launcherSha":"44031db6fd9cbc91755a9d4501e1481b9cd09b89","purpose":"ordinary","releaseId":null,"revision":"e4cef46332cf124a8c283d798a963cf5f66e45c2","runAttempt":1,"runId":37704666277},"finishedAt":1791419897000,"jobId":113081997296,"logDigest":"aad29414cf59ddbc3916fe2566c1749dd2ac12c6e2ab9a1c9bce659f0b1fd90f","observedAt":1791419943131,"outcome":"healthy","ref":"refs/heads/sentinel-supervisor","repository":"ubiquity/sentinel","settled":true,"startedAt":1791418334000,"startupReady":true,"terminalAt":1791419892505,"workflowId":357012162,"workflowPath":".github/workflows/supervisor.yml"}';

export interface OwnerStartupRecoveryAuthorityV1 {
  releaseHead: GitSha;
  repairHead: GitSha;
  witnessHead: GitSha;
  healthyProof: HostedRunProofV1;
  nativeQuiescent: true;
  nativeProofsVerified: true;
  run: { runId: number; runAttempt: number; launcherSha: GitSha };
}

export function isOwnerStartupRecoveryHealthyProof(
  value: unknown,
): value is HostedRunProofV1 {
  const parsed = tryParse(parseHostedRunProofV1, value);
  return parsed.ok &&
    canonicalStringify(parsed.value) === HEALTHY_PROOF_CANONICAL;
}

export function isOwnerStartupRecoveryTuple(
  revision: GitSha,
  generation: number,
  includeFailed = false,
): boolean {
  return (revision === OWNER_STARTUP_RECOVERY_CANDIDATE && generation === 66) ||
    (includeFailed && revision === OWNER_STARTUP_RECOVERY_FAILED &&
      generation === 65);
}

export function planOwnerStartupRecovery(
  runtime: HostedRuntimeRecordV1,
  authority: OwnerStartupRecoveryAuthorityV1,
): OwnerDevelopmentInstallPlanV1 {
  const wait = (detail: string): OwnerDevelopmentInstallPlanV1 => ({
    status: "waiting",
    detail,
  });
  const unchanged = (detail: string): OwnerDevelopmentInstallPlanV1 => ({
    status: "no_change",
    detail,
  });
  if (
    !isGitSha(authority.releaseHead) || !isGitSha(authority.repairHead) ||
    !isGitSha(authority.witnessHead) || authority.nativeQuiescent !== true ||
    authority.nativeProofsVerified !== true ||
    !isOwnerStartupRecoveryHealthyProof(authority.healthyProof) ||
    !Number.isSafeInteger(authority.run.runId) || authority.run.runId < 1 ||
    !Number.isSafeInteger(authority.run.runAttempt) ||
    authority.run.runAttempt < 1 ||
    !isGitSha(authority.run.launcherSha)
  ) return wait("pinned startup recovery authority is unavailable");
  const { activeRevision: revision, generation } = runtime;
  if (!isOwnerStartupRecoveryTuple(revision, generation, true)) {
    return unchanged("pointer is outside the pinned startup recovery");
  }
  if (generation === 66) {
    return unchanged(
      "pinned startup recovery is terminal; never reinstall or roll back",
    );
  }
  const healthy = runtime.lastHealthyProof;
  if (!isOwnerStartupRecoveryHealthyProof(healthy)) {
    return wait("the genuine pinned historical health proof is unavailable");
  }
  const parsed = tryParse(parseHostedRunProofV1, runtime.lastExecutionProof);
  if (
    !parsed.ok || parsed.value.outcome !== "failed" ||
    parsed.value.execution.revision !== revision ||
    parsed.value.execution.generation !== generation ||
    parsed.value.execution.purpose !== "bootstrap" ||
    parsed.value.execution.releaseId !== null ||
    parsed.value.startedAt < authority.healthyProof.finishedAt ||
    parsed.value.startupReady || parsed.value.baseSha !== null
  ) {
    return wait("the exact failed startup execution is unavailable");
  }
  return {
    status: "install",
    move: {
      action: "install",
      priorRevision: revision,
      priorGeneration: generation,
      nextRevision: OWNER_STARTUP_RECOVERY_CANDIDATE,
      nextGeneration: generation + 1,
      priorHealthyProof: authority.healthyProof,
    },
    detail: "install the exact approved startup correction",
  };
}
