import type { BudgetReservationV1 } from "../src/contracts/budget-reservation.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";

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
  readonly repair: RepairStateSnapshotV1;
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

function digestOf(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0;
  for (let index = 0; index < text.length; index++) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return "h" + Math.abs(hash).toString(16);
}

export function planRuntimeMismatchRecovery(
  input: RuntimeMismatchPlanInputV1,
): Promise<RuntimeMismatchPlanV1> {
  return Promise.resolve(planSync(input));
}

function planSync(input: RuntimeMismatchPlanInputV1): RuntimeMismatchPlanV1 {
  const rows: { id: string; reason: string }[] = [];
  const refuse = (id: string, reason: string): RuntimeMismatchPlanV1 => {
    rows.push({ id, reason });
    return { ok: false, refused: "binding failed", rows };
  };

  if (input.bindings.length === 0 || input.bindings.length > 36) {
    return { ok: false, refused: "binding count out of range", rows };
  }
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    return { ok: false, refused: "invalid clock", rows };
  }

  const seen = new Set<string>();
  const workById = new Map<string, WorkRecordV1>(
    input.repair.work.map((record) => [String(record.id), record]),
  );
  const reservationById = new Map<string, BudgetReservationV1>(
    input.repair.reservations.map((row) => [String(row.id), row]),
  );

  const proposals: RuntimeMismatchProposalV1[] = [];
  for (const binding of input.bindings) {
    if (seen.has(binding.id)) return refuse(binding.id, "duplicate binding");
    seen.add(binding.id);

    const record = workById.get(binding.id);
    if (record === undefined) return refuse(binding.id, "missing record");
    if (digestOf(record) !== binding.recordDigest) {
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
    if (record.target.branch !== binding.branch) {
      return refuse(binding.id, "branch mismatch");
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
    if (digestOf(reservation) !== binding.reservationDigest) {
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
