/**
 * Repair and release state snapshots: the two separate record sets on the
 * sentinel-state/repair and sentinel-state/release branches. Only the repair
 * workflow writes work records, budget reservations and release requests; only
 * the release workflow writes release records. The snapshot self-describes the
 * state branch head it extends, enabling strict expected-head compare-and-swap.
 */

import type { GitSha } from "./brands.ts";
import { parseAttemptMemoryRecordV1 } from "./attempt-memory.ts";
import type { AttemptMemoryRecordV1 } from "./attempt-memory.ts";
import { parseMemoryLessonsRecordV1 } from "./memory-lessons.ts";
import type { MemoryLessonsRecordV1 } from "./memory-lessons.ts";
import { parseBudgetReservationV1 } from "./budget-reservation.ts";
import type { BudgetReservationV1 } from "./budget-reservation.ts";
import { parseGitHubCooldownV1 } from "./github-cooldown.ts";
import type { GitHubCooldownV1 } from "./github-cooldown.ts";
import {
  parseHostedReleaseRecordV1,
  parseHostedRuntimeRecordV1,
} from "./hosted-supervisor.ts";
import type {
  HostedReleaseRecordV1,
  HostedRuntimeRecordV1,
} from "./hosted-supervisor.ts";
import { parseIncidentEvidenceV1, parseIncidentSummaryV1 } from "./incident.ts";
import type { IncidentEvidenceV1, IncidentSummaryV1 } from "./incident.ts";
import { parseReleaseRecordV1, parseReleaseRequestV1 } from "./release.ts";
import type { ReleaseRecordV1, ReleaseRequestV1 } from "./release.ts";
import { parseReplayResultV1 } from "./replay-result.ts";
import type { ReplayResultV1 } from "./replay-result.ts";
import { parseReviewReceiptV1 } from "./review-receipt.ts";
import type { ReviewReceiptV1 } from "./review-receipt.ts";
import { parseWorkRecordV1 } from "./work-record.ts";
import type { WorkRecordV1 } from "./work-record.ts";
import {
  expectArray,
  expectCount,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNullable,
  expectRecord,
  expectTimestamp,
  expectVersion,
  fail,
  MaxItems,
} from "./validation.ts";

export interface RepairStateSnapshotV1 {
  version: "v1";
  kind: "repair_state_snapshot";
  /** State branch head this snapshot extends; null on branch creation. */
  stateHead: GitSha | null;
  sequence: number;
  updatedAt: number;
  incidents: IncidentSummaryV1[];
  evidence: IncidentEvidenceV1[];
  work: WorkRecordV1[];
  reservations: BudgetReservationV1[];
  reviews: ReviewReceiptV1[];
  replays: ReplayResultV1[];
  releaseRequests: ReleaseRequestV1[];
  githubCooldowns: GitHubCooldownV1[];
  /**
   * Durable attempt memory (the loop-breaker). One record per attempt family
   * — (repository, task, base, purpose) — each carrying bounded entries keyed
   * by the canonical attempt fingerprint. Written only by trusted repair
   * writers, appended in the same commit as the settlement it describes.
   */
  attemptMemory: AttemptMemoryRecordV1[];
  /**
   * Deterministic per-repository lesson digest (the curated long-term memory
   * view), recomputed by trusted writers from `attemptMemory`. It is a view,
   * never an authority: the source records stay the record of truth.
   */
  lessons: MemoryLessonsRecordV1[];
}

export interface ReleaseStateSnapshotV1 {
  version: "v1";
  kind: "release_state_snapshot";
  stateHead: GitSha | null;
  sequence: number;
  updatedAt: number;
  releases: ReleaseRecordV1[];
  /**
   * Hosted supervisor records (separate from Deno release records). The
   * runtime pointer is at most one record; hosted releases are one per exact
   * release request id. They persist in the same release state ref through
   * their own collections and never fabricate a ReleaseRecordV1.
   */
  hostedRuntimes: HostedRuntimeRecordV1[];
  hostedReleases: HostedReleaseRecordV1[];
  /**
   * Durable GitHub cooldowns observed by the release role (the hosted
   * supervisor records its own scope-0 hold here). Repair-role cooldowns stay
   * in the repair snapshot; the cross-role gates read both refs and never
   * drop either record. One record per affected installation.
   */
  githubCooldowns: GitHubCooldownV1[];
}

const REPAIR_KEYS = [
  "version",
  "kind",
  "stateHead",
  "sequence",
  "updatedAt",
  "incidents",
  "evidence",
  "work",
  "reservations",
  "reviews",
  "replays",
  "releaseRequests",
  "githubCooldowns",
  "attemptMemory",
  "lessons",
] as const;
const RELEASE_KEYS = [
  "version",
  "kind",
  "stateHead",
  "sequence",
  "updatedAt",
  "releases",
  "hostedRuntimes",
  "hostedReleases",
  "githubCooldowns",
] as const;

export function parseRepairStateSnapshotV1(
  input: unknown,
): RepairStateSnapshotV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, REPAIR_KEYS, "$");
  expectVersion(obj.version, "$.version");
  expectEnum(obj.kind, ["repair_state_snapshot"], "$.kind");

  const stateHead = expectNullable(obj.stateHead, "$.stateHead", expectGitSha);
  const sequence = expectCount(obj.sequence, "$.sequence");
  const updatedAt = expectTimestamp(obj.updatedAt, "$.updatedAt");

  const incidents = expectArray(
    obj.incidents,
    "$.incidents",
    MaxItems.snapshotRecords,
    parseIncidentSummaryV1,
  );
  const evidence = expectArray(
    obj.evidence,
    "$.evidence",
    MaxItems.snapshotRecords,
    parseIncidentEvidenceV1,
  );
  const work = expectArray(
    obj.work,
    "$.work",
    MaxItems.snapshotRecords,
    parseWorkRecordV1,
  );
  const reservations = expectArray(
    obj.reservations,
    "$.reservations",
    MaxItems.snapshotRecords,
    parseBudgetReservationV1,
  );
  const reviews = expectArray(
    obj.reviews,
    "$.reviews",
    MaxItems.snapshotRecords,
    parseReviewReceiptV1,
  );
  const replays = expectArray(
    obj.replays,
    "$.replays",
    MaxItems.snapshotRecords,
    parseReplayResultV1,
  );
  const releaseRequests = expectArray(
    obj.releaseRequests,
    "$.releaseRequests",
    MaxItems.snapshotRecords,
    parseReleaseRequestV1,
  );
  const githubCooldowns = expectArray(
    obj.githubCooldowns,
    "$.githubCooldowns",
    MaxItems.snapshotRecords,
    parseGitHubCooldownV1,
  );
  const attemptMemory = expectArray(
    obj.attemptMemory,
    "$.attemptMemory",
    MaxItems.snapshotRecords,
    parseAttemptMemoryRecordV1,
  );
  const lessons = expectArray(
    obj.lessons,
    "$.lessons",
    MaxItems.snapshotRecords,
    parseMemoryLessonsRecordV1,
  );

  // Frozen parsers reject duplicate ids instead of last-wins maps; a record
  // set that lost one of two same-id records is corrupted state, not a merge.
  expectUniqueIds(incidents, "$.incidents");
  expectUniqueIds(evidence, "$.evidence");
  expectUniqueIds(work, "$.work");
  expectUniqueIds(reservations, "$.reservations");
  expectUniqueIds(reviews, "$.reviews");
  expectUniqueIds(replays, "$.replays");
  expectUniqueIds(releaseRequests, "$.releaseRequests");
  expectUniqueIds(attemptMemory, "$.attemptMemory");
  expectUniqueIds(lessons, "$.lessons");
  // Cooldowns have no string id; one record per affected installation.
  expectUniqueInstallationIds(githubCooldowns, "$.githubCooldowns");

  return {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead,
    sequence,
    updatedAt,
    incidents,
    evidence,
    work,
    reservations,
    reviews,
    replays,
    releaseRequests,
    githubCooldowns,
    attemptMemory,
    lessons,
  };
}

export function parseReleaseStateSnapshotV1(
  input: unknown,
): ReleaseStateSnapshotV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, RELEASE_KEYS, "$");
  expectVersion(obj.version, "$.version");
  expectEnum(obj.kind, ["release_state_snapshot"], "$.kind");

  const stateHead = expectNullable(obj.stateHead, "$.stateHead", expectGitSha);
  const sequence = expectCount(obj.sequence, "$.sequence");
  const updatedAt = expectTimestamp(obj.updatedAt, "$.updatedAt");
  const releases = expectArray(
    obj.releases,
    "$.releases",
    MaxItems.snapshotRecords,
    parseReleaseRecordV1,
  );
  expectUniqueIds(releases, "$.releases");
  const hostedRuntimes = expectArray(
    obj.hostedRuntimes,
    "$.hostedRuntimes",
    MaxItems.snapshotRecords,
    parseHostedRuntimeRecordV1,
  );
  if (hostedRuntimes.length > 1) {
    fail(
      "$.hostedRuntimes",
      "invalid_lifecycle",
      "at most one hosted runtime pointer record is representable",
    );
  }
  expectUniqueIds(hostedRuntimes, "$.hostedRuntimes");
  const hostedReleases = expectArray(
    obj.hostedReleases,
    "$.hostedReleases",
    MaxItems.snapshotRecords,
    parseHostedReleaseRecordV1,
  );
  expectUniqueIds(hostedReleases, "$.hostedReleases");
  const githubCooldowns = expectArray(
    obj.githubCooldowns,
    "$.githubCooldowns",
    MaxItems.snapshotRecords,
    parseGitHubCooldownV1,
  );
  // Cooldowns have no string id; one record per affected installation.
  expectUniqueInstallationIds(githubCooldowns, "$.githubCooldowns");

  return {
    version: "v1",
    kind: "release_state_snapshot",
    stateHead,
    sequence,
    updatedAt,
    releases,
    hostedRuntimes,
    hostedReleases,
    githubCooldowns,
  };
}

function expectUniqueIds(
  records: readonly { id: string }[],
  path: string,
): void {
  const seen = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (seen.has(record.id)) {
      fail(
        `${path}[${index}].id`,
        "invalid_lifecycle",
        "duplicate record id",
      );
    }
    seen.add(record.id);
  }
}

/** One durable cooldown per affected installation; duplicates are corruption. */
function expectUniqueInstallationIds(
  records: readonly GitHubCooldownV1[],
  path: string,
): void {
  const seen = new Set<number>();
  for (const [index, record] of records.entries()) {
    if (seen.has(record.installationId)) {
      fail(
        `${path}[${index}].installationId`,
        "invalid_lifecycle",
        "duplicate installation id",
      );
    }
    seen.add(record.installationId);
  }
}
