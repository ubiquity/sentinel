/** One authenticated C-wave recovery; no model, publication, or pointer authority. */
import { canonicalStringify } from "../contracts/canonical.ts";
import type { GitSha } from "../contracts/brands.ts";
import type {
  Clock,
  PortResultV1,
  RepairStateWriter,
  StateReadView,
} from "../contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type {
  HostedExecutionIntentV1,
  HostedExecutionSettlementV1,
  HostedRunProofV1,
} from "../contracts/hosted-supervisor.ts";
import {
  HOSTED_RUNTIME_ID,
  parseHostedRunProofV1,
} from "../contracts/hosted-supervisor.ts";
import { matrixDigestV1 } from "../contracts/matrix.ts";
import type {
  MatrixArtifactTransportV1,
  MatrixAuthenticatedWaveV1,
} from "./matrix-artifact-port.ts";
import { ingestMatrixResults } from "./matrix.ts";
import type { MatrixBundleImporterV1 } from "./matrix-git.ts";
import type { RepairCycleDepsV1 } from "../repair/loop.ts";

export const CLOSED_C_WAVE = {
  runtimeSha: "ddc98af7062b63e2b6b0f1e6b877e32f4675d442" as GitSha,
  generation: 60,
  run: {
    runId: 37180705352,
    runAttempt: 1,
    launcherSha: "219ba1c1411e443a44fc0090779dd4174f1a8e76" as GitSha,
  },
  repairCommit: "8bebdac1d274a333769c2ba56d201868642418a5" as GitSha,
  releaseCommit: "e5ac34ea065d378c1ad65e57ce71d4eff6aab2a0" as GitSha,
  planDigest:
    "ca045c64c68c65f778fa73323ad462bdda420476a446013c36706e3b85c04b87",
  expectedProvider: "uos",
  planZipDigest:
    "add2ff1b926b4b7dedbd0f21c47149bf7a614415410ce1ff84b98ca54db08edb",
  cells: [
    {
      "reservationId":
        "f6b7c7a0478604003aaa8413dbc41ef96feaba63a7776b172b0fbd961bdafdeb",
      "cellId":
        "f488fa468fe929a066d7156395686d4912464563389d025fc49c2e8395873430",
      "taskId": "issue-ubiquity-ai.ubq.fi-722",
      "repository": {
        "owner": "ubiquity",
        "name": "ai.ubq.fi",
        "installationId": 155687488,
      },
      "base": "de16d5db5131732360824239875f49af5f335ea1",
    },
    {
      "reservationId":
        "f53e67a3cafe9e90aa9d3b32b30a1fdff8797308eb96e15b6752533e2587a7c5",
      "cellId":
        "454eebdd9568849c07ceb28bb8f256a737a1b71c4b1e0322ccfe51dc2bd19b4d",
      "taskId": "issue-ubiquity-ai.ubq.fi-724",
      "repository": {
        "owner": "ubiquity",
        "name": "ai.ubq.fi",
        "installationId": 155687488,
      },
      "base": "de16d5db5131732360824239875f49af5f335ea1",
    },
    {
      "reservationId":
        "984f7a47a68859cd008df08a13aa6a55b0ae2514ce0655a597a47d7a07a68931",
      "cellId":
        "b4d7335435c31eab14e92d999b6ee91de2a19e0d5b9a9a64560b74b280e4d33c",
      "taskId": "issue-ubiquity-ai.ubq.fi-725",
      "repository": {
        "owner": "ubiquity",
        "name": "ai.ubq.fi",
        "installationId": 155687488,
      },
      "base": "de16d5db5131732360824239875f49af5f335ea1",
    },
    {
      "reservationId":
        "8891a26dcb1dd89c399ee6c1cdb55227981f04e5ecbe4c9671c04d495fcddf55",
      "cellId":
        "113b60f596de8ff8b3efc83740ebd302ea2a4a178ab790fdfdfec78cf72d2e41",
      "taskId": "issue-ubiquity-ai.ubq.fi-726",
      "repository": {
        "owner": "ubiquity",
        "name": "ai.ubq.fi",
        "installationId": 155687488,
      },
      "base": "de16d5db5131732360824239875f49af5f335ea1",
    },
    {
      "reservationId":
        "6917b7bdb51f4bb947403647a6aa96a104098ca1a7e7ff851634881ba3f67532",
      "cellId":
        "8ad8a3094caca14e76633aaadb69bdf3c01262852f4078f801c178428e74b3fc",
      "taskId": "issue-ubiquity-ai.ubq.fi-728",
      "repository": {
        "owner": "ubiquity",
        "name": "ai.ubq.fi",
        "installationId": 155687488,
      },
      "base": "de16d5db5131732360824239875f49af5f335ea1",
    },
    {
      "reservationId":
        "285477cb5c756a310857c3a163410addecc81dfb86308b0f6b86c526f30129f2",
      "cellId":
        "f9cbcdad4aa8c73ea9c460f98528395f5dfb7422e088d760feb1f93dcd7889ef",
      "taskId": "issue-ubiquity-ai.ubq.fi-730",
      "repository": {
        "owner": "ubiquity",
        "name": "ai.ubq.fi",
        "installationId": 155687488,
      },
      "base": "de16d5db5131732360824239875f49af5f335ea1",
    },
    {
      "reservationId":
        "f0a01a4ca0dfa5634f50a7840c6616d95261ec5ba7bd4393eeefaf77f0f328ea",
      "cellId":
        "b7e0557c5c4d98e8252c2ea5457b32d11d7445af24692134f616c4916c723607",
      "taskId": "issue-ubiquity-ai.ubq.fi-731",
      "repository": {
        "owner": "ubiquity",
        "name": "ai.ubq.fi",
        "installationId": 155687488,
      },
      "base": "de16d5db5131732360824239875f49af5f335ea1",
    },
    {
      "reservationId":
        "370a266a6eee1f3a98a902605de215889709858abfbf67c846c9f255b0d2451f",
      "cellId":
        "e7e9e737bdcbc7c4e39637b6ff14a51364e9f76c0ac4eecca0f596383d8c4dea",
      "taskId": "issue-ubiquity-ai.ubq.fi-732",
      "repository": {
        "owner": "ubiquity",
        "name": "ai.ubq.fi",
        "installationId": 155687488,
      },
      "base": "de16d5db5131732360824239875f49af5f335ea1",
    },
    {
      "reservationId":
        "ffcffa70d1176cbc1ad77a91027e2b636a73c75ea1549ce2ad4d9651fb5556a9",
      "cellId":
        "214c77901e6eb615f2f57bf0ce9d7e1275307b9e497017023d9c28b37a1f5ed7",
      "taskId": "issue-ubiquity-ai.ubq.fi-733",
      "repository": {
        "owner": "ubiquity",
        "name": "ai.ubq.fi",
        "installationId": 155687488,
      },
      "base": "de16d5db5131732360824239875f49af5f335ea1",
    },
    {
      "reservationId":
        "b688eeef58657c83983ba4a0c495b5888a240ae5ae941721183ca1ccabca603f",
      "cellId":
        "edc29e6beda881a8b184842f0686bfd2135c5e5254244ead4acd6e9e8c0e50df",
      "taskId": "issue-ubiquity-ai.ubq.fi-748",
      "repository": {
        "owner": "ubiquity",
        "name": "ai.ubq.fi",
        "installationId": 155687488,
      },
      "base": "de16d5db5131732360824239875f49af5f335ea1",
    },
    {
      "reservationId":
        "41340180e869eca185d549376dab17fb506669a57d2837190211c3eb6681a2f7",
      "cellId":
        "0125618becd95b0a9a09e2bc3cdb1e0c82b2c5b3f7b338f564d6642564cfbc71",
      "taskId": "issue-ubiquity-ai.ubq.fi-751",
      "repository": {
        "owner": "ubiquity",
        "name": "ai.ubq.fi",
        "installationId": 155687488,
      },
      "base": "de16d5db5131732360824239875f49af5f335ea1",
    },
    {
      "reservationId":
        "eee1454d2c9041b44aad4aa3ca8647fe890bd836607161fdada80223d345dfb2",
      "cellId":
        "a111f2059bfca7ce24839f4ef13906184db2588237e67c7d93f5386bbfea4c72",
      "taskId": "issue-ubiquity-ai.ubq.fi-752",
      "repository": {
        "owner": "ubiquity",
        "name": "ai.ubq.fi",
        "installationId": 155687488,
      },
      "base": "de16d5db5131732360824239875f49af5f335ea1",
    },
    {
      "reservationId":
        "f47e43841915d5b878a43460e970f2eea46cde378169c78e5d15ffb8e0dd1fd9",
      "cellId":
        "fd39995d11b583248cc174f74464d678434918aab22ae38611a91e7455208b38",
      "taskId": "issue-ubiquity-ai.ubq.fi-754",
      "repository": {
        "owner": "ubiquity",
        "name": "ai.ubq.fi",
        "installationId": 155687488,
      },
      "base": "de16d5db5131732360824239875f49af5f335ea1",
    },
    {
      "reservationId":
        "ab1ec5f12b65a69cb5269d4fb91550edbb50f384c9f294ddfdb7064d183c51e6",
      "cellId":
        "aceb1844de2d4567d0a3f8d9f1923ae5d04f9bbf0db9f594ada987bc9824a11b",
      "taskId": "issue-ubiquity-ai.ubq.fi-755",
      "repository": {
        "owner": "ubiquity",
        "name": "ai.ubq.fi",
        "installationId": 155687488,
      },
      "base": "de16d5db5131732360824239875f49af5f335ea1",
    },
    {
      "reservationId":
        "2933798ef4bc0973827e9a923fb0f4bdf28d0089de85fd3d7d7622fd465931f4",
      "cellId":
        "3cda22bfbc053ee92939b3a46ae29efc73fee3bd8fffc0133fe8f6d53ce50150",
      "taskId": "issue-ubiquity-ai.ubq.fi-756",
      "repository": {
        "owner": "ubiquity",
        "name": "ai.ubq.fi",
        "installationId": 155687488,
      },
      "base": "de16d5db5131732360824239875f49af5f335ea1",
    },
    {
      "reservationId":
        "753f68f1e28a5c343b3d326010f369220dc95e1e33dde8ed0b8a84e8ae7fd3bd",
      "cellId":
        "ec47f73906990785a0e6d6198c5089c71cc6ac0927eaa9700622d196e0ceef4a",
      "taskId": "issue-ubiquity-ai.ubq.fi-759",
      "repository": {
        "owner": "ubiquity",
        "name": "ai.ubq.fi",
        "installationId": 155687488,
      },
      "base": "de16d5db5131732360824239875f49af5f335ea1",
    },
    {
      "reservationId":
        "54aa7719ec8f4832f2914f384d7f2017f68668b875ede35eb05c9e6f0da2b96e",
      "cellId":
        "d2a31c32d79c20b20a37010d7338d132061bfe94f206fe0b0513fdcc48f825ca",
      "taskId": "issue-ubiquity-ai.ubq.fi-764",
      "repository": {
        "owner": "ubiquity",
        "name": "ai.ubq.fi",
        "installationId": 155687488,
      },
      "base": "de16d5db5131732360824239875f49af5f335ea1",
    },
    {
      "reservationId":
        "7d27ef4c7f52baaa55abe5ba39d843ca73bda4611e6f0f667649ccc878965e67",
      "cellId":
        "0247707c3891e4250fc09dcf3c5daf91b40f6a57e15411c687804d86b503fa85",
      "taskId": "issue-ubiquity-sentinel-97",
      "repository": {
        "owner": "ubiquity",
        "name": "sentinel",
        "installationId": 0,
      },
      "base": "ddc98af7062b63e2b6b0f1e6b877e32f4675d442",
    },
    {
      "reservationId":
        "3e9f038ba638bfaac60698ade2515dd735897fc234cf5bbd879fe2fa5f300015",
      "cellId":
        "b5beb946648e01ab72621fcbd97864c15e379d9f065b926957be330bbc6d02e5",
      "taskId": "issue-ubiquity-sentinel-98",
      "repository": {
        "owner": "ubiquity",
        "name": "sentinel",
        "installationId": 0,
      },
      "base": "ddc98af7062b63e2b6b0f1e6b877e32f4675d442",
    },
    {
      "reservationId":
        "2f4baf0e09d360fdb342afd589418757bbd5a7566bb6e3bb3d6c5566f8d88d0b",
      "cellId":
        "1964c0d862df209fc27567aea1a28ab599216316037ed750fb9b0369bbe376b8",
      "taskId": "issue-ubiquity-sentinel-106",
      "repository": {
        "owner": "ubiquity",
        "name": "sentinel",
        "installationId": 0,
      },
      "base": "ddc98af7062b63e2b6b0f1e6b877e32f4675d442",
    },
    {
      "reservationId":
        "af6d7645443e7be6fff94d69f02e617d7d390c58f20d69a63b1527430b4dc3bf",
      "cellId":
        "e569400c54734cca184d81211a1f3dbdf1053cedafa597275d926031703b77f1",
      "taskId": "issue-ubiquity-ai.ubq.fi-769",
      "repository": {
        "owner": "ubiquity",
        "name": "ai.ubq.fi",
        "installationId": 155687488,
      },
      "base": "de16d5db5131732360824239875f49af5f335ea1",
    },
    {
      "reservationId":
        "83388d5d2103c9073b3a53d29ff6bb518b4efe7a2eb69a7b9af28891037943ee",
      "cellId":
        "4e55cbd0c7f3e6d92d033542218575ab785a9f7d442a6811f10200056472273d",
      "taskId": "issue-ubiquity-ai.ubq.fi-770",
      "repository": {
        "owner": "ubiquity",
        "name": "ai.ubq.fi",
        "installationId": 155687488,
      },
      "base": "de16d5db5131732360824239875f49af5f335ea1",
    },
    {
      "reservationId":
        "d1dc777e2871f68d518f80ef950261f16dcd74189159f483e4b813730f803f5b",
      "cellId":
        "52e6964b8a944b3af5df51312a4dbb64db8f80b50b397aa88229c3219012bba7",
      "taskId": "issue-ubiquity-ai.ubq.fi-785",
      "repository": {
        "owner": "ubiquity",
        "name": "ai.ubq.fi",
        "installationId": 155687488,
      },
      "base": "de16d5db5131732360824239875f49af5f335ea1",
    },
    {
      "reservationId":
        "72bbfd8e6cc0bc0442f094dd7745839b7b0905fc3a001c232c812d9800c075c0",
      "cellId":
        "e007e6cd8e6e7e7f968021a973c58edc9f3179c7399c1ae7ee842f3168909e51",
      "taskId": "issue-ubiquity-ai.ubq.fi-854",
      "repository": {
        "owner": "ubiquity",
        "name": "ai.ubq.fi",
        "installationId": 155687488,
      },
      "base": "de16d5db5131732360824239875f49af5f335ea1",
    },
    {
      "reservationId":
        "50f192857c15f121cbb25e416288ee3218da417bd089335c5dd74e3bf0b5b7cb",
      "cellId":
        "902410e8177fa2ee09ab070bc874a5655c37cc4f8d5ac65f3ad8689d1ff1e7d2",
      "taskId": "issue-ubiquity-ai.ubq.fi-877",
      "repository": {
        "owner": "ubiquity",
        "name": "ai.ubq.fi",
        "installationId": 155687488,
      },
      "base": "de16d5db5131732360824239875f49af5f335ea1",
    },
    {
      "reservationId":
        "c210284c68aec6283817692431be18768e5d194cafab89c3e405c5b5c362346b",
      "cellId":
        "b7383be3661b00993b5dacb89f71b040338503c1cc70f2a1a6a9e256bf6be45e",
      "taskId": "issue-ubiquity-ai.ubq.fi-878",
      "repository": {
        "owner": "ubiquity",
        "name": "ai.ubq.fi",
        "installationId": 155687488,
      },
      "base": "de16d5db5131732360824239875f49af5f335ea1",
    },
  ],
} as const;
export type ClosedCWaveBindingV1 = {
  runtimeSha: GitSha;
  generation: number;
  run: { runId: number; runAttempt: number; launcherSha: GitSha };
  repairCommit: GitSha;
  releaseCommit: GitSha;
  planDigest: string;
  expectedProvider: string;
  planZipDigest?: string;
  cells: readonly {
    reservationId: string;
    cellId?: string;
    taskId: string;
    repository: { owner: string; name: string; installationId: number };
    base: string;
  }[];
};
export interface ClosedCWaveRecoveryDepsV1 {
  state: StateReadView & RepairStateWriter;
  clock: Clock;
  configs: readonly RepositoryConfigV1[];
  cycleFor(config: RepositoryConfigV1): RepairCycleDepsV1;
  prepareTarget(config: RepositoryConfigV1): Promise<void>;
  importerFor(
    config: RepositoryConfigV1,
    bundlesDir: string,
  ): MatrixBundleImporterV1;
  transportFor(
    state: StateReadView,
  ): MatrixArtifactTransportV1 | Promise<MatrixArtifactTransportV1>;
  readExecution(
    execution: HostedExecutionIntentV1,
  ): Promise<PortResultV1<HostedExecutionSettlementV1 | null>>;
  binding?: ClosedCWaveBindingV1;
}
function sameRepo(
  a: { owner: string; name: string; installationId: number },
  b: { owner: string; name: string; installationId: number },
) {
  return canonicalStringify(a) === canonicalStringify(b);
}
function chargeIdentity(row: unknown) {
  return canonicalStringify({
    ...(row as Record<string, unknown>),
    outcome: "reserved",
    settledAt: null,
    proofRef: null,
  });
}
async function readLive(deps: ClosedCWaveRecoveryDepsV1) {
  const [repair, release] = await Promise.all([
    deps.state.readRepair(),
    deps.state.readRelease(),
  ]);
  if (
    !repair.ok || repair.value.status !== "found" || !release.ok ||
    release.value.status !== "found"
  ) throw new Error("C recovery authoritative state unavailable");
  return { repair: repair.value, release: release.value };
}
export function closedCWaveHandledReservations(
  snapshot: RepairStateSnapshotV1,
  binding: ClosedCWaveBindingV1 = CLOSED_C_WAVE,
): ReadonlySet<string> {
  return new Set(
    binding.cells.filter((cell) => {
      const charge = snapshot.reservations.find((row) =>
        row.id === cell.reservationId
      );
      const work = snapshot.work.find((row) =>
        row.id === cell.taskId && sameRepo(row.repository, cell.repository)
      );
      if (
        !charge || !work || charge.taskId !== cell.taskId ||
        charge.head !== cell.base ||
        !sameRepo(charge.repository, cell.repository) ||
        charge.settledAt === null || charge.proofRef !== null
      ) return false;
      if (charge.outcome === "ambiguous") {
        return work.intent?.requestId !== charge.id ||
          work.intent.kind !== "implementation" || work.nextStep === "blocked";
      }
      return charge.outcome === "submitted" &&
        (work.intent?.requestId !== charge.id ||
          work.intent.kind !== "implementation") &&
        (work.intent?.requestId !== charge.id ||
          work.intent.kind !== "candidate_preservation" ||
          work.target.head !== null);
    }).map((cell) => cell.reservationId),
  );
}
function neededReservations(
  snapshot: RepairStateSnapshotV1,
  binding: ClosedCWaveBindingV1 = CLOSED_C_WAVE,
): ReadonlySet<string> {
  if (
    !binding.cells.some((cell) =>
      snapshot.reservations.some((row) => row.id === cell.reservationId)
    )
  ) return new Set();
  const handled = closedCWaveHandledReservations(snapshot, binding);
  return new Set(
    binding.cells.filter((cell) => {
      const charge = snapshot.reservations.find((row) =>
        row.id === cell.reservationId
      );
      if (!charge) return true;
      if (!handled.has(charge.id)) return true;
      const work = snapshot.work.find((row) =>
        row.id === cell.taskId && sameRepo(row.repository, cell.repository)
      );
      // Submitted/BLOCKED is a positive protected disposition. Its original
      // head/checkpoint remain available to explicit recovery, but only an
      // actionable preservation intent keeps archives an automatic prerequisite.
      return work?.intent?.kind === "candidate_preservation" &&
        work.intent.requestId === charge.id;
    }).map((cell) => cell.reservationId),
  );
}
export function closedCWaveNeedsRecovery(
  snapshot: RepairStateSnapshotV1,
  binding: ClosedCWaveBindingV1 = CLOSED_C_WAVE,
): boolean {
  return neededReservations(snapshot, binding).size > 0;
}
/** Read-only installer gate reuses the consumer's positive handled predicate. */
export function closedCWaveChargeReadbackVerified(
  original: RepairStateSnapshotV1,
  current: RepairStateSnapshotV1,
  binding: ClosedCWaveBindingV1 = CLOSED_C_WAVE,
): boolean {
  if (
    closedCWaveHandledReservations(current, binding).size !==
      binding.cells.length
  ) return false;
  return binding.cells.every((cell) => {
    const prior = original.reservations.find((row) =>
      row.id === cell.reservationId
    );
    const charged = current.reservations.find((row) =>
      row.id === cell.reservationId
    );
    return prior !== undefined && charged !== undefined &&
      prior.outcome === "reserved" && prior.settledAt === null &&
      prior.proofRef === null &&
      chargeIdentity(prior) === chargeIdentity(charged);
  });
}
export async function recoverClosedCWave(
  deps: ClosedCWaveRecoveryDepsV1,
): Promise<
  {
    wave: MatrixAuthenticatedWaveV1;
    producerProof: HostedRunProofV1;
    repairHead: GitSha;
    releaseHead: GitSha;
  }
> {
  const binding = deps.binding ?? CLOSED_C_WAVE;
  const live = await readLive(deps);
  const needed = neededReservations(live.repair.snapshot, binding);
  if (needed.size === 0) {
    throw new Error("C recovery has no actionable original operations");
  }
  if (
    binding.cells.some((cell) =>
      !live.repair.snapshot.reservations.some((row) =>
        row.id === cell.reservationId
      )
    )
  ) throw new Error("C recovery closed admission scope unavailable");
  if (!deps.state.readRepairAt || !deps.state.readReleaseAt) {
    throw new Error("C recovery authenticated history reader unavailable");
  }
  const [producerRepair, producerRelease] = await Promise.all([
    deps.state.readRepairAt({
      commit: binding.repairCommit,
      expectedHead: live.repair.head,
    }),
    deps.state.readReleaseAt({
      commit: binding.releaseCommit,
      expectedHead: live.release.head,
    }),
  ]);
  if (
    !producerRepair.ok || producerRepair.value.status !== "found" ||
    !producerRelease.ok || producerRelease.value.status !== "found"
  ) throw new Error("C recovery producer custody unavailable");
  const producerSnapshot = producerRepair.value.snapshot;
  const runtime = producerRelease.value.snapshot.hostedRuntimes.find((row) =>
    row.id === HOSTED_RUNTIME_ID
  );
  const held = runtime?.lastExecutionProof;
  const healthy = runtime?.lastHealthyProof;
  if (
    !held || held.outcome !== "failed" ||
    held.execution.purpose !== "ordinary" ||
    held.execution.runId !== binding.run.runId ||
    held.execution.runAttempt !== binding.run.runAttempt ||
    held.execution.launcherSha !== binding.run.launcherSha ||
    held.execution.revision !== binding.runtimeSha ||
    held.execution.generation !== binding.generation || !healthy ||
    healthy.outcome !== "healthy" ||
    healthy.execution.revision !== binding.runtimeSha ||
    healthy.execution.generation !== binding.generation ||
    healthy.finishedAt > held.startedAt
  ) throw new Error("C recovery failed-wave/own-health identity unavailable");
  const producerState: StateReadView = {
    readRepair: () => Promise.resolve(producerRepair),
    readRelease: () => Promise.resolve(producerRelease),
  };
  const transport = await deps.transportFor(producerState);
  if (
    !transport.confirmCompletedExecution ||
    !await transport.confirmCompletedExecution(held.execution)
  ) throw new Error("C recovery native jobs unsettled");
  const native = await deps.readExecution(held.execution);
  if (
    !native.ok || native.value === null ||
    native.value.outcome === "not_started"
  ) throw new Error("C recovery native failure proof unavailable");
  const proof = parseHostedRunProofV1(native.value);
  if (
    canonicalStringify({ ...held, observedAt: proof.observedAt }) !==
      canonicalStringify(proof)
  ) throw new Error("C recovery native failure proof changed");
  const requests = binding.cells.filter((cell) =>
    needed.has(cell.reservationId)
  ).map((cell) => {
    const work = producerSnapshot.work.find((row) =>
      row.id === cell.taskId && sameRepo(row.repository, cell.repository)
    );
    const reservation = producerSnapshot.reservations.find((row) =>
      row.id === cell.reservationId
    );
    if (
      !work || !reservation || work.intent?.kind !== "implementation" ||
      work.intent.requestId !== cell.reservationId ||
      work.intent.observedBase !== cell.base ||
      reservation.taskId !== cell.taskId || reservation.head !== cell.base ||
      !sameRepo(reservation.repository, cell.repository)
    ) throw new Error("C recovery original admission binding unavailable");
    return {
      taskId: work.id,
      repository: work.repository,
      reservationId: reservation.id,
      intentKey: work.intent.key,
      expectedBase: reservation.head,
      attempt: reservation.attempt,
    };
  });
  const waves = await transport.recover({
    requests,
    runtimeSha: binding.runtimeSha,
    launcherSha: binding.run.launcherSha,
    currentRun: binding.run,
  });
  if (waves.length !== 1) throw new Error("C recovery exact wave unavailable");
  const wave = waves[0];
  if (
    wave.planDigest !== binding.planDigest ||
    await matrixDigestV1(wave.plan) !== binding.planDigest ||
    canonicalStringify(wave.plan.run) !== canonicalStringify(binding.run) ||
    wave.plan.cells.length !== binding.cells.length ||
    wave.results.length !== needed.size ||
    wave.results.some((row) => !needed.has(row.reservationId)) ||
    wave.plan.cells.some((cell) =>
      cell.runtimeSha !== binding.runtimeSha ||
      cell.generation !== binding.generation ||
      !binding.cells.some((expected) =>
        expected.reservationId === cell.reservationId &&
        expected.taskId === cell.taskId &&
        expected.base === cell.expectedBase &&
        sameRepo(expected.repository, cell.repository)
      )
    )
  ) throw new Error("C recovery plan/result producer mismatch");
  const fresh = await readLive(deps);
  if (fresh.release.head !== live.release.head) {
    throw new Error("C recovery release custody changed");
  }
  return {
    wave,
    producerProof: proof,
    repairHead: fresh.repair.head,
    releaseHead: fresh.release.head,
  };
}
export async function ingestClosedCWave(
  deps: ClosedCWaveRecoveryDepsV1,
  maintenance = true,
) {
  const binding = deps.binding ?? CLOSED_C_WAVE;
  const live = await readLive(deps);
  const needed = neededReservations(live.repair.snapshot, binding);
  if (needed.size === 0) {
    return {
      producer: binding.run,
      repairHead: live.repair.head,
      releaseHead: live.release.head,
      dispositions: [],
      reports: [],
    };
  }
  if (
    maintenance &&
    live.release.snapshot.hostedRuntimes.some((row) => row.execution !== null)
  ) throw new Error("C recovery current execution in flight");
  if (
    maintenance &&
    live.release.snapshot.hostedReleases.some((row) =>
      row.phase !== "accepted" && row.phase !== "rolled_back"
    )
  ) throw new Error("C recovery release is not terminal");
  if (
    [
      ...live.repair.snapshot.githubCooldowns,
      ...live.release.snapshot.githubCooldowns,
    ].some((row) =>
      row.retryNotBefore === null || row.retryNotBefore > deps.clock.now()
    )
  ) throw new Error("C recovery cooldown active");
  const recovered = await recoverClosedCWave(deps);
  if (recovered.repairHead !== live.repair.head) {
    throw new Error("C recovery repair custody changed before ingestion");
  }
  const before = live.repair.snapshot;
  const reports = [];
  if (
    recovered.wave.plan.cells.some((cell) =>
      !deps.configs.some((config) =>
        sameRepo(config.repository, cell.repository)
      )
    )
  ) throw new Error("C recovery target configuration unavailable");
  for (const config of deps.configs) {
    const read = await deps.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("C recovery current repair unavailable");
    }
    const snapshot = read.value.snapshot;
    const handled = closedCWaveHandledReservations(snapshot, binding);
    const cells = recovered.wave.plan.cells.filter((cell) =>
      needed.has(cell.reservationId) &&
      sameRepo(cell.repository, config.repository) &&
      (!handled.has(cell.reservationId) ||
        snapshot.work.some((row) =>
          row.id === cell.taskId &&
          row.intent?.kind === "candidate_preservation" &&
          row.intent.requestId === cell.reservationId
        ))
    );
    if (cells.length === 0) continue;
    await deps.prepareTarget(config);
    const importer = deps.importerFor(config, recovered.wave.bundlesDir);
    const cycle = deps.cycleFor(config);
    const report = await ingestMatrixResults(
      {
        ...cycle,
        model: {
          modelId: cycle.model.modelId,
          runModel: () => {
            throw new Error("C recovery cannot start a model");
          },
        },
      },
      { ...recovered.wave.plan, cells },
      recovered.wave.results.filter((result) =>
        cells.some((cell) => cell.cellId === result.cellId)
      ),
      {
        deadline: deps.clock.now() + 240_000,
        expectedProvider: binding.expectedProvider,
        bundleImporter: importer,
      },
    );
    if (
      report.entries.some((entry) =>
        entry.disposition !== "ingested" && entry.disposition !== "duplicate"
      )
    ) throw new Error("C recovery ingestion incomplete");
    reports.push(report);
  }
  const after = await readLive(deps);
  if (after.release.head !== recovered.releaseHead) {
    throw new Error("C recovery release changed during ingestion");
  }
  const dispositions = binding.cells.filter((cell) =>
    needed.has(cell.reservationId)
  ).map((cell) => {
    const prior = before.reservations.find((row) =>
      row.id === cell.reservationId
    );
    const charged = after.repair.snapshot.reservations.find((row) =>
      row.id === cell.reservationId
    );
    const work = after.repair.snapshot.work.find((row) =>
      row.id === cell.taskId && sameRepo(row.repository, cell.repository)
    );
    if (
      !prior || !charged || !work ||
      chargeIdentity(prior) !== chargeIdentity(charged) ||
      charged.settledAt === null || charged.proofRef !== null ||
      (charged.outcome !== "submitted" && charged.outcome !== "ambiguous")
    ) throw new Error("C recovery settlement readback unavailable");
    if (
      charged.outcome === "ambiguous" &&
      (work.nextStep !== "blocked" || work.intent?.kind !== "implementation" ||
        work.intent.requestId !== charged.id)
    ) throw new Error("C recovery ambiguous intent readback unavailable");
    if (
      charged.outcome === "submitted" &&
      (work.target.head === null ||
        work.target.head !==
          recovered.wave.results.find((result) =>
            result.reservationId === charged.id
          )?.receipt?.candidate?.head)
    ) throw new Error("C recovery candidate readback unavailable");
    return {
      reservationId: charged.id,
      taskId: work.id,
      outcome: charged.outcome,
      nextStep: work.nextStep,
      intentKind: work.intent?.kind ?? null,
      head: work.target.head,
      checkpoint: work.target.checkpoint,
    };
  });
  const known = needed;
  if (
    canonicalStringify(
        before.reservations.filter((row) => !known.has(row.id)),
      ) !==
      canonicalStringify(
        after.repair.snapshot.reservations.filter((row) => !known.has(row.id)),
      ) ||
    canonicalStringify(
        before.work.filter((row) =>
          !binding.cells.some((cell) =>
            needed.has(cell.reservationId) && cell.taskId === row.id &&
            sameRepo(cell.repository, row.repository)
          )
        ),
      ) !==
      canonicalStringify(
        after.repair.snapshot.work.filter((row) =>
          !binding.cells.some((cell) =>
            needed.has(cell.reservationId) && cell.taskId === row.id &&
            sameRepo(cell.repository, row.repository)
          )
        ),
      )
  ) throw new Error("C recovery unrelated state changed");
  return {
    producer: binding.run,
    repairHead: after.repair.head,
    releaseHead: after.release.head,
    dispositions,
    reports,
  };
}
