/**
 * m04-repair: deterministic trusted identities. The repair module owns every
 * work item id, candidate branch name, operation intent key and result id; no
 * model-supplied value ever contributes to an identity. All identities are
 * pure functions of exact record fields (never wall clock, never list order),
 * so a crash or restart reproduces byte-identical values. Where a compact
 * digest is required, the one trusted SHA-256 of the canonical identity object
 * is used (same canonicalization and digest discipline as the frozen
 * contracts); no homegrown hash or truncation ever identifies anything.
 */

import { asWorkItemId } from "../contracts/brands.ts";
import type { GitSha, WorkItemId } from "../contracts/brands.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { canonicalStringify } from "../contracts/canonical.ts";

/** Repository identity part of an id: exact owner/name, no normalization. */
function repositorySlug(repository: RepositoryIdentityV1): string {
  return `${repository.owner}-${repository.name}`;
}

/** Deterministic work item id for one incident fingerprint. */
export function workItemIdForIncident(
  repository: RepositoryIdentityV1,
  fingerprint: string,
): WorkItemId {
  return asWorkItemId(
    `incident-${repositorySlug(repository)}-${fingerprint}`,
  );
}

/** Deterministic work item id for one numbered repository issue. */
export function workItemIdForIssue(
  repository: RepositoryIdentityV1,
  issueNumber: number,
): WorkItemId {
  return asWorkItemId(`issue-${repositorySlug(repository)}-${issueNumber}`);
}

/** Deterministic work item id for an existing Sentinel PR repair item. */
export function workItemIdForPullRequest(
  repository: RepositoryIdentityV1,
  pullRequestNumber: number,
): WorkItemId {
  return asWorkItemId(
    `pr-${repositorySlug(repository)}-${pullRequestNumber}`,
  );
}

/** Deterministic isolated candidate branch; git ref bodies allow [._/-]. */
export function candidateBranch(workId: WorkItemId): string {
  return `sentinel/repair/${workId}`;
}

/** Operation key for one implementation start, derived from the durable reservation id. */
export function implementationIntentKey(reservationId: string): string {
  return `impl:${reservationId}`;
}

/** Operation key for one candidate push (exact head). */
export function pushIntentKey(head: GitSha): string {
  return `push:${head}`;
}

/** Operation key for one PR publication (exact head). */
export function pullRequestIntentKey(head: GitSha): string {
  return `pull_request:${head}`;
}

/** Operation key for one review request: one pending request per PR/head. */
export function reviewOperationKey(
  pullRequestNumber: number,
  head: GitSha,
): string {
  return `review:${pullRequestNumber}:${head}`;
}

/** Operation key for one exact-identity merge. */
export function mergeIntentKey(
  pullRequestNumber: number,
  head: GitSha,
): string {
  return `merge:${pullRequestNumber}:${head}`;
}

/** Operation key for one issue closure (closure-only retry identity). */
export function closureIntentKey(issueNumber: number): string {
  return `issue_closure:${issueNumber}`;
}

/** Deterministic replay result id for one exact before/after fixture pair. */
export async function replayResultId(
  taskId: WorkItemId,
  originalSha: GitSha,
  candidateSha: GitSha,
  fixtureDigest: string,
): Promise<string> {
  return `replay:${await deriveDigest({
    taskId,
    originalSha,
    candidateSha,
    fixtureDigest,
  })}`;
}

/** Deterministic release request id for one exact accepted merged SHA. */
export async function releaseRequestId(
  repository: RepositoryIdentityV1,
  revision: GitSha,
  pullRequestNumber: number,
): Promise<string> {
  return `release:${await deriveDigest({
    repository,
    revision,
    pullRequestNumber,
  })}`;
}

/** Deterministic review receipt id for one exact PR/head observation. */
export async function reviewReceiptId(
  operationKey: string,
  observedHead: GitSha,
): Promise<string> {
  return `review-receipt:${await deriveDigest({ operationKey, observedHead })}`;
}

/**
 * Deterministic evidence ref for a durable replay result. The frozen
 * parseEvidenceRef admits only the artifact/fixture/secret opaque schemes (or
 * an opaque relative record name), so the restricted storage namespace is the
 * `artifact:` scheme with the record kind as the first segment.
 */
export function replayEvidenceRef(replayId: string): string {
  return `artifact:replay-result/${replayId}`;
}

/** Deterministic evidence ref (restricted storage shape) for a review receipt. */
export function reviewEvidenceRef(receiptId: string): string {
  return `artifact:review-receipt/${receiptId}`;
}

/**
 * SHA-256 digest of the canonical form of an identity object in hex. This is
 * the one trusted digest used by every repair identity and deduplication key;
 * values are always hex strings and are never echoed into public payloads.
 */
export async function deriveDigest(value: unknown): Promise<string> {
  const canonical = typeof value === "object" && value !== null
    ? canonicalStringify(value)
    : String(value);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
