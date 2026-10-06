/** Conservative custody of incomplete admissions; never an artifact or non-start proof. */
import { RollingStartBudget } from "../budget/mod.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { GitSha } from "../contracts/brands.ts";
import { parseReleaseRequestV1 } from "../contracts/release.ts";
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
import {
  fetchHttpTransport,
  type HttpResponseV1,
  type HttpTransportV1,
} from "../github/http.ts";
import {
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
} from "../repair/keys.ts";
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
export const MATRIX_PRESERVATION_UNCERTAINTY_DETAIL =
  "candidate preservation unresolved; exact candidate and submitted admission retained";
const PRESERVATION_IDS = [
  "c0d668a23d4c5230f6349d8368d964ea566509bd2e23a9476279108bc74dbc8b",
  "536ffe5515e1bcee3105412af0f419566b76ae422095ac54039f7a6789e1f02b",
  "739b0d9b59604f1fa163f5f90bf9fb37fd33d93ae8eee8d606e0fa174016671d",
  "11acb1590ed849db9e3fa8c4fe071ed169142c74c122deb8b40bc4ad55d7c6b3",
  "971b6ea4516e09c84a94083705353228a5d2ef31d652ddc9346fd5cae34081d9",
] as const;

export interface MatrixUncertaintyBindingV1 {
  repairCommit: GitSha;
  runtimeSha: GitSha;
  generation: number;
  reservationIds: readonly string[];
}

/** Exact state custody, not a claim that these IDs belonged to a lost plan. */
export const MATRIX_UNCERTAINTY_BINDING: MatrixUncertaintyBindingV1 = {
  repairCommit: "83997ba19af28ca46186962139931d18cef9e170" as GitSha,
  runtimeSha: "e4cef46332cf124a8c283d798a963cf5f66e45c2" as GitSha,
  generation: 63,
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
  /** Task-bound native PR/commit evidence, never a bare verifier refusal. */
  confirmHistoricalStaleBase?(): Promise<boolean>;
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
  const http = input.http ?? fetchHttpTransport();
  const options = {
    repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
    apiBaseUrl: "https://api.github.com",
    http,
    clock: input.clock,
    auth: {
      authorizationHeader: () =>
        Promise.resolve(portOk(`Bearer ${input.token}`)),
    },
    cooldownGate: new HostedRepairCooldownGate({
      state: input.state,
      clock: input.clock,
    }),
  };
  const client = new GitHubApiClient(options);
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
    confirmHistoricalStaleBase: async () => {
      // Capture only this invocation's authenticated native reads through the
      // existing verifier, including its deadlines and durable cooldown gate.
      let pull: HttpResponseV1 | null = null;
      let commit: HttpResponseV1 | null = null;
      const verifier = new GitHubApiClient({
        ...options,
        http: async (wire) => {
          const response = await http(wire);
          if (wire.method === "GET") {
            if (
              wire.url ===
                "https://api.github.com/repos/ubiquity/sentinel/pulls/110"
            ) pull = response;
            if (
              wire.url ===
                `https://api.github.com/repos/ubiquity/sentinel/commits/${STALE_BASE_REQUEST.revision}`
            ) commit = response;
          }
          return response;
        },
      });
      const verified = await verifier.verifyHostedReleaseRequest(
        STALE_BASE_REQUEST,
      );
      if (!verified.ok || verified.value !== false) return false;
      try {
        const read = (response: HttpResponseV1 | null) => {
          if (
            response?.status !== 200 || response.bodyText.length > 1_000_000
          ) refuse();
          return JSON.parse(response.bodyText);
        };
        const pr = read(pull);
        const merged = read(commit);
        return pr.number === 110 && pr.state === "closed" &&
          pr.merged === true &&
          pr.merge_commit_sha === STALE_BASE_REQUEST.revision &&
          pr.head?.sha === STALE_BASE_REQUEST.source.head &&
          pr.head?.repo?.full_name === "ubiquity/sentinel" &&
          pr.base?.ref === "development" &&
          pr.base?.repo?.full_name === "ubiquity/sentinel" &&
          merged.sha === STALE_BASE_REQUEST.revision &&
          Array.isArray(merged.parents) && merged.parents.length === 2 &&
          merged.parents[0]?.sha === STALE_BASE_RUNTIME &&
          merged.parents[1]?.sha === STALE_BASE_REQUEST.source.head &&
          merged.parents.every((parent: { sha?: string }) =>
            parent.sha !== STALE_BASE_REQUEST.source.base
          );
      } catch {
        return false;
      }
    },
  };
}

const STALE_BASE_RUNTIME = "e4cef46332cf124a8c283d798a963cf5f66e45c2";
const STALE_BASE_REPAIR = "50bb001920827e31816c0d7ed37b8143965c0cf7" as GitSha;
const STALE_BASE_REASON =
  "historical PR110 merged against an unreviewed base; release authorization cancelled";
const STALE_BASE_REQUEST = parseReleaseRequestV1({
  version: "v1",
  kind: "release_request",
  id:
    "release:5e6390da3991207f7fb7cdd8f0fa5268c0e9daf0fe12c04d3e8e44245f09a5da",
  target: {
    repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
    environment: "production",
  },
  revision: "accc96c8e8eeb5cca71e9641f674a96bf75c77d1",
  source: {
    pullRequest: 110,
    reviewRequestId:
      "review-review:110:28e2aac95f0dbcc79b3c41333f5a2eb92194ccea:attempt-3",
    reviewReceiptId:
      "review-receipt:a62d1e2150592b28b358978f7c5781aff45dce6899dc668b67b72b97094b908e",
    head: "28e2aac95f0dbcc79b3c41333f5a2eb92194ccea",
    base: "2bca04186b3e462c63ba3d9ce996f4a5d3fd03b6",
  },
  status: "open",
  failureReason: null,
  createdAt: 1791208786131,
});

/** Cancel one invalid historical authorization; never promote or claim delivery.
 * Returns false when a recorded execution means the main hosted flow owns
 * settlement; the caller yields gracefully instead of failing. */
async function disposeHistoricalStaleBase(
  deps: MatrixUncertaintyMaintenanceDepsV1,
): Promise<boolean> {
  const first = await deps.state.readRepair();
  if (!first.ok || first.value.status !== "found") refuse();
  const held = first.value;
  const request = held.snapshot.releaseRequests.find((row) =>
    row.id === STALE_BASE_REQUEST.id
  );
  if (request === undefined) return true;
  const cancelled = {
    ...STALE_BASE_REQUEST,
    status: "cancelled",
    failureReason: STALE_BASE_REASON,
  };
  if (same(request, cancelled)) return true;
  if (
    !same(request, STALE_BASE_REQUEST) || !deps.state.readRepairAt ||
    !deps.confirmHistoricalStaleBase
  ) refuse();
  const original = await deps.state.readRepairAt({
    commit: STALE_BASE_REPAIR,
    expectedHead: held.head,
  });
  if (
    !original.ok || original.value.status !== "found" ||
    original.value.head !== STALE_BASE_REPAIR ||
    !same(
      original.value.snapshot.releaseRequests.find((row) =>
        row.id === request.id
      ),
      request,
    )
  ) refuse();
  const priorReview = original.value.snapshot.reviews.find((row) =>
    row.id === request.source.reviewReceiptId
  );
  const review = held.snapshot.reviews.find((row) =>
    row.id === request.source.reviewReceiptId
  );
  if (
    !priorReview || !review || !same(priorReview, review) ||
    review.requestId !== request.source.reviewRequestId ||
    review.pullRequest.number !== 110 ||
    review.pullRequest.head !== request.source.head ||
    review.pullRequest.base !== request.source.base
  ) refuse();
  const release = await deps.state.readRelease();
  if (!release.ok || release.value.status !== "found") refuse();
  const captured = release.value;
  const runtime = captured.snapshot.hostedRuntimes[0];
  // A recorded execution (active or stale) means the main hosted flow owns
  // settlement; yield instead of failing the maintenance run. This also
  // covers the race where an execution appears after the caller's upfront
  // check but before this reread.
  if (runtime?.execution != null) return false;
  const healthy = runtime?.lastHealthyProof;
  if (
    captured.snapshot.hostedRuntimes.length !== 1 || !runtime ||
    runtime.id !== HOSTED_RUNTIME_ID ||
    runtime.activeRevision !== STALE_BASE_RUNTIME ||
    runtime.generation !== 63 ||
    !healthy || healthy.execution.revision !== STALE_BASE_RUNTIME ||
    healthy.execution.generation !== 63 ||
    !same(runtime.lastExecutionProof, healthy) ||
    captured.snapshot.hostedReleases.some((row) =>
      row.id === request.id || row.pointerIntent !== null ||
      (row.phase !== "accepted" && row.phase !== "rolled_back")
    ) ||
    [...held.snapshot.githubCooldowns, ...captured.snapshot.githubCooldowns]
      .some((row) =>
        row.retryNotBefore === null || row.retryNotBefore > deps.clock.now()
      )
  ) refuse();
  if (!await deps.confirmCompletedExecution(healthy.execution)) refuse();
  const native = await deps.readExecution(healthy.execution);
  if (
    !native.ok || !native.value || native.value.outcome !== "healthy" ||
    native.value.observedAt < healthy.observedAt ||
    native.value.observedAt > deps.clock.now() ||
    !same({ ...healthy, observedAt: native.value.observedAt }, native.value) ||
    !await deps.confirmHistoricalStaleBase()
  ) refuse();
  async function custody() {
    const current = await deps.state.readRelease();
    if (
      !current.ok || current.value.status !== "found" ||
      !same(current.value, captured)
    ) refuse();
  }
  await custody();
  const current = await deps.state.readRepair();
  if (
    !current.ok || current.value.status !== "found" ||
    !same(current.value, held)
  ) refuse();
  const now = deps.clock.now();
  if (!Number.isSafeInteger(now) || now < held.snapshot.updatedAt) refuse();
  const next = {
    ...held.snapshot,
    sequence: held.snapshot.sequence + 1,
    stateHead: held.head,
    updatedAt: now,
    releaseRequests: held.snapshot.releaseRequests.map((row) =>
      row.id === request.id ? parseReleaseRequestV1(cancelled) : row
    ),
  };
  const written = await deps.state.writeRepair(next, held.head);
  if (!written.ok || written.value.status !== "applied") refuse();
  const after = await deps.state.readRepair();
  if (
    !after.ok || after.value.status !== "found" ||
    !same(after.value.snapshot, next) ||
    after.value.head !== written.value.head
  ) refuse();
  await custody();
  return true;
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

/** Charged failure handling and conservative parking of exact captured preservation. */
export async function runMatrixUncertaintyMaintenance(
  deps: MatrixUncertaintyMaintenanceDepsV1,
) {
  // An execution record (active or stale from an interrupted run) means the
  // main hosted flow owns settlement. The historical quarantine is optional
  // work; it yields rather than failing the entire maintenance run.
  const yieldOnExecution = async () => {
    const repair = await deps.state.readRepair();
    if (!repair.ok || repair.value.status !== "found") refuse();
    return {
      beforeHead: repair.value.head,
      appliedHead: repair.value.head,
      quarantined: 0,
    };
  };
  const preRelease = await deps.state.readRelease();
  if (!preRelease.ok || preRelease.value.status !== "found") refuse();
  if (
    preRelease.value.snapshot.hostedRuntimes.some((row) =>
      row.execution !== null
    )
  ) {
    return await yieldOnExecution();
  }
  // disposeHistoricalStaleBase returns false if an execution appeared after
  // the upfront check; yield gracefully instead of failing.
  if (!await disposeHistoricalStaleBase(deps)) {
    return await yieldOnExecution();
  }
  const binding = deps.binding ?? MATRIX_UNCERTAINTY_BINDING;
  const first = await deps.state.readRepair();
  if (!first.ok || first.value.status !== "found") refuse();
  const initialSnapshot = first.value.snapshot;
  const ids = new Set(binding.reservationIds);
  if (
    ids.size !== 13 || binding.reservationIds.length !== 13 ||
    binding.reservationIds.some((id) => !/^[0-9a-f]{64}$/.test(id))
  ) refuse();
  // The existing trusted fixture binding may describe only the thirteen
  // implementation admissions. Production always owns all five captured IDs.
  const preservationIds = deps.binding === undefined
    ? PRESERVATION_IDS
    : PRESERVATION_IDS.filter((id) =>
      initialSnapshot.work.some((row) => row.intent?.requestId === id)
    );
  if (preservationIds.some((id) => ids.has(id))) refuse();
  if (
    !initialSnapshot.work.some((row) =>
      row.nextStep === "work" &&
      (ids.has(row.intent?.requestId ?? "") ||
        preservationIds.some((id) => id === row.intent?.requestId))
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
    )
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
  let activePreservation = false;
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
        (activePreservation
          ? (!same(reservation, nextCharge) ||
            nextCharge.outcome !== "submitted" || nextCharge.settledAt === null)
          : (!same(chargeIdentity(reservation), chargeIdentity(nextCharge)) ||
            nextCharge.outcome !== "ambiguous" ||
            nextCharge.settledAt === null ||
            nextCharge.proofRef !== null))
      ) refuse();
      const block = next.work.find((work) => work.id === activeTask);
      if (
        !block || block.updatedAt < row.updatedAt ||
        block.updatedAt > next.updatedAt || next.updatedAt > deps.clock.now() ||
        (!same(block, row) &&
          !same(
            block,
            markBlocked(
              row,
              "other",
              activePreservation
                ? MATRIX_PRESERVATION_UNCERTAINTY_DETAIL
                : MATRIX_UNCERTAINTY_DETAIL,
              block.updatedAt,
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
  for (const id of preservationIds) {
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
      submitted = charge[0],
      intent = row.intent;
    if (
      saved.nextStep !== "work" ||
      saved.intent?.kind !== "candidate_preservation" ||
      submitted.outcome !== "submitted" || submitted.settledAt === null ||
      submitted.proofRef !== null ||
      !same(submitted, originalCharge[0]) ||
      submitted.purpose === "review_request" ||
      intent?.kind !== "candidate_preservation" || intent.requestId !== id ||
      intent.key !== implementationIntentKey(id) || intent.resultId !== null ||
      intent.pr !== null ||
      row.target.head === null || row.target.head === row.target.base ||
      row.target.branch !== candidateBranch(row.id) ||
      row.target.candidateState?.preserved !== null ||
      intent.expectedHead !== row.target.head ||
      intent.observedBase !== row.target.base ||
      intent.branch !==
        await candidatePreservationRef(row.repository, row.id, intent.key) ||
      submitted.head !== row.target.base || submitted.taskId !== row.id ||
      submitted.attempt !== row.counters.attempts ||
      !same(submitted.repository, row.repository)
    ) refuse();
    if (
      same(
        row,
        markBlocked(
          saved,
          "other",
          MATRIX_PRESERVATION_UNCERTAINTY_DETAIL,
          row.updatedAt,
        ),
      )
    ) continue;
    if (!same(row, saved)) refuse();
    await custody();
    activeId = id;
    activeTask = row.id;
    activePreservation = true;
    const at = deps.clock.now();
    const blocked = markBlocked(
      row,
      "other",
      MATRIX_PRESERVATION_UNCERTAINTY_DETAIL,
      at,
    );
    const next = {
      ...expected.snapshot,
      sequence: expected.snapshot.sequence + 1,
      stateHead: expected.head,
      updatedAt: at,
      work: expected.snapshot.work.map((work) =>
        work.id === row.id ? blocked : work
      ),
    };
    const written = await guarded.writeRepair(next, expected.head);
    if (!written.ok || written.value.status !== "applied") refuse();
    const readback = await deps.state.readRepair();
    if (
      !readback.ok || readback.value.status !== "found" ||
      !same(readback.value, expected)
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
