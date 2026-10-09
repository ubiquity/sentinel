/**
 * One-shot owner-authorized disposition for the sixteen historical retry
 * admissions stuck by the missing-artifact matrix wave 37354374590.
 *
 * The wave ran on the closed-C runtime on 2026-10-05; only eight of its
 * twenty-four cells ever uploaded artifacts. The runtime correctly refuses to
 * claim anything about the missing cells, so their implementation intents stay
 * `work` with `reserved` retry charges and their issues can never be selected
 * again. This helper applies exactly one bounded transition for exactly these
 * sixteen records: the reservation settles as `ambiguous` (the charge and its
 * history are retained, nothing is refunded) and the record blocks with the
 * runtime's own "model run did not complete with a trusted candidate" reason,
 * which the hosted autonomy retry pass already owns. Nothing else is touched.
 *
 * It is NOT a general maintenance framework and NOT a policy change: no
 * release state, receipt, evidence, review or candidate is written, and no
 * other record or reservation is modified. The core planner is pure so tests
 * run against real contract parsers without credentials.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-run=git,gh --allow-net=api.github.com \
 *     --allow-env=GH_TOKEN,PATH,HOME,TMPDIR,DENO_DIR ops/historical-retry-disposition.ts --dry-run
 *   ... --apply   (refuses while any hosted runtime execution is in flight)
 */
import type { GitSha } from "../src/contracts/brands.ts";
import type {
  RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import { markBlocked } from "../src/repair/transitions.ts";
import { createRepairStateStore, DenoGitRunner } from "../src/state/mod.ts";
import { githubGitAuthEnv } from "../src/host/local.ts";

/** The runtime's own incomplete-receipt reason; hosted autonomy retries it. */
export const HISTORICAL_RETRY_DISPOSITION_MESSAGE =
  "model run did not complete with a trusted candidate";

/** The only repository the bound records belong to. */
export const HISTORICAL_RETRY_DISPOSITION_REPOSITORY = "ubiquity/ai.ubq.fi";

export interface HistoricalRetryBindingV1 {
  readonly id: string;
  readonly reservationId: string;
  readonly base: GitSha;
}

/** Exact owner-authorized binding: record id, retry reservation, frozen base. */
export const HISTORICAL_RETRY_DISPOSITION_BINDING_V1:
  readonly HistoricalRetryBindingV1[] = [
    {
      id: "issue-ubiquity-ai.ubq.fi-398",
      reservationId:
        "8da7cfad2230c22de6955d53a2b6923ce1734dd825a2440c43d6a74440c99a09",
      base: "3691fe4a36e4e4c6aae6f8c6aa04c12ed3ff6698" as GitSha,
    },
    {
      id: "issue-ubiquity-ai.ubq.fi-420",
      reservationId:
        "3cb86e0f76b76aadaaac176c172e43effb5c8533c7d1b3ca1339f548da534af5",
      base: "3691fe4a36e4e4c6aae6f8c6aa04c12ed3ff6698" as GitSha,
    },
    {
      id: "issue-ubiquity-ai.ubq.fi-421",
      reservationId:
        "fb79ebbb9552de0df004fdf8d19ec2bd2be7dc8ac36b94efb98dddce72d0804e",
      base: "3691fe4a36e4e4c6aae6f8c6aa04c12ed3ff6698" as GitSha,
    },
    {
      id: "issue-ubiquity-ai.ubq.fi-427",
      reservationId:
        "1bc96d7012496ae85316abdd6e68914fa9944288c71a5fade3f8005533d08ebc",
      base: "3691fe4a36e4e4c6aae6f8c6aa04c12ed3ff6698" as GitSha,
    },
    {
      id: "issue-ubiquity-ai.ubq.fi-541",
      reservationId:
        "d53181817d837b13f62ab7ee92fd7e540d576312c90239cebc4c0d7268a4e0d0",
      base: "3691fe4a36e4e4c6aae6f8c6aa04c12ed3ff6698" as GitSha,
    },
    {
      id: "issue-ubiquity-ai.ubq.fi-570",
      reservationId:
        "487ed315f82ff0bd132fbe8fa97b6fd736f1fdc2701497367cb981f8ced0161d",
      base: "3691fe4a36e4e4c6aae6f8c6aa04c12ed3ff6698" as GitSha,
    },
    {
      id: "issue-ubiquity-ai.ubq.fi-575",
      reservationId:
        "128b0db9b4f8c157f953b9ecfb18544ee04f019fb78eeec7ddf7e649a031d522",
      base: "3691fe4a36e4e4c6aae6f8c6aa04c12ed3ff6698" as GitSha,
    },
    {
      id: "issue-ubiquity-ai.ubq.fi-577",
      reservationId:
        "8f4f55cb4af1c3e543e36556da8890c1a9c11b913415d4cfb0c3e35c5118241a",
      base: "3691fe4a36e4e4c6aae6f8c6aa04c12ed3ff6698" as GitSha,
    },
    {
      id: "issue-ubiquity-ai.ubq.fi-583",
      reservationId:
        "63988226e9739da266ce14de1cce5746d662220e39a8ddcb99337ab40b405d69",
      base: "3691fe4a36e4e4c6aae6f8c6aa04c12ed3ff6698" as GitSha,
    },
    {
      id: "issue-ubiquity-ai.ubq.fi-587",
      reservationId:
        "0d8da09d774019c738f09dfdd6a249993a7bd49ffeb03b21b4629132e739cd44",
      base: "3691fe4a36e4e4c6aae6f8c6aa04c12ed3ff6698" as GitSha,
    },
    {
      id: "issue-ubiquity-ai.ubq.fi-589",
      reservationId:
        "53437275fa4adaa9788d2ca51b971cc0a3744611c5cf281d84b95c4d8d73fed7",
      base: "3691fe4a36e4e4c6aae6f8c6aa04c12ed3ff6698" as GitSha,
    },
    {
      id: "issue-ubiquity-ai.ubq.fi-592",
      reservationId:
        "73535d9286a092a3f7b2d96c22a8ef6a0f935b975d09006cd7e418fc867d91cd",
      base: "3691fe4a36e4e4c6aae6f8c6aa04c12ed3ff6698" as GitSha,
    },
    {
      id: "issue-ubiquity-ai.ubq.fi-608",
      reservationId:
        "c97ba108b7c9e9aaa01bc0ac765ed962292f20514b66ec99913320d42e26eb2d",
      base: "3691fe4a36e4e4c6aae6f8c6aa04c12ed3ff6698" as GitSha,
    },
    {
      id: "issue-ubiquity-ai.ubq.fi-610",
      reservationId:
        "99255d8f4e420dc7947a6bc5fc6acfb47d33e2acbb9b4234264bf2ac735d3437",
      base: "3691fe4a36e4e4c6aae6f8c6aa04c12ed3ff6698" as GitSha,
    },
    {
      id: "issue-ubiquity-ai.ubq.fi-611",
      reservationId:
        "6ca9fd2eb1ad7e38d7c5676fd15e1f80dfa0fa3339064a7711e60d53a9bd5fcc",
      base: "3691fe4a36e4e4c6aae6f8c6aa04c12ed3ff6698" as GitSha,
    },
    {
      id: "issue-ubiquity-ai.ubq.fi-617",
      reservationId:
        "097cf4dcf51d6b671e0014bda5db042fe0f61b7823d978fa71bddf7560c9baae",
      base: "3691fe4a36e4e4c6aae6f8c6aa04c12ed3ff6698" as GitSha,
    },
  ];

export type HistoricalRetryPlanV1 =
  | {
    ok: true;
    snapshot: RepairStateSnapshotV1;
    transitions: readonly { id: string; reservationId: string }[];
  }
  | { ok: false; refused: string };

/**
 * Pure planner. Every bound record must still be the exact untouched retry
 * admission this disposition was authorized for; any deviation refuses the
 * whole batch so a moved, settled or unrelated state is never modified.
 */
export function planHistoricalRetryDisposition(
  snapshot: RepairStateSnapshotV1,
  binding: readonly HistoricalRetryBindingV1[],
  now: number,
): HistoricalRetryPlanV1 {
  if (binding.length === 0) return { ok: false, refused: "empty binding" };
  if (!Number.isSafeInteger(now) || now < 0) {
    return { ok: false, refused: "invalid clock" };
  }
  const workById = new Map<string, (typeof snapshot.work)[number]>(
    snapshot.work.map((record) => [String(record.id), record]),
  );
  const seen = new Set<string>();
  for (const entry of binding) {
    if (seen.has(entry.id)) return { ok: false, refused: "duplicate binding" };
    seen.add(entry.id);
    const record = workById.get(entry.id);
    if (record === undefined) {
      return { ok: false, refused: "missing bound record: " + entry.id };
    }
    const repository = record.repository.owner + "/" + record.repository.name;
    if (repository !== HISTORICAL_RETRY_DISPOSITION_REPOSITORY) {
      return { ok: false, refused: "foreign bound record: " + entry.id };
    }
    if (record.nextStep !== "work" || record.target.head !== null) {
      return { ok: false, refused: "bound record already moved: " + entry.id };
    }
    if (record.target.base !== entry.base) {
      return { ok: false, refused: "bound base changed: " + entry.id };
    }
    if (
      record.intent?.kind !== "implementation" ||
      record.intent.requestId !== entry.reservationId
    ) {
      return { ok: false, refused: "bound intent changed: " + entry.id };
    }
    const reservations = snapshot.reservations.filter((row) =>
      row.id === entry.reservationId
    );
    if (reservations.length !== 1) {
      return { ok: false, refused: "bound reservation missing: " + entry.id };
    }
    const reservation = reservations[0];
    if (
      String(reservation.taskId) !== entry.id ||
      reservation.outcome !== "reserved" ||
      reservation.purpose !== "retry"
    ) {
      return { ok: false, refused: "bound reservation changed: " + entry.id };
    }
  }
  const workIds = new Set(binding.map((entry) => entry.id));
  const reservationIds = new Set(binding.map((entry) => entry.reservationId));
  const work = snapshot.work.map((record) =>
    workIds.has(record.id)
      ? markBlocked(
        record,
        "other",
        HISTORICAL_RETRY_DISPOSITION_MESSAGE,
        now,
      )
      : record
  );
  const reservations = snapshot.reservations.map((row) =>
    reservationIds.has(row.id)
      ? {
        ...row,
        outcome: "ambiguous" as const,
        settledAt: now,
        proofRef: null,
      }
      : row
  );
  return {
    ok: true,
    snapshot: {
      ...snapshot,
      sequence: snapshot.sequence + 1,
      updatedAt: now,
      work,
      reservations,
    },
    transitions: binding.map((entry) => ({
      id: entry.id,
      reservationId: entry.reservationId,
    })),
  };
}

function sh(
  command: string,
  args: string[],
): { code: number; stdout: string } {
  const out = new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "null",
  }).outputSync();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
}

function resolveToken(): string {
  const fromEnv = Deno.env.get("GH_TOKEN");
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  const result = sh("gh", ["auth", "token"]);
  if (result.code !== 0 || result.stdout.trim().length === 0) {
    throw new Error("no GitHub token available");
  }
  return result.stdout.trim();
}

export async function runHistoricalRetryDispositionMain(
  input: { apply: boolean; token?: string; scratch?: string },
): Promise<number> {
  const token = input.token ?? resolveToken();
  const scratch = input.scratch ??
    ((Deno.env.get("TMPDIR") ?? "/tmp") + "/sentinel-fast-lane");
  await Deno.mkdir(scratch, { recursive: true });
  const state = createRepairStateStore({
    scratchDir: scratch,
    remoteUrl: "https://github.com/ubiquity/sentinel.git",
    runner: new DenoGitRunner(
      scratch + "/state-git-home",
      githubGitAuthEnv(token),
    ),
  });
  const repair = await state.readRepair();
  if (!repair.ok || repair.value.status !== "found") {
    console.log(
      JSON.stringify({
        kind: "historical_retry_disposition",
        status: "unavailable",
      }),
    );
    return 1;
  }
  const planned = planHistoricalRetryDisposition(
    repair.value.snapshot,
    HISTORICAL_RETRY_DISPOSITION_BINDING_V1,
    Date.now(),
  );
  if (!planned.ok) {
    console.log(JSON.stringify({
      kind: "historical_retry_disposition",
      status: "refused",
      detail: planned.refused,
    }));
    return 1;
  }
  const summary = {
    kind: "historical_retry_disposition",
    status: input.apply ? "applying" : "dry_run",
    head: repair.value.head,
    transitions: planned.transitions.length,
  };
  if (!input.apply) {
    console.log(JSON.stringify(summary));
    return 0;
  }
  const release = await state.readRelease();
  if (
    !release.ok || release.value.status !== "found" ||
    release.value.snapshot.hostedRuntimes.some((runtime) =>
      runtime.execution !== null
    )
  ) {
    console.log(JSON.stringify({
      ...summary,
      status: "refused",
      detail: "a hosted runtime execution is in flight",
    }));
    return 1;
  }
  const written = await state.writeRepair(planned.snapshot, repair.value.head);
  if (!written.ok || written.value.status !== "applied") {
    console.log(JSON.stringify({
      ...summary,
      status: "not_applied",
      detail: written.ok ? written.value.status : written.error.kind,
    }));
    return 1;
  }
  const readback = await state.readRepair();
  if (!readback.ok || readback.value.status !== "found") {
    console.log(JSON.stringify({ ...summary, status: "unreadable" }));
    return 1;
  }
  const blocked = new Set(
    readback.value.snapshot.work
      .filter((record) =>
        planned.transitions.some((entry) => entry.id === record.id) &&
        record.nextStep === "blocked" &&
        record.blocker?.message === HISTORICAL_RETRY_DISPOSITION_MESSAGE
      )
      .map((record) => record.id),
  );
  const settled = new Set(
    readback.value.snapshot.reservations
      .filter((row) =>
        planned.transitions.some((entry) => entry.reservationId === row.id) &&
        row.outcome === "ambiguous"
      )
      .map((row) => row.id),
  );
  if (
    blocked.size !== planned.transitions.length ||
    settled.size !== planned.transitions.length
  ) {
    console.log(JSON.stringify({
      ...summary,
      status: "readback_mismatch",
      blocked: blocked.size,
      settled: settled.size,
    }));
    return 1;
  }
  console.log(JSON.stringify({
    ...summary,
    status: "applied",
    head: readback.value.head,
  }));
  return 0;
}

if (import.meta.main) {
  const apply = Deno.args.includes("--apply");
  const code = await runHistoricalRetryDispositionMain({ apply });
  Deno.exit(code);
}
