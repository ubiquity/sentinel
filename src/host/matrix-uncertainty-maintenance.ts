/** Conservative custody of incomplete admissions; never an artifact or non-start proof. */
import { RollingStartBudget } from "../budget/mod.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { GitSha } from "../contracts/brands.ts";
import {
  HOSTED_RUNTIME_ID,
  type HostedExecutionIntentV1,
  type HostedExecutionSettlementV1,
} from "../contracts/hosted-supervisor.ts";
import type {
  Clock,
  PortResultV1,
  RepairStateWriter,
  StateReadView,
} from "../contracts/ports.ts";
import { portOk } from "../contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { GitHubApiClient } from "../github/client.ts";
import { fetchHttpTransport, type HttpTransportV1 } from "../github/http.ts";
import { implementationIntentKey } from "../repair/keys.ts";
import {
  type RepairCycleDepsV1,
  settleFailedImplementation,
} from "../repair/loop.ts";
import { markBlocked } from "../repair/transitions.ts";
import { HostedRepairCooldownGate } from "./hosted-cooldown.ts";
import {
  createActionsMatrixArtifactHttpTransport,
  createActionsMatrixArtifactTransport,
} from "./matrix-artifacts.ts";

export const MATRIX_UNCERTAINTY_DETAIL =
  "implementation outcome uncertain; original admission retained without usable artifact evidence";

export interface MatrixUncertaintyBindingV1 {
  repairCommit: GitSha;
  runtimeSha: GitSha;
  generation: number;
  reservationIds: readonly string[];
}

/** Exact state custody, not a claim that these IDs belonged to a lost plan. */
export const MATRIX_UNCERTAINTY_BINDING: MatrixUncertaintyBindingV1 = {
  repairCommit: "83997ba19af28ca46186962139931d18cef9e170" as GitSha,
  runtimeSha: "ac98dc80ff9c3eca5f36aca91493168e9ff74596" as GitSha,
  generation: 61,
  reservationIds: [
    "8843dd098e28e8a5b17ef0f0c341da1cf88e2d38ce4cc9034476cb7850625c30",
    "1f167fa400e87b0e03fb7b35bf964ada6ec6311c45c4fc49752ef16705f26b10",
    "b1b2917eaff6b27b1c82bdb96c75775505b757f96f07a47e06d3f7854c1836a3",
    "38b47e8dcc17eb75b74e60b90ffc3b3346ebf53a014425599910b3b8538be88e",
    "1e9e9188f2c6ec47780cfd2e9bf78c9d86b8dc758744f048b474e3a8645d209a",
    "cb57e74cbc9d1011108c6f254c2b0aaf37a5aab5d5094031a1df3840ff4e21fb",
    "091b32ab77d57477c2895e889962224ec076ddc4940dd0f4099aaaefe719658b",
    "b63f6d6be931b2ac44567f404f2c4bc373d65ce6df8c06dec3158681b998a68a",
    "09ea3a53b1d1dfc1ac9c69276ffc753ded683b2c4005d2938a36610267bfa46c",
    "ae549e2196031ddd342b0972f65a66f73099c8aca0977601181387c8bb954b3f",
    "ceeffce48dcfe171c05244a80f40339e19bbf19e026bd81afd8504f8f0805e2a",
    "e6fbfe6481c4eb5860d0ec93e7cf66246ce0c8f1b7ad3c98b2a5976b53b2d944",
    "2e765e5ce7b7336dd52b2e8c7882ad1ce5ca30d098348057793f475d9425dcd2",
  ],
};

export interface MatrixUncertaintyMaintenanceDepsV1 {
  state: StateReadView & RepairStateWriter;
  clock: Clock;
  confirmCompletedExecution(
    execution: HostedExecutionIntentV1,
  ): Promise<boolean>;
  readExecution(execution: HostedExecutionIntentV1): Promise<
    PortResultV1<HostedExecutionSettlementV1 | null>
  >;
  /** Trusted in-process fixture binding; production uses the fixed custody above. */
  binding?: MatrixUncertaintyBindingV1;
}

export function createMatrixUncertaintyMaintenance(input: {
  state: StateReadView & RepairStateWriter;
  clock: Clock;
  token: string;
  artifactRoot: string;
  http?: HttpTransportV1;
}): MatrixUncertaintyMaintenanceDepsV1 {
  const client = new GitHubApiClient({
    repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
    apiBaseUrl: "https://api.github.com",
    http: input.http ?? fetchHttpTransport(),
    clock: input.clock,
    auth: {
      authorizationHeader: () =>
        Promise.resolve(portOk(`Bearer ${input.token}`)),
    },
    cooldownGate: new HostedRepairCooldownGate({
      state: input.state,
      clock: input.clock,
    }),
  });
  const transport = createActionsMatrixArtifactTransport({
    ...input,
    http: input.http ?? createActionsMatrixArtifactHttpTransport(),
  });
  return {
    state: input.state,
    clock: input.clock,
    confirmCompletedExecution: (execution) =>
      transport.confirmCompletedExecution!(execution),
    readExecution: (execution) => client.readHostedExecution(execution),
  };
}

function refuse(): never {
  throw new Error(
    "matrix uncertainty maintenance custody unavailable or changed",
  );
}
const same = (a: unknown, b: unknown) =>
  canonicalStringify(a) === canonicalStringify(b);
function chargeIdentity(row: RepairStateSnapshotV1["reservations"][number]) {
  return { ...row, outcome: "reserved", settledAt: null, proofRef: null };
}

/** Only the existing charged failure consumer may mutate the exact captured rows. */
export async function runMatrixUncertaintyMaintenance(
  deps: MatrixUncertaintyMaintenanceDepsV1,
) {
  const binding = deps.binding ?? MATRIX_UNCERTAINTY_BINDING;
  const first = await deps.state.readRepair();
  if (!first.ok || first.value.status !== "found") refuse();
  const ids = new Set(binding.reservationIds);
  if (
    ids.size !== 13 || binding.reservationIds.length !== 13 ||
    binding.reservationIds.some((id) => !/^[0-9a-f]{64}$/.test(id))
  ) refuse();
  if (
    !first.value.snapshot.work.some((row) =>
      row.nextStep === "work" && ids.has(row.intent?.requestId ?? "")
    )
  ) {
    return {
      beforeHead: first.value.head,
      appliedHead: first.value.head,
      quarantined: 0,
    };
  }
  if (!deps.state.readRepairAt) refuse();
  const original = await deps.state.readRepairAt({
    commit: binding.repairCommit,
    expectedHead: first.value.head,
  });
  if (
    !original.ok || original.value.status !== "found" ||
    original.value.head !== binding.repairCommit
  ) refuse();
  const release = await deps.state.readRelease();
  if (!release.ok || release.value.status !== "found") refuse();
  const heldRelease = release.value;
  const runtime = release.value.snapshot.hostedRuntimes.find((row) =>
    row.id === HOSTED_RUNTIME_ID
  );
  const held = runtime?.lastExecutionProof;
  if (
    !runtime || runtime.activeRevision !== binding.runtimeSha ||
    runtime.generation !== binding.generation ||
    !held || held.outcome === "not_started" ||
    held.execution.revision !== runtime.activeRevision ||
    held.execution.generation !== runtime.generation ||
    release.value.snapshot.hostedReleases.some((row) =>
      row.pointerIntent !== null
    ) ||
    release.value.snapshot.hostedRuntimes.some((row) => row.execution !== null)
  ) refuse();
  if (
    [
      ...first.value.snapshot.githubCooldowns,
      ...release.value.snapshot.githubCooldowns,
    ].some((row) =>
      row.retryNotBefore === null || row.retryNotBefore > deps.clock.now()
    )
  ) refuse();
  if (!await deps.confirmCompletedExecution(held.execution)) refuse();
  const native = await deps.readExecution(held.execution);
  if (
    !native.ok || native.value === null ||
    native.value.outcome === "not_started" ||
    !same({ ...held, observedAt: native.value.observedAt }, native.value)
  ) refuse();

  let expected = first.value;
  let activeId = "";
  let activeTask = "";
  async function custody() {
    const fresh = await deps.state.readRelease();
    if (
      !fresh.ok || fresh.value.status !== "found" ||
      !same(fresh.value, heldRelease)
    ) refuse();
  }
  const guarded: StateReadView & RepairStateWriter = {
    readRepair: () => deps.state.readRepair(),
    readRelease: () => deps.state.readRelease(),
    async writeRepair(next, head) {
      await custody();
      const current = await deps.state.readRepair();
      if (
        !current.ok || current.value.status !== "found" ||
        !same(current.value, expected) || head !== expected.head
      ) refuse();
      const before = expected.snapshot;
      const row = before.work.find((work) => work.id === activeTask);
      if (!row) refuse();
      const reservation = before.reservations.find((charge) =>
        charge.id === activeId
      );
      const nextCharge = next.reservations.find((charge) =>
        charge.id === activeId
      );
      if (
        !reservation || !nextCharge ||
        !same(chargeIdentity(reservation), chargeIdentity(nextCharge)) ||
        nextCharge.outcome !== "ambiguous" || nextCharge.settledAt === null ||
        nextCharge.proofRef !== null
      ) refuse();
      const block = next.work.find((work) => work.id === activeTask);
      if (
        !block ||
        (!same(block, row) &&
          !same(
            block,
            markBlocked(
              row,
              "other",
              MATRIX_UNCERTAINTY_DETAIL,
              next.updatedAt,
            ),
          ))
      ) refuse();
      const permitted = {
        ...before,
        sequence: before.sequence + 1,
        stateHead: head,
        updatedAt: next.updatedAt,
        work: before.work.map((work) => work.id === activeTask ? block : work),
        reservations: before.reservations.map((charge) =>
          charge.id === activeId ? nextCharge : charge
        ),
      };
      if (!same(next, permitted)) refuse();
      const written = await deps.state.writeRepair(next, head);
      if (!written.ok || written.value.status !== "applied") return written;
      expected = { ...expected, head: written.value.head, snapshot: next };
      await custody();
      return written;
    },
  };
  function denied<T>(): T {
    return new Proxy({}, {
      get: () => () => {
        throw new Error("matrix uncertainty capability refused");
      },
    }) as T;
  }
  const cycle = {
    state: guarded,
    clock: deps.clock,
    configs: [],
    controllerSha: binding.runtimeSha,
    github: denied<RepairCycleDepsV1["github"]>(),
    githubCooldown: denied<RepairCycleDepsV1["githubCooldown"]>(),
    incidents: denied<RepairCycleDepsV1["incidents"]>(),
    replay: denied<RepairCycleDepsV1["replay"]>(),
    model: denied<RepairCycleDepsV1["model"]>(),
    budget: new RollingStartBudget({
      state: guarded,
      clock: deps.clock,
      configs: [],
    }),
    externalImplementations: true,
  } as RepairCycleDepsV1;
  let quarantined = 0;
  for (const id of binding.reservationIds) {
    const source = original.value.snapshot.work.filter((row) =>
      row.intent?.requestId === id
    );
    const originalCharge = original.value.snapshot.reservations.filter((row) =>
      row.id === id
    );
    const work = expected.snapshot.work.filter((row) =>
      row.intent?.requestId === id
    );
    const charge = expected.snapshot.reservations.filter((row) =>
      row.id === id
    );
    if (
      source.length !== 1 || originalCharge.length !== 1 || work.length !== 1 ||
      charge.length !== 1
    ) refuse();
    const saved = source[0],
      row = work[0],
      reserved = charge[0],
      intent = row.intent;
    if (
      saved.nextStep !== "work" || saved.intent?.kind !== "implementation" ||
      saved.target.candidateState !== undefined ||
      saved.target.head !== null || saved.target.checkpoint !== null ||
      saved.target.pr !== null ||
      (originalCharge[0].outcome !== "reserved" &&
        originalCharge[0].outcome !== "ambiguous") ||
      originalCharge[0].purpose === "review_request" ||
      !same(chargeIdentity(originalCharge[0]), chargeIdentity(reserved)) ||
      (reserved.outcome !== "reserved" && reserved.outcome !== "ambiguous") ||
      reserved.proofRef !== null ||
      intent?.kind !== "implementation" || intent.requestId !== id ||
      intent.key !== implementationIntentKey(id) ||
      intent.expectedHead !== null || intent.resultId !== null ||
      intent.pr !== null ||
      intent.observedBase !== row.target.base ||
      reserved.head !== row.target.base || reserved.taskId !== row.id ||
      reserved.attempt !== row.counters.attempts ||
      !same(reserved.repository, row.repository)
    ) refuse();
    if (
      row.nextStep === "blocked" &&
      row.blocker?.message === MATRIX_UNCERTAINTY_DETAIL &&
      reserved.outcome === "ambiguous" &&
      reserved.settledAt !== null &&
      same(
        row,
        markBlocked(saved, "other", MATRIX_UNCERTAINTY_DETAIL, row.updatedAt),
      )
    ) continue;
    if (!same(row, saved)) refuse();
    await custody();
    activeId = id;
    activeTask = row.id;
    const context = {
      head: expected.head,
      snapshot: expected.snapshot,
      bounds: {
        runDeadline: deps.clock.now() + 180_000,
        modelCutoff: deps.clock.now(),
      },
      executionBaseline: null,
    };
    const step = await settleFailedImplementation(
      cycle,
      context,
      row,
      id,
      MATRIX_UNCERTAINTY_DETAIL,
    );
    if (step.kind !== "progress") refuse();
    const readback = await deps.state.readRepair();
    if (
      !readback.ok || readback.value.status !== "found" ||
      !same(readback.value, expected)
    ) refuse();
    const blocked = expected.snapshot.work.find((work) =>
      work.id === activeTask
    );
    if (
      !blocked ||
      !same(
        blocked,
        markBlocked(
          saved,
          "other",
          MATRIX_UNCERTAINTY_DETAIL,
          blocked.updatedAt,
        ),
      )
    ) refuse();
    const settled = expected.snapshot.reservations.find((charge) =>
      charge.id === id
    );
    if (
      !settled || settled.outcome !== "ambiguous" || settled.settledAt === null
    ) refuse();
    quarantined++;
  }
  await custody();
  return {
    beforeHead: first.value.head,
    appliedHead: expected.head,
    quarantined,
  };
}
