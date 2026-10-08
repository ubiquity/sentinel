/** Fail closed per authenticated historical wave without refunding its admission. */
import { canonicalStringify } from "../contracts/canonical.ts";
import type {
  Clock,
  RepairStateWriter,
  StateReadView,
} from "../contracts/ports.ts";
import { markBlocked } from "../repair/transitions.ts";
import {
  MATRIX_ARTIFACT_RECOVERY_MAX_MS,
  type MatrixArtifactTransportV1,
  MatrixHistoricalRuntimeMismatch,
} from "./matrix-artifact-port.ts";

export async function recoverWithHistoricalIsolation(
  deps: { state: StateReadView & RepairStateWriter; clock: Clock },
  transport: MatrixArtifactTransportV1,
  input: Parameters<MatrixArtifactTransportV1["recover"]>[0],
) {
  const deadline = Math.min(
    deps.clock.now() + MATRIX_ARTIFACT_RECOVERY_MAX_MS,
    input.deadline ?? Number.POSITIVE_INFINITY,
  );
  if (!Number.isSafeInteger(deadline)) {
    throw new Error("invalid matrix recovery deadline");
  }
  let requests = [...input.requests];
  while (requests.length > 0 && deps.clock.now() < deadline) {
    try {
      return await transport.recover({ ...input, requests, deadline });
    } catch (error) {
      // A timeout, absent artifact or generic provenance refusal never grants
      // this disposition. The transport emits it only after authenticating
      // the entire selected historical wave against its own native runtime.
      if (!(error instanceof MatrixHistoricalRuntimeMismatch)) throw error;
      const evidence = error.evidence;
      if (
        input.currentRun !== undefined || !input.consumerRun ||
        canonicalStringify(input.consumerRun) !==
          canonicalStringify(evidence.consumerRun) ||
        evidence.expectedRuntimeSha !== input.runtimeSha ||
        evidence.runtimeSha === input.runtimeSha ||
        (evidence.run.runId === input.consumerRun.runId &&
          evidence.run.runAttempt === input.consumerRun.runAttempt) ||
        evidence.affected.length === 0
      ) throw new Error("historical runtime isolation identity changed");
      const read = await deps.state.readRepair();
      if (
        !read.ok || read.value.status !== "found" ||
        read.value.head !== evidence.repairHead
      ) {
        throw new Error("historical runtime isolation custody changed");
      }
      const captured = new Map(
        evidence.affected.map((entry) => [entry.reservation.id, entry]),
      );
      if (captured.size !== evidence.affected.length) {
        throw new Error("duplicate historical runtime isolation");
      }
      for (const entry of captured.values()) {
        const request = requests.find((row) =>
          row.reservationId === entry.reservation.id
        );
        const work = read.value.snapshot.work.find((row) =>
          row.id === entry.work.id &&
          canonicalStringify(row.repository) ===
            canonicalStringify(entry.work.repository)
        );
        const reservation = read.value.snapshot.reservations.find((row) =>
          row.id === entry.reservation.id
        );
        if (
          !request || request.taskId !== entry.work.id ||
          work?.nextStep !== "work" ||
          work.intent?.requestId !== entry.reservation.id ||
          canonicalStringify(work) !== canonicalStringify(entry.work) ||
          canonicalStringify(reservation) !==
            canonicalStringify(entry.reservation)
        ) {
          throw new Error("historical runtime isolation admission changed");
        }
      }
      const now = deps.clock.now();
      const write = await deps.state.writeRepair({
        ...read.value.snapshot,
        stateHead: read.value.head,
        sequence: read.value.snapshot.sequence + 1,
        updatedAt: now,
        work: read.value.snapshot.work.map((work) => {
          const entry = captured.get(work.intent?.requestId ?? "");
          return entry && work.id === entry.work.id &&
              canonicalStringify(work.repository) ===
                canonicalStringify(entry.work.repository)
            ? markBlocked(
              work,
              "other",
              `authenticated historical matrix runtime mismatch; producer=${evidence.run.runId}:${evidence.run.runAttempt}; runtime=${evidence.runtimeSha}; plan=${evidence.planDigest}; artifact=${evidence.planArtifactId}; archive=${evidence.planArchiveDigest}; planner=${evidence.plannerJobId}; result=${entry.cell.resultDigest}; original admission retained`,
              now,
            )
            : work;
        }),
      }, read.value.head);
      if (!write.ok || write.value.status !== "applied") {
        throw new Error("historical runtime isolation CAS incomplete");
      }
      requests = requests.filter((request) =>
        !captured.has(request.reservationId)
      );
      // The next recovery can only inspect remaining grants. Rejected results
      // and bundles never reach an ingestion or publication consumer.
    }
  }
  return [];
}
