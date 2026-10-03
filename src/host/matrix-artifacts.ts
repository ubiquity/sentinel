/** Read-only authenticated Actions transport for exact admitted matrix waves. */
import { Uint8ArrayReader, ZipReader } from "@zip.js/zip.js";
import { isAbsolute, resolve, sep } from "node:path";
import {
  HOSTED_ACTIONS_CLOCK_TOLERANCE_MS as TOLERANCE,
  HOSTED_SUPERVISOR_REF,
  HOSTED_SUPERVISOR_REPOSITORY as REPOSITORY,
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
  type HostedExecutionIntentV1,
} from "../contracts/hosted-supervisor.ts";
import {
  matrixCellIdV1,
  type MatrixCellPlanV1,
  matrixDigestV1,
  type MatrixRunIdentityV1,
  MAX_MATRIX_ARCHIVE_BYTES,
  MAX_MATRIX_ARTIFACT_BYTES,
  MAX_MATRIX_BUNDLE_BYTES,
  parseMatrixCellResultV1,
  parseMatrixPlanV1,
} from "../contracts/matrix.ts";
import type { Clock, StateReadView } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import {
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
} from "../repair/keys.ts";
import {
  createDeadline,
  DEFAULT_HTTP_MAX_BODY_BYTES,
  type FetchLikeV1,
  fromFetch,
  type HttpResponseV1,
  type HttpTransportV1,
} from "../github/http.ts";
import type {
  MatrixArtifactRequestV1,
  MatrixArtifactTransportV1,
  MatrixAuthenticatedWaveV1,
} from "./matrix-artifact-port.ts";

const API = `https://api.github.com/repos/${REPOSITORY}/actions`;
const MAX_ITEMS = 10_000;
const MARKER_KEYS = {
  sentinel_matrix_plan: [
    "kind",
    "waveId",
    "run",
    "runtimeSha",
    "generation",
    "planDigest",
    "prepared",
  ],
  sentinel_matrix_cell: [
    "kind",
    "run",
    "runtimeSha",
    "generation",
    "cellId",
    "reservationId",
    "resultDigest",
    "bundleDigest",
    "status",
  ],
};

type Json = Record<string, unknown>;
function refuse(): never {
  throw new Error("matrix artifact provenance unavailable or conflicting");
}
function record(value: unknown): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    refuse();
  }
  return value as Json;
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) refuse();
  return value as number;
}
function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) refuse();
  return value;
}
function instant(value: unknown): number {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    refuse();
  }
  return Date.parse(value);
}
function sameRepo(a: RepositoryIdentityV1, b: RepositoryIdentityV1): boolean {
  return a.owner === b.owner && a.name === b.name &&
    a.installationId === b.installationId;
}
function sameRun(
  a: MatrixRunIdentityV1,
  b: Json | MatrixRunIdentityV1,
): boolean {
  return a.runId === b.runId && a.runAttempt === b.runAttempt &&
    a.launcherSha === b.launcherSha;
}
async function bytesDigest(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())),
  ].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function storageUrl(location: string | null): string {
  if (location === null) refuse();
  const url = new URL(location);
  if (
    url.protocol !== "https:" || url.port !== "" || url.username !== "" ||
    url.password !== "" || url.hash !== "" ||
    !/^productionresultssa[0-9]+\.blob\.core\.windows\.net$/.test(url.hostname)
  ) refuse();
  return url.toString();
}

/** Dedicated bounded archive bytes; ordinary metadata/log bodies retain 8 MiB. */
export function createActionsMatrixArtifactHttpTransport(
  fetchFn: FetchLikeV1 = globalThis.fetch as unknown as FetchLikeV1,
): HttpTransportV1 {
  const text = fromFetch(fetchFn);
  const archive = fromFetch(fetchFn, {
    maxBodyBytes: MAX_MATRIX_ARCHIVE_BYTES,
  });
  return (request) =>
    request.responseType === "bytes" ? archive(request) : text(request);
}

/** No shared-state or external write capability is accepted by this factory. */
export function createActionsMatrixArtifactTransport(options: {
  state: StateReadView;
  token: string;
  http: HttpTransportV1;
  clock: Clock;
  artifactRoot: string;
}): MatrixArtifactTransportV1 {
  return {
    async recover(input) {
      if (input.requests.length === 0) return [];
      const deadline = createDeadline(120_000);
      const controller = new AbortController();
      let staging: string | null = null;
      try {
        if (!options.token || !isAbsolute(options.artifactRoot)) refuse();
        if (
          input.currentRun && input.currentRun.launcherSha !== input.launcherSha
        ) refuse();
        const root = resolve(options.artifactRoot);
        const checkout = await Deno.realPath(Deno.cwd());
        if (root === checkout || root.startsWith(checkout + sep)) refuse();
        await Deno.mkdir(root, { recursive: true, mode: 0o700 });
        const realRoot = await Deno.realPath(root);
        if (realRoot === checkout || realRoot.startsWith(checkout + sep)) {
          refuse();
        }
        const [repair, release] = await deadline.race(
          Promise.all([
            options.state.readRepair(),
            options.state.readRelease(),
          ]),
        );
        if (
          !repair.ok || repair.value.status !== "found" || !release.ok ||
          release.value.status !== "found"
        ) refuse();
        const snapshot = repair.value.snapshot;
        const requested = new Map<string, MatrixArtifactRequestV1>();
        for (const request of input.requests) {
          if (requested.has(request.reservationId)) refuse();
          const reservations = snapshot.reservations.filter((row) =>
            row.id === request.reservationId
          );
          const work = snapshot.work.filter((row) =>
            row.id === request.taskId &&
            sameRepo(row.repository, request.repository)
          );
          if (reservations.length !== 1 || work.length !== 1) refuse();
          const reservation = reservations[0],
            task = work[0],
            intent = task.intent;
          const implementing = intent?.kind === "implementation" &&
            intent.expectedHead === null && intent.resultId === null;
          const preserving = intent?.kind === "candidate_preservation" &&
            reservation.outcome === "submitted" &&
            reservation.settledAt !== null && task.target.head !== null &&
            task.target.head !== task.target.base &&
            intent.expectedHead === task.target.head &&
            intent.resultId === null && intent.pr === null &&
            task.target.candidateState?.preserved === null &&
            intent.startedAt >= reservation.createdAt &&
            intent.startedAt <= options.clock.now() + TOLERANCE &&
            intent.branch === await candidatePreservationRef(
                task.repository,
                task.id,
                request.intentKey,
              );
          if (
            reservation.taskId !== request.taskId ||
            !sameRepo(reservation.repository, request.repository) ||
            reservation.attempt !== request.attempt ||
            reservation.head !== request.expectedBase ||
            reservation.purpose === "review_request" ||
            reservation.outcome === "confirmed_not_submitted" ||
            task.nextStep !== "work" ||
            task.target.base !== request.expectedBase ||
            (!implementing && !preserving) ||
            intent?.key !== request.intentKey ||
            request.intentKey !==
              implementationIntentKey(request.reservationId) ||
            intent.requestId !== request.reservationId ||
            intent.observedBase !== request.expectedBase
          ) refuse();
          requested.set(request.reservationId, request);
        }
        const saved: HostedExecutionIntentV1[] = [];
        for (const runtime of release.value.snapshot.hostedRuntimes) {
          if (runtime.execution) saved.push(runtime.execution);
          if (runtime.lastExecutionProof) {
            saved.push(runtime.lastExecutionProof.execution);
          }
          if (runtime.lastHealthyProof) {
            saved.push(runtime.lastHealthyProof.execution);
          }
        }
        for (const row of release.value.snapshot.hostedReleases) {
          for (
            const proof of [
              row.priorProof,
              row.candidateProof,
              row.rollbackProof,
            ]
          ) if (proof) saved.push(proof.execution);
        }
        const get = async (
          path: string,
          binary = false,
          storage = false,
        ): Promise<HttpResponseV1> => {
          const response = await deadline.race(
            options.http({
              method: "GET",
              url: path,
              headers: storage
                ? new Map()
                : new Map([["authorization", `Bearer ${options.token}`], [
                  "accept",
                  "application/vnd.github+json",
                ], ["x-github-api-version", "2022-11-28"]]),
              body: null,
              redirect: storage ? "error" : "manual",
              ...(binary ? { responseType: "bytes" as const } : {}),
            }),
          );
          if (
            new TextEncoder().encode(response.bodyText).length >
              DEFAULT_HTTP_MAX_BODY_BYTES ||
            (response.bodyBytes?.length ?? 0) > MAX_MATRIX_ARCHIVE_BYTES
          ) refuse();
          return response;
        };
        const json = async (path: string): Promise<Json> => {
          const response = await get(path);
          if (response.status !== 200) refuse();
          return record(JSON.parse(response.bodyText));
        };
        const pages = async (path: string, key: string): Promise<Json[]> => {
          const items: Json[] = [];
          let total: number | null = null;
          for (let page = 1; page <= 100; page++) {
            const url = `${API}${path}?per_page=100&page=${page}`;
            const response = await get(url);
            if (response.status !== 200) refuse();
            const body = record(JSON.parse(response.bodyText));
            if (
              !Number.isSafeInteger(body.total_count) ||
              (body.total_count as number) < 0 ||
              (body.total_count as number) > MAX_ITEMS
            ) refuse();
            if (total !== null && total !== body.total_count) refuse();
            total = body.total_count as number;
            if (!Array.isArray(body[key]) || body[key].length > 100) refuse();
            items.push(...body[key].map(record));
            if (items.length > total) refuse();
            const link = response.headers.get("link");
            const next = link?.match(/<([^>]+)>;\s*rel="next"/);
            if (
              next && next[1] !== `${API}${path}?per_page=100&page=${page + 1}`
            ) refuse();
            if (!next && items.length === total) {
              const ids = items.map((row) => positive(row.id));
              if (new Set(ids).size !== ids.length) refuse();
              return items;
            }
            if (!next || body[key].length === 0) refuse();
          }
          refuse();
        };
        const download = async (
          path: string,
          binary: boolean,
        ): Promise<HttpResponseV1> => {
          const redirect = await get(`${API}${path}`);
          if (redirect.status !== 302) refuse();
          const response = await get(
            storageUrl(redirect.headers.get("location")),
            binary,
            true,
          );
          if (response.status !== 200) refuse();
          return response;
        };
        const archive = async (
          artifact: Json,
        ): Promise<Map<string, Uint8Array>> => {
          if (
            artifact.expired !== false || typeof artifact.digest !== "string" ||
            !/^sha256:[0-9a-f]{64}$/.test(artifact.digest) ||
            !Number.isSafeInteger(artifact.size_in_bytes) ||
            (artifact.size_in_bytes as number) <= 0 ||
            (artifact.size_in_bytes as number) > MAX_MATRIX_ARCHIVE_BYTES
          ) refuse();
          const response = await download(
            `/artifacts/${positive(artifact.id)}/zip`,
            true,
          );
          const bytes = response.bodyBytes;
          if (
            !bytes || bytes.length !== artifact.size_in_bytes ||
            `sha256:${await bytesDigest(bytes)}` !== artifact.digest
          ) refuse();
          const reader = new ZipReader(new Uint8ArrayReader(bytes), {
            useWebWorkers: false,
            strictness: "strict",
            checkSignature: true,
            checkOverlappingEntry: true,
          });
          const files = new Map<string, Uint8Array>();
          try {
            for await (const entry of reader.getEntriesGenerator()) {
              const name = entry.filename;
              const type = (entry.externalFileAttributes >>> 16) & 0xf000;
              const limit = name.endsWith(".bundle")
                ? MAX_MATRIX_BUNDLE_BYTES
                : MAX_MATRIX_ARTIFACT_BYTES;
              if (
                files.size >= 2 || files.has(name) ||
                !/^(?:plan\.json|result\.json|[0-9a-f]{64}\.bundle)$/.test(
                  name,
                ) || entry.directory || entry.encrypted ||
                (type !== 0 && type !== 0x8000) || entry.setuid ||
                entry.setgid || entry.executable ||
                entry.uncompressedSize < 0 || entry.uncompressedSize > limit ||
                !Number.isSafeInteger(entry.uncompressedSize)
              ) refuse();
              const chunks: Uint8Array[] = [];
              let length = 0;
              await deadline.race(
                entry.getData(
                  new WritableStream<Uint8Array>({
                    write(chunk) {
                      length += chunk.length;
                      if (length > limit) refuse();
                      chunks.push(chunk.slice());
                    },
                  }),
                  { signal: controller.signal, checkSignature: true },
                ),
              );
              if (length !== entry.uncompressedSize) refuse();
              const content = new Uint8Array(length);
              let offset = 0;
              for (const chunk of chunks) {
                content.set(chunk, offset);
                offset += chunk.length;
              }
              files.set(name, content);
            }
          } finally {
            await reader.close();
          }
          return files;
        };
        const marker = async (
          job: Json,
          stepName: string,
          kind: keyof typeof MARKER_KEYS,
          run: MatrixRunIdentityV1,
        ): Promise<Json> => {
          if (
            job.run_id !== run.runId || job.run_attempt !== run.runAttempt ||
            job.head_sha !== run.launcherSha || job.status !== "completed" ||
            !["success", "failure"].includes(String(job.conclusion)) ||
            !Array.isArray(job.steps)
          ) refuse();
          const steps = job.steps.map(record).filter((step) =>
            step.name === stepName
          );
          if (
            steps.length !== 1 || steps[0].status !== "completed" ||
            !["success", "failure"].includes(String(steps[0].conclusion))
          ) refuse();
          const step = steps[0],
            start = instant(step.started_at),
            end = instant(step.completed_at);
          if (
            end < start || end > options.clock.now() + TOLERANCE ||
            start + TOLERANCE < instant(job.started_at) ||
            end > instant(job.completed_at) + TOLERANCE
          ) refuse();
          const response = await download(
            `/jobs/${positive(job.id)}/logs`,
            false,
          );
          const found: Json[] = [];
          for (const line of response.bodyText.split("\n")) {
            const match = line.match(
              /^(\d{4}-\d{2}-\d{2}T\S+Z)\s+(\{.*\})\s*$/,
            );
            if (!match) continue;
            let value: Json;
            try {
              value = record(JSON.parse(match[2]));
            } catch {
              continue;
            }
            if (value.kind !== kind) continue;
            const at = instant(match[1]);
            if (
              at + TOLERANCE < start || at > end + TOLERANCE ||
              Object.keys(value).sort().join() !==
                [...MARKER_KEYS[kind]].sort().join()
            ) refuse();
            if (
              !sameRun(run, record(value.run)) ||
              value.runtimeSha !== input.runtimeSha
            ) refuse();
            positive(value.generation);
            found.push(value);
          }
          if (found.length !== 1) refuse();
          return found[0];
        };
        const artifacts = await pages(
          input.currentRun
            ? `/runs/${input.currentRun.runId}/artifacts`
            : "/artifacts",
          "artifacts",
        );
        const possiblePlans = artifacts.filter((row) =>
          typeof row.name === "string" &&
          /^sentinel-matrix-plan-[1-9][0-9]*-[1-9][0-9]*$/.test(row.name)
        );
        const names = artifacts.map((row) => row.name);
        const plans: Json[] = [];
        for (const artifact of possiblePlans) {
          const [, runId, attempt] = (artifact.name as string).match(
            /^sentinel-matrix-plan-(\d+)-(\d+)$/,
          )!;
          if (input.currentRun) {
            if (
              Number(runId) === input.currentRun.runId &&
              Number(attempt) === input.currentRun.runAttempt
            ) plans.push(artifact);
            continue;
          }
          // Opaque native names select potential recoveries without reading unrelated archives.
          for (const request of requested.values()) {
            const cellId = await matrixCellIdV1(
              `${runId}:${attempt}:repair`,
              request.taskId,
              request.reservationId,
            );
            if (
              names.includes(
                `sentinel-matrix-cell-${runId}-${attempt}-${cellId}`,
              )
            ) {
              plans.push(artifact);
              break;
            }
          }
        }
        if (new Set(plans.map((row) => row.name)).size !== plans.length) {
          refuse();
        }
        staging = await Deno.makeTempDir({
          dir: realRoot,
          prefix: "authenticated-wave-",
        });
        const recovered: MatrixAuthenticatedWaveV1[] = [];
        const seen = new Set<string>();
        for (const artifact of plans) {
          const [, runId, runAttempt] = (artifact.name as string).match(
            /^sentinel-matrix-plan-(\d+)-(\d+)$/,
          )!;
          const run = {
            runId: positive(Number(runId)),
            runAttempt: positive(Number(runAttempt)),
            launcherSha: input.launcherSha,
          };
          if (input.currentRun && !sameRun(input.currentRun, run)) continue;
          const planFiles = await archive(artifact);
          if (planFiles.size !== 1 || !planFiles.has("plan.json")) refuse();
          const plan = parseMatrixPlanV1(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(
                planFiles.get("plan.json"),
              ),
            ),
          );
          // Artifact contents only select relevant grants; native provenance below remains mandatory.
          if (!plan.cells.some((cell) => requested.has(cell.reservationId))) {
            continue;
          }
          const attempt = await json(
            `${API}/runs/${run.runId}/attempts/${run.runAttempt}`,
          );
          const repo = record(attempt.repository),
            headRepo = record(attempt.head_repository);
          if (
            attempt.id !== run.runId ||
            attempt.run_attempt !== run.runAttempt ||
            attempt.workflow_id !== HOSTED_SUPERVISOR_WORKFLOW_ID ||
            attempt.path !== HOSTED_SUPERVISOR_WORKFLOW_PATH ||
            attempt.event !== "workflow_dispatch" ||
            attempt.head_branch !==
              HOSTED_SUPERVISOR_REF.replace("refs/heads/", "") ||
            attempt.head_sha !== input.launcherSha ||
            repo.full_name !== REPOSITORY || headRepo.full_name !== REPOSITORY
          ) refuse();
          positive(repo.id);
          positive(headRepo.id);
          const artifactIdentity = (row: Json) => {
            const provenance = record(row.workflow_run);
            if (
              provenance.id !== run.runId ||
              provenance.repository_id !== repo.id ||
              provenance.head_repository_id !== headRepo.id ||
              provenance.head_branch !== attempt.head_branch ||
              provenance.head_sha !== input.launcherSha
            ) refuse();
          };
          artifactIdentity(artifact);
          const jobs = await pages(
            `/runs/${run.runId}/attempts/${run.runAttempt}/jobs`,
            "jobs",
          );
          const planners = jobs.filter((job) => job.name === "matrix_plan");
          if (planners.length !== 1 || planners[0].conclusion !== "success") {
            refuse();
          }
          const planner = await marker(
            planners[0],
            "Plan isolated issue matrix",
            "sentinel_matrix_plan",
            run,
          );
          const waveId = `${run.runId}:${run.runAttempt}:repair`;
          if (
            planner.waveId !== waveId ||
            !Number.isSafeInteger(planner.prepared) ||
            (planner.prepared as number) < 0 ||
            (planner.prepared as number) > 256
          ) refuse();
          for (
            const execution of saved.filter((value) =>
              value.runId === run.runId && value.runAttempt === run.runAttempt
            )
          ) {
            if (
              !sameRun(run, execution) || execution.id !== waveId ||
              execution.revision !== input.runtimeSha ||
              execution.generation !== planner.generation
            ) refuse();
          }
          const planDigest = sha(planner.planDigest);
          if (
            await matrixDigestV1(plan) !== planDigest ||
            plan.waveId !== waveId || !sameRun(run, plan.run) ||
            planner.prepared !== plan.cells.length
          ) refuse();
          const selected: MatrixCellPlanV1[] = [];
          const ids = new Set<string>();
          for (const cell of plan.cells) {
            if (
              ids.has(cell.cellId) ||
              cell.cellId !==
                await matrixCellIdV1(waveId, cell.taskId, cell.reservationId) ||
              cell.runtimeSha !== input.runtimeSha ||
              cell.generation !== planner.generation ||
              await matrixDigestV1(cell.request) !== cell.requestDigest ||
              cell.request.taskId !== cell.taskId ||
              !sameRepo(cell.request.repository, cell.repository) ||
              cell.request.base !== cell.expectedBase
            ) refuse();
            ids.add(cell.cellId);
            const request = requested.get(cell.reservationId);
            if (!request) continue;
            if (
              cell.taskId !== request.taskId ||
              !sameRepo(cell.repository, request.repository) ||
              cell.intentKey !== request.intentKey ||
              cell.expectedBase !== request.expectedBase ||
              seen.has(cell.reservationId)
            ) refuse();
            const task = snapshot.work.find((row) =>
              row.id === cell.taskId &&
              sameRepo(row.repository, cell.repository)
            )!;
            if (
              task.intent?.kind === "implementation" &&
              cell.request.checkoutBase !== undefined &&
              (task.source.kind !== "issue" ||
                cell.request.checkoutBase !== task.target.head ||
                task.target.pr === null ||
                (cell.request.reviewFindings?.length ?? 0) === 0 ||
                !snapshot.reviews.some((review) =>
                  sameRepo(review.repository, task.repository) &&
                  review.pullRequest.number === task.target.pr &&
                  review.pullRequest.head === cell.request.checkoutBase &&
                  review.outcome === "completed" &&
                  review.unresolvedSeverities.length > 0
                ))
            ) refuse();
            const reservation = snapshot.reservations.find((row) =>
              row.id === cell.reservationId
            )!;
            if (
              reservation.createdAt > plan.plannedAt ||
              plan.plannedAt > options.clock.now() + TOLERANCE
            ) refuse();
            seen.add(cell.reservationId);
            selected.push(cell);
          }
          if (selected.length === 0) continue;
          const bundlesDir = `${staging}/${run.runId}-${run.runAttempt}`;
          await Deno.mkdir(bundlesDir, { mode: 0o700 });
          const results = [], cellJobIds = [];
          for (const cell of selected) {
            const name =
              `sentinel-matrix-cell-${run.runId}-${run.runAttempt}-${cell.cellId}`;
            if (names.filter((value) => value === name).length > 1) refuse();
            const cellArtifact = artifacts.find((row) => row.name === name);
            if (!cellArtifact) continue; // Missing evidence never establishes non-submission.
            artifactIdentity(cellArtifact);
            const cellJobs = jobs.filter((job) =>
              job.name === `matrix_cell (${cell.cellId})`
            );
            if (cellJobs.length !== 1) refuse();
            const cellMarker = await marker(
              cellJobs[0],
              "Run isolated issue cell",
              "sentinel_matrix_cell",
              run,
            );
            if (
              cellMarker.cellId !== cell.cellId ||
              cellMarker.reservationId !== cell.reservationId ||
              cellMarker.generation !== cell.generation
            ) refuse();
            const files = await archive(cellArtifact);
            const raw = files.get("result.json");
            if (!raw) refuse();
            const result = parseMatrixCellResultV1(
              JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
            );
            if (
              await matrixDigestV1(result) !== sha(cellMarker.resultDigest) ||
              result.waveId !== waveId || result.cellId !== cell.cellId ||
              result.taskId !== cell.taskId ||
              !sameRepo(result.repository, cell.repository) ||
              !sameRun(run, result.run) ||
              result.runtimeSha !== cell.runtimeSha ||
              result.generation !== cell.generation ||
              result.reservationId !== cell.reservationId ||
              result.intentKey !== cell.intentKey ||
              result.requestDigest !== cell.requestDigest ||
              result.status !== cellMarker.status ||
              result.completedAt > options.clock.now() + TOLERANCE
            ) refuse();
            const task = snapshot.work.find((row) =>
              row.id === cell.taskId &&
              sameRepo(row.repository, cell.repository)
            )!;
            if (task.intent?.kind === "candidate_preservation") {
              const reservation = snapshot.reservations.find((row) =>
                row.id === cell.reservationId
              )!;
              const checkpoint = task.target.checkpoint;
              if (
                result.status !== "completed" ||
                result.receipt?.outcome !== "completed" ||
                result.bundle === null ||
                result.bundle.head !== task.target.head ||
                result.receipt.candidate?.head !== task.target.head ||
                result.bundle.checkpointSha !== (checkpoint?.sha ?? null) ||
                result.receipt.candidate?.checkpointSha !==
                  (checkpoint?.sha ?? null) ||
                (checkpoint !== null &&
                  checkpoint.branch !== candidateBranch(task.id)) ||
                task.intent.startedAt + TOLERANCE < result.completedAt ||
                reservation.settledAt === null ||
                reservation.settledAt + TOLERANCE < result.completedAt
              ) refuse();
            }
            if (result.bundle) {
              const bundle = files.get(`${cell.cellId}.bundle`);
              if (
                files.size !== 2 || !bundle ||
                result.bundle.file !== `${cell.cellId}.bundle` ||
                result.bundle.digest !== cellMarker.bundleDigest ||
                await bytesDigest(bundle) !== result.bundle.digest
              ) refuse();
              await Deno.writeFile(
                `${bundlesDir}/${result.bundle.file}`,
                bundle,
                { createNew: true, mode: 0o600 },
              );
            } else if (files.size !== 1 || cellMarker.bundleDigest !== null) {
              refuse();
            }
            results.push(result);
            cellJobIds.push(positive(cellJobs[0].id));
          }
          recovered.push({
            plan,
            planDigest,
            results,
            bundlesDir,
            provenance: {
              run,
              plannerJobId: positive(planners[0].id),
              cellJobIds,
            },
          });
        }
        staging = null;
        return recovered;
      } catch {
        controller.abort();
        if (staging) {
          await Deno.remove(staging, { recursive: true }).catch(() => {});
        }
        refuse();
      } finally {
        controller.abort();
        deadline.dispose();
      }
    },
  };
}
