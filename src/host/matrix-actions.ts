/** Native Actions matrix executable and trusted serial aggregate composition. */
import { canonicalStringify } from "../contracts/canonical.ts";
import {
  type MatrixCellGrantV1,
  type MatrixCellResultV1,
  matrixDigestV1,
  type MatrixPlanV1,
  MAX_MATRIX_ARTIFACT_BYTES,
  tryParseMatrixPlanV1,
} from "../contracts/matrix.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import {
  createRunBounds,
  prepareMatrixIntakeV1,
  type RepairCycleDepsV1,
} from "../repair/loop.ts";
import {
  type ActionsRepairHostDepsV1,
  type ActionsTargetCyclesInputV1,
  type ActionsTargetCyclesResultV1,
  childRunDeadlineV1,
  runActionsRepairHost,
  runActionsTargetCycles,
} from "./actions.ts";
import {
  ingestMatrixResults,
  type MatrixPlanReportV1,
  runMatrixCell,
  runMatrixPlanEntrypoint,
} from "./matrix.ts";
import {
  createGitBundleExporter,
  createGitBundleImporter,
} from "./matrix-git.ts";
import type {
  MatrixArtifactTransportV1,
  MatrixRejectedWaveV1,
} from "./matrix-artifact-port.ts";
import type { BudgetControllerV1 } from "../budget/mod.ts";
import type {
  Clock,
  PortResultV1,
  RepairStateWriter,
  StateReadView,
} from "../contracts/ports.ts";
import {
  HOSTED_RUNTIME_ID,
  type HostedExecutionIntentV1,
  type HostedExecutionSettlementV1,
  type HostedRunProofV1,
  parseHostedExecutionSettlementV1,
  parseHostedRunProofV1,
} from "../contracts/hosted-supervisor.ts";
import { markBlocked } from "../repair/transitions.ts";
import { implementationIntentKey } from "../repair/keys.ts";
import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import type { GitSha } from "../contracts/brands.ts";
import {
  closedCWaveHandledReservations,
  closedCWaveNeedsRecovery,
  ingestClosedCWave,
} from "./modern-matrix-recovery.ts";

export const HISTORICAL_MATRIX_QUARANTINE =
  "authenticated historical matrix manifest rejected: reservation_after_manifest; model outcome uncertain";

export interface HistoricalMatrixQuarantineDepsV1 {
  state: StateReadView & RepairStateWriter;
  clock: Clock;
  budget: Pick<BudgetControllerV1, "settleModelStart">;
  transport: MatrixArtifactTransportV1;
  /** Closed owner-selected release witnesses; never a history scan or fallback. */
  historicalReleaseWitnesses?: readonly {
    commit: GitSha;
    executionId: string;
    logDigest: string;
    reservationIds: readonly string[];
    reject(
      proof: HostedRunProofV1,
      expectedHead: GitSha,
    ): Promise<readonly MatrixRejectedWaveV1[]>;
  }[];
  readExecution(
    execution: HostedExecutionIntentV1,
  ): Promise<PortResultV1<HostedExecutionSettlementV1 | null>>;
}
interface HistoricalProofCustodyV1 {
  commit: GitSha;
  expectedHead: GitSha;
  proofDigest: string;
}
function reservationIdentity(row: BudgetReservationV1) {
  return canonicalStringify({
    ...row,
    outcome: "reserved",
    settledAt: null,
    proofRef: null,
  });
}
async function proofInCustody(
  deps: HistoricalMatrixQuarantineDepsV1,
  proof: HostedRunProofV1,
  current?: HostedExecutionIntentV1 | null,
  historical?: HistoricalProofCustodyV1,
) {
  const read = await deps.state.readRelease();
  if (!read.ok || read.value.status !== "found") return false;
  const runtime = read.value.snapshot.hostedRuntimes.find((row) =>
    row.id === HOSTED_RUNTIME_ID
  );
  const identity = canonicalStringify(proof.execution);
  if (
    current !== undefined &&
    canonicalStringify(runtime?.execution ?? null) !==
      canonicalStringify(current)
  ) return false;
  if (historical) {
    if (
      read.value.head !== historical.expectedHead ||
      !deps.state.readReleaseAt
    ) return false;
    const saved = await deps.state.readReleaseAt(historical);
    if (
      !saved.ok || saved.value.status !== "found" ||
      saved.value.head !== historical.commit
    ) return false;
    const prior = saved.value.snapshot.hostedRuntimes.find((row) =>
      row.id === HOSTED_RUNTIME_ID
    )?.lastExecutionProof;
    if (
      !prior || prior.outcome === "not_started" ||
      await matrixDigestV1({ ...prior, observedAt: 0 }) !==
        historical.proofDigest ||
      canonicalStringify({ ...prior, observedAt: proof.observedAt }) !==
        canonicalStringify(proof)
    ) return false;
    // The exact completed native proof was authenticated once for this operation.
    // Its immutable bytes remain bound by the full historical digest and frozen head.
    return true;
  }
  if (
    runtime?.execution && canonicalStringify(runtime.execution) === identity
  ) return true;
  const prior = runtime?.lastExecutionProof;
  return prior !== null && prior !== undefined &&
    prior.outcome !== "not_started" &&
    canonicalStringify({ ...prior, observedAt: proof.observedAt }) ===
      canonicalStringify(proof);
}
async function quarantineRow(
  deps: HistoricalMatrixQuarantineDepsV1,
  wave: MatrixRejectedWaveV1,
  captured: MatrixRejectedWaveV1["affected"][number],
  currentExecution: HostedExecutionIntentV1 | null,
  historical?: HistoricalProofCustodyV1,
) {
  if (
    wave.reason !== "reservation_after_manifest" ||
    captured.work.nextStep !== "work" ||
    captured.work.intent?.kind !== "implementation" ||
    captured.work.target.candidateState !== undefined ||
    captured.work.intent.requestId !== captured.reservation.id ||
    captured.work.intent.key !==
      implementationIntentKey(captured.reservation.id) ||
    captured.work.intent.observedBase !== captured.reservation.head ||
    captured.work.target.base !== captured.reservation.head ||
    captured.work.counters.attempts !== captured.reservation.attempt ||
    captured.work.id !== captured.reservation.taskId ||
    captured.request.taskId !== captured.work.id ||
    captured.request.base !== captured.work.target.base ||
    canonicalStringify(captured.work.repository) !==
      canonicalStringify(captured.reservation.repository) ||
    canonicalStringify(captured.work.repository) !==
      canonicalStringify(captured.request.repository) ||
    await matrixDigestV1(captured.request) !== captured.requestDigest ||
    await matrixDigestV1(captured.work) !== captured.workDigest ||
    await matrixDigestV1(captured.reservation) !== captured.reservationDigest ||
    !await proofInCustody(deps, wave.proof, currentExecution, historical)
  ) throw new Error("historical matrix custody unavailable");
  const read = await deps.state.readRepair();
  if (!read.ok || read.value.status !== "found") {
    throw new Error("historical matrix state unavailable");
  }
  const work = read.value.snapshot.work.find((row) =>
    row.id === captured.work.id &&
    canonicalStringify(row.repository) ===
      canonicalStringify(captured.work.repository)
  );
  const reservation = read.value.snapshot.reservations.find((row) =>
    row.id === captured.reservation.id
  );
  if (
    !work || !reservation || work.nextStep !== "work" ||
    work.intent?.kind !== "implementation" ||
    work.target.candidateState !== undefined ||
    await matrixDigestV1(work) !== captured.workDigest ||
    await matrixDigestV1(reservation) !== captured.reservationDigest ||
    (reservation.outcome !== "reserved" && reservation.outcome !== "ambiguous")
  ) {
    throw new Error("historical matrix captured identity changed");
  }
  if (!await proofInCustody(deps, wave.proof, currentExecution, historical)) {
    throw new Error("historical matrix pre-settlement custody unavailable");
  }
  const settled = await deps.budget.settleModelStart({
    id: reservation.id,
    outcome: "ambiguous",
    proofRef: null,
  });
  if (
    (settled.status !== "settled" && settled.status !== "idempotent") ||
    settled.reservation.outcome !== "ambiguous" ||
    settled.reservation.settledAt === null ||
    settled.reservation.proofRef !== null ||
    reservationIdentity(settled.reservation) !==
      reservationIdentity(reservation)
  ) {
    throw new Error("historical matrix settlement incomplete");
  }
  const fresh = await deps.state.readRepair();
  if (
    !fresh.ok || fresh.value.status !== "found" ||
    !await proofInCustody(deps, wave.proof, currentExecution, historical)
  ) {
    throw new Error("historical matrix post-settlement custody unavailable");
  }
  const current = fresh.value.snapshot.work.find((row) =>
    row.id === work.id &&
    canonicalStringify(row.repository) === canonicalStringify(work.repository)
  );
  const charged = fresh.value.snapshot.reservations.find((row) =>
    row.id === reservation.id
  );
  if (
    !current || await matrixDigestV1(current) !== captured.workDigest ||
    !charged ||
    canonicalStringify(charged) !== canonicalStringify(settled.reservation)
  ) {
    throw new Error("historical matrix post-settlement identity changed");
  }
  const now = deps.clock.now();
  if (!Number.isSafeInteger(now) || now < fresh.value.snapshot.updatedAt) {
    throw new Error("historical matrix clock unavailable");
  }
  const blocked = markBlocked(
    current,
    "other",
    HISTORICAL_MATRIX_QUARANTINE,
    now,
  );
  if (!await proofInCustody(deps, wave.proof, currentExecution, historical)) {
    throw new Error("historical matrix pre-block custody unavailable");
  }
  const write = await deps.state.writeRepair({
    ...fresh.value.snapshot,
    stateHead: fresh.value.head,
    sequence: fresh.value.snapshot.sequence + 1,
    updatedAt: now,
    work: fresh.value.snapshot.work.map((row) =>
      row === current ? blocked : row
    ),
  }, fresh.value.head);
  if (!write.ok || write.value.status !== "applied") {
    throw new Error("historical matrix block incomplete");
  }
  const verified = await deps.state.readRepair();
  if (
    !verified.ok || verified.value.status !== "found" ||
    !await proofInCustody(deps, wave.proof, currentExecution, historical) ||
    canonicalStringify(
        verified.value.snapshot.work.find((row) =>
          row.id === work.id &&
          canonicalStringify(row.repository) ===
            canonicalStringify(work.repository)
        ),
      ) !== canonicalStringify(blocked) ||
    canonicalStringify(
        verified.value.snapshot.reservations.find((row) =>
          row.id === reservation.id
        ),
      ) !== canonicalStringify(charged)
  ) {
    throw new Error("historical matrix block readback incomplete");
  }
}
/** Protected repair-owner checkpoint; no model, release-write or ingestion capability. */
export async function runHistoricalMatrixQuarantine(
  deps: HistoricalMatrixQuarantineDepsV1,
): Promise<number> {
  const repair = await deps.state.readRepair();
  if (!repair.ok || repair.value.status !== "found") {
    throw new Error("historical matrix state unavailable");
  }
  const [witness, ...remainingWitnesses] = deps.historicalReleaseWitnesses ??
    [];
  if (witness) {
    const selected = repair.value.snapshot.work.filter((row) =>
      row.intent?.kind === "implementation" && row.nextStep !== "done" &&
      !(row.nextStep === "blocked" && row.blocker?.kind === "other" &&
        row.blocker.message === HISTORICAL_MATRIX_QUARANTINE) &&
      witness.reservationIds.some((id) =>
        row.intent?.requestId === id ||
        row.intent?.key === implementationIntentKey(id)
      )
    );
    if (selected.length === 0) {
      return runHistoricalMatrixQuarantine({
        ...deps,
        historicalReleaseWitnesses: remainingWitnesses,
      });
    }
    for (const work of selected) {
      const reservation = repair.value.snapshot.reservations.find((row) =>
        row.id === work.intent?.requestId
      );
      if (
        work.nextStep !== "work" || work.target.candidateState !== undefined ||
        !reservation || !witness.reservationIds.includes(reservation.id) ||
        work.intent?.key !== implementationIntentKey(reservation.id) ||
        canonicalStringify(work.repository) !==
          canonicalStringify(reservation.repository) ||
        (reservation.outcome !== "reserved" &&
          reservation.outcome !== "ambiguous")
      ) {
        throw new Error(
          "historical matrix selected reservation binding unavailable",
        );
      }
    }
  }
  if (
    !repair.value.snapshot.work.some((row) =>
      row.nextStep === "work" && row.intent?.kind === "implementation" &&
      row.target.candidateState === undefined
    )
  ) return 0;
  const release = await deps.state.readRelease();
  if (!release.ok || release.value.status !== "found") {
    throw new Error("historical matrix release unavailable");
  }
  const runtime = release.value.snapshot.hostedRuntimes.find((row) =>
    row.id === HOSTED_RUNTIME_ID
  );
  const current = runtime?.execution ?? null;
  let currentNative: HostedExecutionSettlementV1 | null = null;
  if (current !== null) {
    if (
      !deps.transport.confirmCompletedExecution ||
      !await deps.transport.confirmCompletedExecution(current)
    ) {
      throw new Error("historical matrix current native writers unsettled");
    }
    const observed = await deps.readExecution(current);
    if (!observed.ok || observed.value === null) {
      throw new Error(
        "historical matrix current native settlement unavailable",
      );
    }
    currentNative = parseHostedExecutionSettlementV1(observed.value);
    if (
      canonicalStringify(currentNative.execution) !==
        canonicalStringify(current)
    ) {
      throw new Error("historical matrix current native binding changed");
    }
  }
  const freshRelease = await deps.state.readRelease();
  if (!freshRelease.ok || freshRelease.value.status !== "found") {
    throw new Error("historical matrix saved custody unavailable");
  }
  const freshRuntime = freshRelease.value.snapshot.hostedRuntimes.find((row) =>
    row.id === HOSTED_RUNTIME_ID
  );
  if (
    canonicalStringify(freshRuntime?.execution ?? null) !==
      canonicalStringify(current)
  ) {
    throw new Error("historical matrix current custody changed");
  }
  const savedProof = freshRuntime?.lastExecutionProof;
  let historical: HistoricalProofCustodyV1 | undefined;
  let witnessedProof: HostedRunProofV1 | undefined;
  if (witness) {
    const saved = await deps.state.readReleaseAt?.({
      commit: witness.commit,
      expectedHead: freshRelease.value.head,
    });
    if (
      !saved?.ok || saved.value.status !== "found" ||
      saved.value.head !== witness.commit
    ) {
      throw new Error("historical matrix release witness unavailable");
    }
    const prior = saved.value.snapshot.hostedRuntimes.find((row) =>
      row.id === HOSTED_RUNTIME_ID
    )?.lastExecutionProof;
    if (
      !prior || prior.outcome === "not_started" ||
      prior.execution.purpose !== "ordinary" ||
      prior.execution.id !== witness.executionId ||
      prior.logDigest !== witness.logDigest
    ) {
      throw new Error("historical matrix release witness binding changed");
    }
    witnessedProof = parseHostedRunProofV1(prior);
    historical = {
      commit: witness.commit,
      expectedHead: freshRelease.value.head,
      proofDigest: await matrixDigestV1({ ...witnessedProof, observedAt: 0 }),
    };
  }
  const execution = witnessedProof?.execution ??
    (current?.purpose === "ordinary" && currentNative !== null &&
        currentNative.outcome !== "not_started"
      ? current
      : savedProof?.execution.purpose === "ordinary" &&
          savedProof.outcome !== "not_started"
      ? savedProof.execution
      : null);
  if (!execution) {
    const verification = current ?? savedProof?.execution;
    if (
      verification &&
      ["bootstrap", "prior", "candidate", "rollback"].includes(
        verification.purpose,
      )
    ) {
      if (
        freshRelease.value.head !== release.value.head ||
        canonicalStringify(freshRuntime) !== canonicalStringify(runtime)
      ) {
        throw new Error("historical matrix verification custody changed");
      }
      if (
        current === null && (!deps.transport.confirmCompletedExecution ||
          !await deps.transport.confirmCompletedExecution(verification))
      ) {
        throw new Error(
          "historical matrix verification completion unavailable",
        );
      }
      const observed = current !== null
        ? { ok: true as const, value: currentNative }
        : await deps.readExecution(verification);
      if (
        !observed.ok || observed.value === null ||
        observed.value.outcome === "not_started"
      ) {
        throw new Error("historical matrix verification proof unavailable");
      }
      const verificationProof = parseHostedRunProofV1(observed.value);
      if (
        canonicalStringify(verificationProof.execution) !==
          canonicalStringify(verification) ||
        (current === null &&
          (!savedProof || savedProof.outcome === "not_started" ||
            canonicalStringify({
                ...savedProof,
                observedAt: verificationProof.observedAt,
              }) !== canonicalStringify(verificationProof)))
      ) {
        throw new Error("historical matrix verification binding changed");
      }
      const [afterRelease, afterRepair] = await Promise.all([
        deps.state.readRelease(),
        deps.state.readRepair(),
      ]);
      if (
        !afterRelease.ok || afterRelease.value.status !== "found" ||
        afterRelease.value.head !== release.value.head ||
        canonicalStringify(
            afterRelease.value.snapshot.hostedRuntimes.find((row) =>
              row.id === HOSTED_RUNTIME_ID
            ),
          ) !== canonicalStringify(runtime) ||
        !afterRepair.ok || afterRepair.value.status !== "found" ||
        canonicalStringify(afterRepair.value.snapshot.work) !==
          canonicalStringify(repair.value.snapshot.work) ||
        canonicalStringify(afterRepair.value.snapshot.reservations) !==
          canonicalStringify(repair.value.snapshot.reservations)
      ) {
        throw new Error("historical matrix verification observation changed");
      }
      return 0;
    }
    throw new Error("historical matrix saved execution unavailable");
  }
  const native = currentNative &&
      canonicalStringify(execution) === canonicalStringify(current)
    ? { ok: true as const, value: currentNative }
    : await deps.readExecution(execution);
  if (
    !native.ok || native.value === null ||
    native.value.outcome === "not_started"
  ) {
    throw new Error("historical matrix native settlement unavailable");
  }
  const proof = parseHostedRunProofV1(native.value);
  if (
    canonicalStringify(proof.execution) !== canonicalStringify(execution) ||
    !await proofInCustody(deps, proof, current, historical) ||
    !deps.transport.rejectHistorical
  ) {
    throw new Error("historical matrix native custody unavailable");
  }
  const waves = historical
    ? await witness!.reject(
      proof,
      historical.expectedHead,
    )
    : await deps.transport.rejectHistorical({ proof });
  if (historical && waves.length === 0) {
    throw new Error("historical matrix selected witness rejection unavailable");
  }
  if (waves.length === 0) {
    const fresh = await deps.state.readRepair();
    if (
      !fresh.ok || fresh.value.status !== "found" ||
      !await proofInCustody(deps, proof, current, historical) ||
      canonicalStringify(fresh.value.snapshot.work) !==
        canonicalStringify(repair.value.snapshot.work) ||
      canonicalStringify(fresh.value.snapshot.reservations) !==
        canonicalStringify(repair.value.snapshot.reservations)
    ) throw new Error("historical matrix applicability changed");
  }
  let count = 0;
  for (const wave of waves) {
    if (
      canonicalStringify(wave.proof) !== canonicalStringify(proof) ||
      !/^[0-9a-f]{64}$/.test(wave.planDigest) ||
      !Number.isSafeInteger(wave.plannerJobId) || wave.plannerJobId <= 0
    ) {
      throw new Error("historical matrix rejection identity unavailable");
    }
    for (const captured of wave.affected) {
      if (
        witness && !witness.reservationIds.includes(captured.reservation.id)
      ) {
        throw new Error(
          "historical matrix rejection reservation outside witness",
        );
      }
      await quarantineRow(deps, wave, captured, current, historical);
      count++;
    }
  }
  if (!await proofInCustody(deps, proof, current, historical)) {
    throw new Error("historical matrix final custody changed");
  }
  if (historical) {
    count += await runHistoricalMatrixQuarantine({
      ...deps,
      historicalReleaseWitnesses: remainingWitnesses,
    });
  }
  return count;
}

export interface MatrixNativeCarrierV1 {
  /** Digest supplied by native needs.matrix_plan.outputs, outside artifact contents. */
  planDigest: string;
  /** Native matrix cell selection; absent in the serial aggregate job. */
  cellId?: string;
}
export interface ActionsMatrixHostDepsV1 extends ActionsRepairHostDepsV1 {
  carrier?: MatrixNativeCarrierV1;
  artifactTransport?: MatrixArtifactTransportV1;
}
function parseCarrier(value: unknown, cell: boolean): MatrixNativeCarrierV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("matrix native output carrier is malformed");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) =>
      key !== "planDigest" && key !== "cellId"
    ) ||
    typeof record.planDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.planDigest) ||
    (record.cellId !== undefined &&
      (typeof record.cellId !== "string" ||
        !/^[0-9a-f]{64}$/.test(record.cellId))) ||
    (cell && record.cellId === undefined)
  ) {
    throw new Error("matrix native output carrier is malformed");
  }
  return record as unknown as MatrixNativeCarrierV1;
}
/** Standard input is generated by the fixed workflow from native needs/matrix outputs. */
export async function readMatrixNativeCarrier(
  cell: boolean,
  allowEmpty = false,
): Promise<MatrixNativeCarrierV1 | undefined> {
  const bytes: Uint8Array[] = [];
  let size = 0;
  for await (const part of Deno.stdin.readable) {
    size += part.length;
    if (size > 4096) {
      throw new Error("matrix native output carrier is oversized");
    }
    bytes.push(part);
  }
  if (size === 0 && allowEmpty) return undefined;
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const part of bytes) {
    joined.set(part, offset);
    offset += part.length;
  }
  return parseCarrier(JSON.parse(new TextDecoder().decode(joined)), cell);
}
function hostOf(input: ActionsTargetCyclesInputV1) {
  if (input.host === undefined) {
    throw new Error("matrix host assembly is unavailable");
  }
  return input.host;
}
function targetDeps(
  input: ActionsTargetCyclesInputV1,
  config: RepositoryConfigV1,
): RepairCycleDepsV1 {
  return {
    clock: input.clock,
    state: input.state,
    configs: input.configs,
    controllerSha: input.controllerSha,
    github: input.composeGithub(config),
    githubCooldown: input.githubCooldown,
    incidents: input.incidents,
    replay: input.replay,
    model: input.model,
    budget: input.budget,
    externalImplementations: true,
  };
}
function configured(
  input: ActionsTargetCyclesInputV1,
  repository: MatrixCellGrantV1["cell"]["repository"],
) {
  const config = input.configs.find((entry) =>
    entry.repository.owner === repository.owner &&
    entry.repository.name === repository.name &&
    entry.repository.installationId === repository.installationId
  );
  if (config === undefined) {
    throw new Error("matrix grant repository is not configured");
  }
  return config;
}
async function readPlan(
  root: string,
  expectedDigest: string,
): Promise<MatrixPlanV1> {
  const path = root + "/plan.json";
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink || info.size > MAX_MATRIX_ARTIFACT_BYTES) {
    throw new Error("matrix plan file is invalid");
  }
  const parsed = tryParseMatrixPlanV1(
    JSON.parse(await Deno.readTextFile(path)),
  );
  if (!parsed.ok || await matrixDigestV1(parsed.value) !== expectedDigest) {
    throw new Error("matrix plan does not match the trusted native digest");
  }
  return parsed.value;
}
async function writeResult(
  root: string,
  result: MatrixCellResultV1,
): Promise<void> {
  await Deno.mkdir(root, { recursive: true, mode: 0o700 });
  const bytes = canonicalStringify(result) + "\n";
  if (new TextEncoder().encode(bytes).length > MAX_MATRIX_ARTIFACT_BYTES) {
    throw new Error("matrix result is oversized");
  }
  await Deno.writeTextFile(root + "/result.json", bytes, { mode: 0o600 });
  console.log(JSON.stringify({
    kind: "sentinel_matrix_cell",
    run: result.run,
    runtimeSha: result.runtimeSha,
    generation: result.generation,
    cellId: result.cellId,
    reservationId: result.reservationId,
    resultDigest: await matrixDigestV1(result),
    bundleDigest: result.bundle?.digest ?? null,
    status: result.status,
  }));
}
function disabledResult(
  grant: MatrixCellGrantV1,
  now: number,
): MatrixCellResultV1 {
  return {
    version: "v1",
    kind: "matrix_cell_result",
    waveId: grant.waveId,
    cellId: grant.cell.cellId,
    taskId: grant.cell.taskId,
    repository: grant.cell.repository,
    run: grant.run,
    runtimeSha: grant.cell.runtimeSha,
    generation: grant.cell.generation,
    reservationId: grant.cell.reservationId,
    intentKey: grant.cell.intentKey,
    requestDigest: grant.cell.requestDigest,
    status: "not_started",
    receipt: null,
    bundle: null,
    detail: "saved execution permits deterministic verification only",
    completedAt: now,
  };
}
/** This is the production composition invoked by import.meta.main below. */
export async function runActionsMatrixHost(
  deps: ActionsMatrixHostDepsV1 = {},
): Promise<
  (MatrixPlanReportV1 & { planDigest: string }) | MatrixCellResultV1
> {
  const job = deps.env === undefined
    ? Deno.env.get("GITHUB_JOB")
    : deps.env.GITHUB_JOB;
  if (job !== "matrix_plan" && job !== "matrix_cell") {
    throw new Error("matrix executable requires its native job identity");
  }
  const carrier = job === "matrix_cell"
    ? parseCarrier(deps.carrier ?? await readMatrixNativeCarrier(true), true)
    : null;
  let result:
    | (MatrixPlanReportV1 & { planDigest: string })
    | MatrixCellResultV1
    | null = null;
  await runActionsRepairHost({
    ...deps,
    job,
    runTargetCycles: async (input) => {
      const host = hostOf(input);
      if (job === "matrix_plan") {
        const deadline = Math.min(
          input.deadline,
          childRunDeadlineV1(host.execution.createdAt),
        );
        // Only source intake and fresh branch assignment precede the manifest.
        // The serialized aggregate retains unrelated lifecycle reconciliation.
        const cycles = await runActionsTargetCycles({
          ...input,
          deadline,
          modelStartsEnabled: false,
          externalImplementations: true,
          runCycle: async (deps, options) => {
            const outcome = await prepareMatrixIntakeV1(deps, {
              ...options,
              runStartedAt: host.execution.createdAt,
            });
            if (outcome.status === "state_error") {
              throw new Error("matrix intake authoritative state failed");
            }
            return outcome;
          },
        });
        const configs = input.configs.filter((config) =>
          cycles.addressed.includes(
            config.repository.owner + "/" + config.repository.name,
          )
        );
        const first = configs[0];
        if (first === undefined) {
          throw new Error("matrix planner addressed no configured target");
        }
        const pooled = { ...input, configs };
        result = await runMatrixPlanEntrypoint({
          deps: targetDeps(pooled, first),
          options: {
            waveId: host.execution.id,
            run: host.run,
            runtimeSha: input.controllerSha,
            generation: host.execution.generation,
            deadline,
            runStartedAt: host.execution.createdAt,
            plannedAt: input.clock.now(),
            modelStartsEnabled: input.modelStartsEnabled,
            githubForRepository: (repository) =>
              pooled.composeGithub(configured(pooled, repository)),
          },
          planPath: host.artifactRoot + "/plan.json",
        });
        const planned = result;
        const include = planned.plan.cells.map((cell) => ({
          cellId: cell.cellId,
          planDigest: planned.planDigest,
        }));
        const output = deps.env === undefined
          ? Deno.env.get("GITHUB_OUTPUT")
          : deps.env.GITHUB_OUTPUT;
        if (output === undefined || output.length === 0) {
          throw new Error("native matrix planner output is unavailable");
        }
        await Deno.writeTextFile(
          output,
          "matrix=" + JSON.stringify({ include }) + "\nplanDigest=" +
            result.planDigest + "\nhasCells=" + String(include.length > 0) +
            "\n",
          { append: true },
        );
        console.log(JSON.stringify({
          kind: "sentinel_matrix_plan",
          waveId: result.plan.waveId,
          run: host.run,
          runtimeSha: input.controllerSha,
          generation: host.execution.generation,
          planDigest: result.planDigest,
          prepared: result.prepared,
        }));
        return cycles;
      }
      if (carrier === null) {
        throw new Error("matrix cell lacks native selection");
      }
      const plan = await readPlan(host.artifactRoot, carrier.planDigest);
      if (
        plan.run.runId !== host.run.runId ||
        plan.run.runAttempt !== host.run.runAttempt ||
        plan.run.launcherSha !== host.run.launcherSha
      ) throw new Error("matrix plan belongs to another native execution");
      const cell = plan.cells.find((entry) => entry.cellId === carrier.cellId);
      if (cell === undefined) {
        throw new Error("native matrix cell is absent from its plan");
      }
      const grant: MatrixCellGrantV1 = {
        waveId: plan.waveId,
        run: plan.run,
        cell,
      };
      if (
        cell.runtimeSha !== input.controllerSha ||
        cell.generation !== host.execution.generation
      ) throw new Error("matrix cell runtime identity is stale");
      const config = configured(input, cell.repository);
      if (!input.modelStartsEnabled) {
        result = disabledResult(grant, input.clock.now());
      } else {
        await input.prepareTarget?.(config);
        const github = input.composeGithub(config);
        result = await runMatrixCell(
          {
            clock: input.clock,
            bounds: createRunBounds(targetDeps(input, config), {
              deadline: Math.min(
                input.deadline,
                childRunDeadlineV1(host.execution.createdAt),
              ),
              runStartedAt: host.execution.createdAt,
              modelStartsEnabled: input.modelStartsEnabled,
            }),
            sessionBound: config.sessionBound,
            state: {
              readRepair: () => input.state.readRepair(),
              readRelease: () => input.state.readRelease(),
            },
            github: { readIssue: (number) => github.readIssue(number) },
            model: input.model,
            bundle: createGitBundleExporter({
              repositoryDir: host.sourcePathFor(config),
              outputDir: host.artifactRoot,
            }),
          },
          grant,
          {
            run: host.run,
            runtimeSha: input.controllerSha,
            generation: host.execution.generation,
          },
          input.clock.now(),
        );
      }
      await writeResult(host.artifactRoot, result);
      return {
        outcome: { status: "idle", detail: "matrix cell settled" },
        addressed: [config.repository.owner + "/" + config.repository.name],
        skipped: [],
        failed: [],
      };
    },
  });
  if (result === null) throw new Error("matrix executable produced no result");
  return result;
}
async function transportFor(
  input: ActionsTargetCyclesInputV1,
  injected?: MatrixArtifactTransportV1,
): Promise<MatrixArtifactTransportV1> {
  if (injected !== undefined) return injected;
  return await hostOf(input).createArtifactTransport();
}
/** Authenticating/importing receipts precedes ordinary publication/review/delivery. */
export async function runActionsMatrixAggregateCycles(
  input: ActionsTargetCyclesInputV1,
  injectedTransport?: MatrixArtifactTransportV1,
  carrier?: MatrixNativeCarrierV1,
): Promise<ActionsTargetCyclesResultV1> {
  const host = hostOf(input);
  let read = await input.state.readRepair();
  if (!read.ok || read.value.status !== "found") {
    throw new Error("matrix aggregate cannot read authoritative state");
  }
  if (closedCWaveNeedsRecovery(read.value.snapshot)) {
    if (!host.readExecution) {
      throw new Error("C recovery native proof reader unavailable");
    }
    const recovered = await ingestClosedCWave({
      state: input.state,
      clock: input.clock,
      configs: input.configs,
      cycleFor: (config) => targetDeps(input, config),
      prepareTarget: async (config) => {
        await input.prepareTarget?.(config);
      },
      importerFor: (config, bundlesDir) =>
        createGitBundleImporter({
          repositoryDir: host.sourcePathFor(config),
          bundlesDir,
        }),
      transportFor: (state) => host.createArtifactTransport(state),
      readExecution: host.readExecution,
    }, false);
    console.log(
      JSON.stringify({ kind: "sentinel_closed_c_recovery", ...recovered }),
    );
    read = await input.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("C recovery readback unavailable");
    }
  }
  const handled = closedCWaveHandledReservations(read.value.snapshot);
  const requests = read.value.snapshot.work.flatMap((record) => {
    const intent = record.intent;
    if (
      record.nextStep !== "work" ||
      (intent?.kind !== "implementation" &&
        intent?.kind !== "candidate_preservation") ||
      intent.requestId === null || handled.has(intent.requestId)
    ) {
      return [];
    }
    return [{
      taskId: record.id,
      repository: record.repository,
      reservationId: intent.requestId,
      intentKey: intent.key,
      expectedBase: record.target.base,
      attempt: record.counters.attempts,
    }];
  });
  const transport = await transportFor(input, injectedTransport);
  const waves = await transport.recover({
    requests,
    runtimeSha: input.controllerSha,
    launcherSha: host.run.launcherSha,
    ...(carrier === undefined ? {} : { currentRun: host.run }),
  });
  for (const wave of waves) {
    if (
      await matrixDigestV1(wave.plan) !== wave.planDigest ||
      wave.plan.run.runId !== wave.provenance.run.runId ||
      wave.plan.run.runAttempt !== wave.provenance.run.runAttempt ||
      wave.plan.run.launcherSha !== wave.provenance.run.launcherSha ||
      !Number.isSafeInteger(wave.provenance.plannerJobId) ||
      wave.provenance.plannerJobId <= 0
    ) {
      throw new Error("matrix artifact provenance is inconsistent");
    }
    if (
      carrier !== undefined && wave.plan.run.runId === host.run.runId &&
      wave.plan.run.runAttempt === host.run.runAttempt &&
      wave.planDigest !== carrier.planDigest
    ) {
      throw new Error(
        "matrix aggregate plan differs from native planner output",
      );
    }
    for (const config of input.configs) {
      const cells = wave.plan.cells.filter((cell) =>
        cell.repository.owner === config.repository.owner &&
        cell.repository.name === config.repository.name &&
        cell.repository.installationId === config.repository.installationId
      );
      if (cells.length === 0) continue;
      await input.prepareTarget?.(config);
      const report = await ingestMatrixResults(
        targetDeps(input, config),
        { ...wave.plan, cells },
        wave.results.filter((entry) =>
          cells.some((cell) => cell.cellId === entry.cellId)
        ),
        {
          deadline: input.deadline,
          expectedProvider: host.expectedProvider,
          bundleImporter: createGitBundleImporter({
            repositoryDir: host.sourcePathFor(config),
            bundlesDir: wave.bundlesDir,
          }),
        },
      );
      console.log(
        JSON.stringify({ kind: "sentinel_matrix_ingest", ...report }),
      );
    }
  }
  // Missing/unavailable cell artifacts stay charged and unresolved. Reviews and
  // delivery retain the real ordinary lifecycle; implementation never falls back.
  return await runActionsTargetCycles({
    ...input,
    modelStartsEnabled: carrier === undefined
      ? false
      : input.modelStartsEnabled,
    externalImplementations: true,
  });
}
if (import.meta.main) {
  await runActionsMatrixHost();
}
