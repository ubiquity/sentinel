import { deriveReservationId } from "../src/budget/mod.ts";
import type { BudgetReservationV1 } from "../src/contracts/budget-reservation.ts";
import { canonicalStringifySha256 } from "../src/contracts/canonical.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import {
  candidateBranch,
  implementationIntentKey,
} from "../src/repair/keys.ts";

export interface RuntimeMismatchBindingV1 {
  readonly id: string;
  readonly reservationId: string;
  readonly repository: { owner: string; name: string; installationId: number };
  readonly base: string;
  readonly branch: string;
  readonly requestId: string;
  readonly intentKey: string;
  readonly purpose: "retry" | "implementation";
  readonly recordDigest: string;
  readonly reservationDigest: string;
  readonly producerRun: string;
  readonly producerAttempt: number;
  readonly producerTerminal: boolean;
}

export interface RuntimeMismatchProofV1 {
  readonly publicationRefs: readonly string[];
  readonly preservationRefs: readonly string[];
  readonly headRefs: readonly string[];
  readonly prObservations: readonly {
    readonly number: number;
    readonly state: string;
    readonly head: string | null;
  }[];
  readonly effectDisposition: {
    readonly operation: string;
    readonly evidence: string;
  } | null;
  readonly exclusiveCustody: boolean;
}

export interface RuntimeMismatchPlanInputV1 {
  readonly repair: unknown;
  readonly release: unknown;
  readonly bindings: readonly RuntimeMismatchBindingV1[];
  readonly proofs: Readonly<Record<string, RuntimeMismatchProofV1>>;
  readonly expectedRepairHead: string | null;
  readonly expectedReleaseHead: string | null;
  readonly expectedSequence: number;
  readonly now: number;
}

export interface RuntimeMismatchProposalV1 {
  readonly id: string;
  readonly casBase: string;
  readonly settleReservation: {
    readonly reservationId: string;
    readonly outcome: "ambiguous";
  };
  readonly replacementBlocker: {
    readonly kind: string;
    readonly message: string;
  };
}

export type RuntimeMismatchPlanV1 =
  | { ok: true; proposals: readonly RuntimeMismatchProposalV1[] }
  | {
    ok: false;
    refused: string;
    rows: readonly { id: string; reason: string }[];
  };

export async function planRuntimeMismatchRecovery(
  input: RuntimeMismatchPlanInputV1,
): Promise<RuntimeMismatchPlanV1> {
  const rows: { id: string; reason: string }[] = [];
  const refuse = (
    id: string,
    reason: string,
  ): RuntimeMismatchPlanV1 => {
    rows.push({ id, reason });
    return { ok: false, refused: "binding failed", rows };
  };

  let repair: RepairStateSnapshotV1;
  let release: ReleaseStateSnapshotV1;
  try {
    repair = parseRepairStateSnapshotV1(input.repair);
  } catch {
    return { ok: false, refused: "invalid repair snapshot", rows };
  }
  try {
    release = parseReleaseStateSnapshotV1(input.release);
  } catch {
    return { ok: false, refused: "invalid release snapshot", rows };
  }
  void release;

  if (input.bindings.length === 0 || input.bindings.length > 36) {
    return { ok: false, refused: "binding count out of range", rows };
  }
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    return { ok: false, refused: "invalid clock", rows };
  }

  const workIds = new Set<string>();
  for (const record of repair.work) {
    const key = String(record.id);
    if (workIds.has(key)) {
      return { ok: false, refused: "duplicate work id", rows };
    }
    workIds.add(key);
  }
  const reservationIds = new Set<string>();
  for (const row of repair.reservations) {
    const key = String(row.id);
    if (reservationIds.has(key)) {
      return { ok: false, refused: "duplicate reservation id", rows };
    }
    reservationIds.add(key);
    if (
      row.outcome === "reserved" &&
      (row.settledAt !== null || row.proofRef !== null)
    ) {
      return { ok: false, refused: "reserved lifecycle invalid", rows };
    }
  }

  const workById = new Map<string, WorkRecordV1>(
    repair.work.map((record) => [String(record.id), record]),
  );
  const reservationById = new Map<string, BudgetReservationV1>(
    repair.reservations.map((row) => [String(row.id), row]),
  );

  const seen = new Set<string>();
  const proposals: RuntimeMismatchProposalV1[] = [];
  for (const binding of input.bindings) {
    if (seen.has(binding.id)) return refuse(binding.id, "duplicate binding");
    seen.add(binding.id);

    const record = workById.get(binding.id);
    if (record === undefined) return refuse(binding.id, "missing record");
    if (!/^[0-9a-f]{64}$/.test(binding.recordDigest)) {
      return refuse(binding.id, "malformed record digest");
    }
    if (await canonicalStringifySha256(record) !== binding.recordDigest) {
      return refuse(binding.id, "record digest mismatch");
    }
    if (record.nextStep !== "blocked") {
      return refuse(binding.id, "record not blocked");
    }
    const blockerMessage = String(record.blocker?.message ?? "");
    if (
      !blockerMessage.startsWith(
        "authenticated historical matrix runtime mismatch",
      )
    ) {
      return refuse(binding.id, "not runtime-mismatch blocked");
    }
    const intent = record.intent;
    if (intent?.kind !== "implementation") {
      return refuse(binding.id, "not implementation intent");
    }
    if (intent.requestId !== binding.requestId) {
      return refuse(binding.id, "request id mismatch");
    }
    if (intent.key !== binding.intentKey) {
      return refuse(binding.id, "intent key mismatch");
    }
    if (intent.key !== implementationIntentKey(binding.reservationId)) {
      return refuse(binding.id, "native intent key mismatch");
    }
    if (record.target.branch !== binding.branch) {
      return refuse(binding.id, "branch mismatch");
    }
    if (record.target.branch !== candidateBranch(binding.id as never)) {
      return refuse(binding.id, "native branch mismatch");
    }
    if (record.target.base !== binding.base) {
      return refuse(binding.id, "base mismatch");
    }
    if (intent.observedBase !== binding.base) {
      return refuse(binding.id, "intent base mismatch");
    }
    if (record.target.head !== null) {
      return refuse(binding.id, "candidate-bearing record excluded");
    }
    const repo = record.repository;
    if (
      repo.owner !== binding.repository.owner ||
      repo.name !== binding.repository.name ||
      repo.installationId !== binding.repository.installationId
    ) {
      return refuse(binding.id, "repository scope mismatch");
    }

    const reservation = reservationById.get(binding.reservationId);
    if (reservation === undefined) {
      return refuse(binding.id, "missing reservation");
    }
    if (!/^[0-9a-f]{64}$/.test(binding.reservationDigest)) {
      return refuse(binding.id, "malformed reservation digest");
    }
    if (
      await canonicalStringifySha256(reservation) !== binding.reservationDigest
    ) {
      return refuse(binding.id, "reservation digest mismatch");
    }
    if (String(reservation.taskId) !== binding.id) {
      return refuse(binding.id, "reservation task mismatch");
    }
    if (reservation.purpose !== binding.purpose) {
      return refuse(binding.id, "reservation purpose mismatch");
    }
    if (reservation.outcome !== "reserved") {
      return refuse(binding.id, "reservation not reserved");
    }
    const derivedId = await deriveReservationId({
      repository: reservation.repository,
      taskId: reservation.taskId,
      head: reservation.head,
      attempt: reservation.attempt,
      purpose: reservation.purpose,
    });
    if (derivedId !== reservation.id) {
      return refuse(binding.id, "native reservation id mismatch");
    }

    const proof = input.proofs[binding.id];
    if (proof === undefined) return refuse(binding.id, "missing proof");
    if (!binding.producerTerminal) {
      return refuse(binding.id, "producer not terminal");
    }
    if (proof.publicationRefs.length > 0 || proof.preservationRefs.length > 0) {
      return refuse(binding.id, "candidate refs present");
    }
    if (proof.headRefs.length > 0) {
      return refuse(binding.id, "head refs present");
    }
    if (proof.prObservations.length > 0) {
      return refuse(binding.id, "PR observations present");
    }
    if (proof.effectDisposition === null) {
      return refuse(binding.id, "missing effect disposition");
    }
    if (!proof.exclusiveCustody) {
      return refuse(binding.id, "custody not exclusive");
    }

    proposals.push({
      id: binding.id,
      casBase: input.expectedRepairHead ?? "unknown",
      settleReservation: {
        reservationId: binding.reservationId,
        outcome: "ambiguous",
      },
      replacementBlocker: {
        kind: "other",
        message: "model run did not complete with a trusted candidate",
      },
    });
  }

  return { ok: true, proposals };
}
