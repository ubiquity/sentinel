/**
 * BudgetReservationV1: durable model-start admission record. A reservation is
 * persisted before any invocation; persistence failure prevents invocation.
 * Outcomes: "reserved" (pending start), "submitted" (invocation confirmed),
 * "ambiguous" (submission could not be confirmed — remains charged), and
 * "confirmed_not_submitted" (proven not submitted — the only uncharged
 * terminal, and it requires a proof ref).
 */

import { asWorkItemId } from "./brands.ts";
import type { GitSha, WorkItemId } from "./brands.ts";
import { parseRepositoryIdentity } from "./shared.ts";
import type { RepositoryIdentityV1 } from "./shared.ts";
import {
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectPattern,
  expectPositiveInt,
  expectRecord,
  expectTimestamp,
  expectVersion,
  fail,
  MaxText,
} from "./validation.ts";

export type ReservationPurposeV1 =
  | "implementation"
  | "continuation"
  | "retry"
  | "review_request";
export type ReservationOutcomeV1 =
  | "reserved"
  | "submitted"
  | "ambiguous"
  | "confirmed_not_submitted";

export interface BudgetReservationV1 {
  version: "v1";
  kind: "budget_reservation";
  /** Repository the reservation is charged against (shared across repos). */
  repository: RepositoryIdentityV1;
  id: string;
  taskId: WorkItemId;
  /** One-based attempt index: the first reservation for a task is attempt 1. */
  attempt: number;
  /** Repository head (target SHA) the session was started against. */
  head: GitSha;
  purpose: ReservationPurposeV1;
  createdAt: number;
  outcome: ReservationOutcomeV1;
  /** When the outcome became known; null while still reserved. */
  settledAt: number | null;
  /** Ref proving "confirmed_not_submitted" (reconciled external state). */
  proofRef: string | null;
}

const KEYS = [
  "version",
  "kind",
  "repository",
  "id",
  "taskId",
  "attempt",
  "head",
  "purpose",
  "createdAt",
  "outcome",
  "settledAt",
  "proofRef",
] as const;

export function parseBudgetReservationV1(input: unknown): BudgetReservationV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, KEYS, "$");
  expectVersion(obj.version, "$.version");
  expectEnum(obj.kind, ["budget_reservation"], "$.kind");

  const repository = parseRepositoryIdentity(obj.repository, "$.repository");
  const id = expectNonEmptyString(obj.id, "$.id", MaxText.recordId);
  const taskId = asWorkItemId(
    expectPattern(
      obj.taskId,
      "$.taskId",
      /^[A-Za-z0-9._:-]{1,256}$/,
      "invalid_pattern",
      "expected deterministic work item id",
      MaxText.recordId,
    ),
  );
  const attempt = expectPositiveInt(obj.attempt, "$.attempt");
  const head = expectGitSha(obj.head, "$.head");
  const purpose = expectEnum(
    obj.purpose,
    ["implementation", "continuation", "retry", "review_request"],
    "$.purpose",
  );
  const createdAt = expectTimestamp(obj.createdAt, "$.createdAt");
  const outcome = expectEnum(
    obj.outcome,
    ["reserved", "submitted", "ambiguous", "confirmed_not_submitted"],
    "$.outcome",
  );
  const settledAt = expectNullableTimestamp(obj.settledAt, "$.settledAt");
  const proofRef = expectNullableString(
    obj.proofRef,
    "$.proofRef",
    MaxText.ref,
  );

  if (outcome === "reserved") {
    if (settledAt !== null) {
      fail(
        "$.settledAt",
        "invalid_lifecycle",
        "reserved reservation has no settlement time",
      );
    }
  } else {
    if (settledAt === null) {
      fail(
        "$.settledAt",
        "invalid_lifecycle",
        "settled outcome requires a settlement time",
      );
    }
    if (settledAt < createdAt) {
      fail(
        "$.settledAt",
        "invalid_lifecycle",
        "settlement cannot precede creation",
      );
    }
  }
  if (outcome === "confirmed_not_submitted" && proofRef === null) {
    fail(
      "$.proofRef",
      "invalid_lifecycle",
      "confirmed_not_submitted requires a proof ref",
    );
  }
  if (outcome !== "confirmed_not_submitted" && proofRef !== null) {
    fail(
      "$.proofRef",
      "invalid_lifecycle",
      "proof ref is only valid for confirmed_not_submitted",
    );
  }

  return {
    version: "v1",
    kind: "budget_reservation",
    repository,
    id,
    taskId,
    attempt,
    head,
    purpose,
    createdAt,
    outcome,
    settledAt,
    proofRef,
  };
}

function expectNullableTimestamp(value: unknown, path: string): number | null {
  if (value === null) return null;
  return expectTimestamp(value, path);
}

function expectNullableString(
  value: unknown,
  path: string,
  maxLength: number,
): string | null {
  if (value === null) return null;
  return expectNonEmptyString(value, path, maxLength);
}
