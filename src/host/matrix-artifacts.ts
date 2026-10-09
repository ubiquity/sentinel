/** Read-only authenticated Actions transport for exact admitted matrix waves. */
// NOTE: @zip.js/zip.js is imported dynamically inside the function that needs
// it (see below). A static import would force Deno to download the npm package
// at module load time, which hangs the bootstrap in environments where the
// npm registry is slow or blocked. The ZIP functionality is only needed when
// actually reading matrix artifacts, never at startup.
import { isAbsolute, resolve, sep } from "node:path";
import {
  HOSTED_ACTIONS_CLOCK_TOLERANCE_MS as TOLERANCE,
  HOSTED_RUNTIME_ID,
  HOSTED_SUPERVISOR_REF,
  HOSTED_SUPERVISOR_REPOSITORY as REPOSITORY,
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
  type HostedExecutionIntentV1,
  type HostedRunProofV1,
  parseHostedRunProofV1,
} from "../contracts/hosted-supervisor.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import { isGitSha } from "../contracts/brands.ts";
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
import {
  type MatrixArtifactRequestV1,
  type MatrixArtifactTransportV1,
  type MatrixAuthenticatedWaveV1,
  MatrixMissingCellArtifactError,
  type MatrixRejectedCellEvidenceV1,
  type MatrixRejectedWaveV1,
} from "./matrix-artifact-port.ts";
import {
  HISTORICAL_MATRIX_QUARANTINE,
  MATRIX_ARTIFACT_RECOVERY_MAX_MS,
  MatrixHistoricalRuntimeMismatch,
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
const NATIVE_STACK_GETTER = Object.getOwnPropertyDescriptor(
  new Error(),
  "stack",
)?.get;
const ERROR_PROTOTYPES = new Set([
  Error.prototype,
  EvalError.prototype,
  RangeError.prototype,
  ReferenceError.prototype,
  SyntaxError.prototype,
  TypeError.prototype,
  URIError.prototype,
  AggregateError.prototype,
  Object.prototype,
]);
function refusalFrames(error: unknown): { line: number; column: number }[] {
  let stack: unknown;
  try {
    const descriptor = error !== null &&
        (typeof error === "object" || typeof error === "function")
      ? Object.getOwnPropertyDescriptor(error, "stack")
      : undefined;
    if (descriptor && "value" in descriptor) {
      stack = descriptor.value;
    } else if (NATIVE_STACK_GETTER && descriptor?.get === NATIVE_STACK_GETTER) {
      for (const object of [Error, Function.prototype, Object.prototype]) {
        const hook = Object.getOwnPropertyDescriptor(
          object,
          "prepareStackTrace",
        );
        if (hook && (!("value" in hook) || hook.value !== undefined)) return [];
      }
      let object = error;
      for (let depth = 0; object !== null; depth++) {
        if (
          depth > 3 ||
          (object !== error && !ERROR_PROTOTYPES.has(object as object))
        ) return [];
        for (const key of ["name", "message"]) {
          const value = Object.getOwnPropertyDescriptor(object, key);
          if (
            value &&
            (!("value" in value) ||
              (typeof value.value !== "string" && value.value !== undefined))
          ) return [];
        }
        object = Object.getPrototypeOf(object);
      }
      stack = NATIVE_STACK_GETTER.call(error);
    }
  } catch {
    return [];
  }
  const frames: { line: number; column: number }[] = [];
  if (typeof stack !== "string") return frames;
  const pattern =
    /^[ \t]+at[ \t]+(?:[^\r\n]*[ \t]+\()?file:\/\/\/[^\r\n]*\/matrix-artifacts\.ts:([1-9][0-9]{0,5}):([1-9][0-9]{0,5})\)?[ \t]*$/gm;
  for (const frame of stack.slice(0, 8192).matchAll(pattern)) {
    frames.push({ line: Number(frame[1]), column: Number(frame[2]) });
    if (frames.length === 3) break;
  }
  return frames;
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
  let repositoryId: number | null = null;
  type RecoveryInput = Parameters<MatrixArtifactTransportV1["recover"]>[0] & {
    rejectionProof?: HostedRunProofV1;
    completedExecution?: HostedExecutionIntentV1;
    /**
     * Explicit authenticated not-started revalidation, forwarded verbatim from
     * the trusted caller. Absent or false keeps every already-quarantined
     * record closed exactly as in the original rejection pass.
     */
    revalidateNotStarted?: boolean;
  };
  const recovery = {
    async run(input: RecoveryInput): Promise<{
      recovered: MatrixAuthenticatedWaveV1[];
      rejected: MatrixRejectedWaveV1[];
      completed?: boolean;
    }> {
      if (
        input.requests.length === 0 && !input.rejectionProof &&
        !input.completedExecution
      ) {
        return { recovered: [], rejected: [] };
      }
      if (
        input.deadline !== undefined && !Number.isSafeInteger(input.deadline)
      ) refuse();
      const startedAt = options.clock.now();
      const until = Math.min(
        startedAt + MATRIX_ARTIFACT_RECOVERY_MAX_MS,
        input.deadline ?? Number.POSITIVE_INFINITY,
      );
      if (until <= startedAt) return { recovered: [], rejected: [] };
      const deadline = createDeadline(until - startedAt);
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
        const completionCustody = input.completedExecution
          ? canonicalStringify({
            head: release.value.head,
            runtime: release.value.snapshot.hostedRuntimes.find((row) =>
              row.id === HOSTED_RUNTIME_ID
            ),
          })
          : null;
        if (input.completedExecution) {
          const runtime = release.value.snapshot.hostedRuntimes.find((row) =>
            row.id === HOSTED_RUNTIME_ID
          );
          const current = runtime?.execution ??
            runtime?.lastExecutionProof?.execution;
          if (
            !current ||
            canonicalStringify(current) !==
              canonicalStringify(input.completedExecution) ||
            (!runtime?.execution &&
              !["bootstrap", "prior", "candidate", "rollback"].includes(
                current.purpose,
              ) &&
              (runtime?.activeRevision !== current.revision ||
                runtime.generation !== current.generation))
          ) refuse();
        }
        if (input.rejectionProof) {
          const proof = parseHostedRunProofV1(input.rejectionProof);
          const runtime = release.value.snapshot.hostedRuntimes.find((row) =>
            row.id === HOSTED_RUNTIME_ID
          );
          const active = runtime?.execution &&
            canonicalStringify(runtime.execution) ===
              canonicalStringify(proof.execution);
          const savedExecution = active
            ? runtime?.execution
            : runtime?.lastExecutionProof?.execution;
          if (
            !savedExecution || proof.execution.purpose !== "ordinary" ||
            canonicalStringify(savedExecution) !==
              canonicalStringify(proof.execution) ||
            (!active &&
              (runtime?.lastExecutionProof?.outcome === "not_started" ||
                !runtime?.lastExecutionProof ||
                canonicalStringify({
                    ...runtime.lastExecutionProof,
                    observedAt: proof.observedAt,
                  }) !== canonicalStringify(proof)))
          ) refuse();
          input = {
            ...input,
            requests: snapshot.work.flatMap((task) => {
              const intent = task.intent;
              // The exact original quarantine class is re-examined ONLY when the
              // trusted caller explicitly enabled authenticated not-started
              // revalidation; the default rejection pass leaves every
              // already-quarantined record closed exactly as before.
              const recoverable = task.nextStep === "work" ||
                (input.revalidateNotStarted === true &&
                  task.nextStep === "blocked" &&
                  task.blocker?.kind === "other" &&
                  task.blocker.message === HISTORICAL_MATRIX_QUARANTINE);
              if (
                !recoverable || intent?.kind !== "implementation" ||
                task.target.candidateState !== undefined
              ) return [];
              if (intent.requestId === null) refuse();
              return [{
                taskId: task.id,
                repository: task.repository,
                reservationId: intent.requestId,
                intentKey: intent.key,
                expectedBase: task.target.base,
                attempt: task.counters.attempts,
              }];
            }),
          };
        }
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
          // The exact original quarantine class is bound only under explicit
          // authenticated not-started revalidation; every other blocked class
          // refuses here exactly as before.
          const recoverable = task.nextStep === "work" ||
            (input.revalidateNotStarted === true &&
              task.nextStep === "blocked" &&
              task.blocker?.kind === "other" &&
              task.blocker.message === HISTORICAL_MATRIX_QUARANTINE);
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
            !recoverable ||
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
          const remaining = until - options.clock.now();
          if (remaining <= 0 || deadline.fired()) refuse();
          const response = await deadline.race(
            options.http({
              method: "GET",
              url: path,
              deadlineMs: remaining,
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
            const nextLinks = [
              ...(link?.matchAll(/<([^>]+)>;\s*rel="next"/g) ?? []),
            ];
            if (nextLinks.length > 1) refuse();
            const next = nextLinks[0];
            if (
              next && next[1] !== `${API}${path}?per_page=100&page=${page + 1}`
            ) {
              if (!next[1].startsWith("https://api.github.com/repositories/")) {
                refuse();
              }
              if (repositoryId === null) {
                const repository = await json(
                  `https://api.github.com/repos/${REPOSITORY}`,
                );
                if (repository.full_name !== REPOSITORY) refuse();
                repositoryId = positive(repository.id);
              }
              if (
                next[1] !==
                  `https://api.github.com/repositories/${repositoryId}/actions${path}?per_page=100&page=${
                    page + 1
                  }`
              ) {
                refuse();
              }
            }
            if (!next && items.length === total) {
              const ids = items.map((row) => positive(row.id));
              if (new Set(ids).size !== ids.length) refuse();
              return items;
            }
            if (!next || body[key].length === 0) refuse();
          }
          refuse();
        };
        if (input.completedExecution) {
          const execution = input.completedExecution;
          const attempt = await json(
            `${API}/runs/${execution.runId}/attempts/${execution.runAttempt}`,
          );
          const repo = record(attempt.repository),
            headRepo = record(attempt.head_repository);
          if (
            attempt.id !== execution.runId ||
            attempt.run_attempt !== execution.runAttempt ||
            attempt.workflow_id !== HOSTED_SUPERVISOR_WORKFLOW_ID ||
            attempt.path !== HOSTED_SUPERVISOR_WORKFLOW_PATH ||
            attempt.event !== "workflow_dispatch" ||
            attempt.head_branch !==
              HOSTED_SUPERVISOR_REF.replace("refs/heads/", "") ||
            attempt.head_sha !== execution.launcherSha ||
            repo.full_name !== REPOSITORY ||
            headRepo.full_name !== REPOSITORY || attempt.status !== "completed"
          ) refuse();
          positive(repo.id);
          positive(headRepo.id);
          const start = instant(attempt.run_started_at);
          const end = instant(attempt.updated_at);
          if (
            end < start ||
            end < execution.createdAt ||
            end > options.clock.now() + TOLERANCE
          ) refuse();
          const jobs = await pages(
            `/runs/${execution.runId}/attempts/${execution.runAttempt}/jobs`,
            "jobs",
          );
          for (const job of jobs) {
            if (
              job.run_id !== execution.runId ||
              job.run_attempt !== execution.runAttempt ||
              job.head_sha !== execution.launcherSha ||
              job.status !== "completed" ||
              typeof job.conclusion !== "string" || job.conclusion.length === 0
            ) refuse();
            const finished = instant(job.completed_at);
            const started = job.started_at === null
              ? null
              : instant(job.started_at);
            // Skipped GitHub placeholders without runners have metadata times,
            // rather than an execution interval; both must remain in the attempt.
            const skippedWithoutRunner = job.conclusion === "skipped" &&
              job.runner_id === null && job.runner_name === null;
            if (
              finished > end + TOLERANCE ||
              finished > options.clock.now() + TOLERANCE ||
              (skippedWithoutRunner
                ? started === null || started < start || started > end ||
                  finished < start || finished > end
                : started !== null && finished < started)
            ) refuse();
          }
          const fresh = await options.state.readRelease();
          if (
            !fresh.ok || fresh.value.status !== "found" ||
            canonicalStringify({
                head: fresh.value.head,
                runtime: fresh.value.snapshot.hostedRuntimes.find((row) =>
                  row.id === HOSTED_RUNTIME_ID
                ),
              }) !== completionCustody
          ) refuse();
          return { recovered: [], rejected: [], completed: true };
        }
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
          // NOTE: the npm specifier MUST stay non-literal. Deno prefetches
          // every statically-discoverable import at startup (including
          // literal dynamic imports), so a literal specifier here
          // re-introduces the bootstrap npm fetch hang. The computed string
          // keeps zip.js truly lazy: it loads only when an artifact zip is
          // actually read.
          const zipSpec = ["npm:@zip.js/zip.js", "2.8.34"].join("@");
          const { Uint8ArrayReader, ZipReader } = await import(zipSpec);
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
          expectedRuntime: string | null = input.runtimeSha,
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
              !isGitSha(value.runtimeSha) ||
              (expectedRuntime !== null && value.runtimeSha !== expectedRuntime)
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
        if (input.rejectionProof && requested.size > 0 && plans.length !== 1) {
          refuse();
        }
        staging = await Deno.makeTempDir({
          dir: realRoot,
          prefix: "authenticated-wave-",
        });
        const recovered: MatrixAuthenticatedWaveV1[] = [];
        const rejected: MatrixRejectedWaveV1[] = [];
        const seen = new Set<string>();
        for (const artifact of plans) {
          const [, runId, runAttempt] = (artifact.name as string).match(
            /^sentinel-matrix-plan-(\d+)-(\d+)$/,
          )!;
          const runIdentity = {
            runId: positive(Number(runId)),
            runAttempt: positive(Number(runAttempt)),
          };
          if (
            input.currentRun &&
            !sameRun(input.currentRun, {
              ...runIdentity,
              launcherSha: input.launcherSha,
            })
          ) continue;
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
          if (
            !input.rejectionProof &&
            input.currentRun === undefined &&
            !plan.cells.some((cell) => requested.has(cell.reservationId))
          ) {
            continue;
          }
          const attempt = await json(
            `${API}/runs/${runIdentity.runId}/attempts/${runIdentity.runAttempt}`,
          );
          const repo = record(attempt.repository),
            headRepo = record(attempt.head_repository);
          // A historical selected run binds to its OWN authenticated native
          // attempt head, never to the current caller's launcher and never to
          // a plan-supplied SHA. Only the exact current run stays pinned to the
          // trusted caller launcher.
          const nativeLauncher = attempt.head_sha;
          if (!isGitSha(nativeLauncher)) refuse();
          const run = {
            ...runIdentity,
            launcherSha: input.currentRun === undefined
              ? nativeLauncher
              : input.launcherSha,
          };
          if (
            attempt.id !== run.runId ||
            attempt.run_attempt !== run.runAttempt ||
            attempt.workflow_id !== HOSTED_SUPERVISOR_WORKFLOW_ID ||
            attempt.path !== HOSTED_SUPERVISOR_WORKFLOW_PATH ||
            attempt.event !== "workflow_dispatch" ||
            attempt.head_branch !==
              HOSTED_SUPERVISOR_REF.replace("refs/heads/", "") ||
            attempt.head_sha !== run.launcherSha ||
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
              provenance.head_sha !== run.launcherSha
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
          // Only the aggregate's separate trusted consumer identity can enable
          // rejection-only historical inspection. Current-run discovery and
          // every other caller retain their strict runtime match.
          const historical = input.currentRun === undefined &&
            input.consumerRun !== undefined &&
            (run.runId !== input.consumerRun.runId ||
              run.runAttempt !== input.consumerRun.runAttempt);
          const planner = await marker(
            planners[0],
            "Plan isolated issue matrix",
            "sentinel_matrix_plan",
            run,
            historical ? null : input.runtimeSha,
          );
          const waveRuntime = planner.runtimeSha as typeof input.runtimeSha;
          const runtimeMismatch = waveRuntime !== input.runtimeSha;
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
              execution.revision !== waveRuntime ||
              execution.generation !== planner.generation
            ) refuse();
          }
          const planDigest = sha(planner.planDigest);
          if (
            await matrixDigestV1(plan) !== planDigest ||
            plan.waveId !== waveId || !sameRun(run, plan.run) ||
            planner.prepared !== plan.cells.length
          ) refuse();
          if (
            input.rejectionProof &&
            (plan.plannedAt < input.rejectionProof.execution.createdAt ||
              plan.plannedAt > options.clock.now() + TOLERANCE)
          ) refuse();
          const selected: MatrixCellPlanV1[] = [];
          const affected: MatrixRejectedWaveV1["affected"][number][] = [];
          let malformed = false;
          const ids = new Set<string>();
          for (const cell of plan.cells) {
            if (
              ids.has(cell.cellId) ||
              cell.cellId !==
                await matrixCellIdV1(waveId, cell.taskId, cell.reservationId) ||
              cell.runtimeSha !== waveRuntime ||
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
            if (plan.plannedAt > options.clock.now() + TOLERANCE) refuse();
            if (reservation.createdAt > plan.plannedAt) {
              if (!input.rejectionProof) refuse();
              malformed = true;
            }
            if (input.rejectionProof) {
              if (
                task.intent?.kind !== "implementation" ||
                task.target.candidateState !== undefined ||
                (task.target.head !== null &&
                  task.target.head !== task.target.base) ||
                task.source.kind !== "issue" ||
                cell.request.issue?.number !== task.related.issueNumber ||
                canonicalStringify(cell.request.evidence) !==
                  canonicalStringify(task.evidence) ||
                (reservation.outcome !== "reserved" &&
                  reservation.outcome !== "ambiguous") ||
                plan.plannedAt < input.rejectionProof.execution.createdAt ||
                reservation.createdAt <
                  input.rejectionProof.execution.createdAt ||
                task.intent.startedAt < reservation.createdAt ||
                task.intent.startedAt > options.clock.now() + TOLERANCE ||
                reservation.createdAt > options.clock.now() + TOLERANCE
              ) refuse();
              affected.push({
                request: cell.request,
                requestDigest: cell.requestDigest,
                work: task,
                workDigest: await matrixDigestV1(task),
                reservation,
                reservationDigest: await matrixDigestV1(reservation),
              });
            }
            seen.add(cell.reservationId);
            selected.push(cell);
          }
          if (input.rejectionProof && !malformed) {
            // A non-malformed plan carries no reservation-after-manifest
            // claim: no reservation postdates the plan manifest. The
            // historical rejection skips it here, before downloading any
            // cell evidence — verifying cell results first would refuse on
            // legitimately executed cells (a healthy prior run whose records
            // remain in work for retry), deadlocking every later
            // maintenance on a plan the rejection skips anyway. No claim is
            // made, no record is touched.
            continue;
          }
          if (
            selected.length === 0 &&
            (input.rejectionProof || input.currentRun === undefined)
          ) continue;
          const bundlesDir = `${staging}/${run.runId}-${run.runAttempt}`;
          await Deno.mkdir(bundlesDir, { mode: 0o700 });
          const results = [], cellJobIds = [];
          let missingArtifacts = 0;
          const evidence: MatrixRejectedCellEvidenceV1[] = [];
          for (const cell of selected) {
            const name =
              `sentinel-matrix-cell-${run.runId}-${run.runAttempt}-${cell.cellId}`;
            if (names.filter((value) => value === name).length > 1) refuse();
            const cellArtifact = artifacts.find((row) => row.name === name);
            if (!cellArtifact) {
              if (input.rejectionProof) {
                // Trusted historical rejection: a missing cell artifact is its
                // own explicit uncertainty disposition. The trusted consumer
                // quarantines this exact record with a truthful reason instead
                // of re-selecting an endlessly unprovable historical wave.
                const captured = affected.find((row) =>
                  row.reservation.id === cell.reservationId
                );
                const started = Date.parse(String(planners[0].started_at));
                const completed = Date.parse(String(planners[0].completed_at));
                if (
                  !captured || typeof planners[0].started_at !== "string" ||
                  typeof planners[0].completed_at !== "string" ||
                  !Number.isSafeInteger(started) ||
                  !Number.isSafeInteger(completed) || completed < started
                ) refuse();
                throw new MatrixMissingCellArtifactError(
                  input.rejectionProof,
                  captured,
                );
              }
              // Missing evidence never establishes non-submission, and a wave
              // that cannot be fully authenticated cannot isolate its
              // records: the unprovable cells stay charged and untouched
              // instead of deadlocking the supervisor on a permanently
              // missing artifact (never uploaded, expired or otherwise
              // lost). Only cells with complete authenticated evidence enter
              // the historical mismatch isolation below. Remove any
              // prematurely added affected entry so the unprovable record is
              // left untouched.
              missingArtifacts += 1;
              const affectedIndex = affected.findIndex(
                (entry) => entry.reservation.id === cell.reservationId,
              );
              if (affectedIndex >= 0) affected.splice(affectedIndex, 1);
              continue;
            }
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
              waveRuntime,
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
            if (
              input.rejectionProof && (result.status !== "not_started" ||
                result.receipt !== null || result.bundle !== null)
            ) refuse();
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
            evidence.push({
              cellId: cell.cellId,
              taskId: cell.taskId,
              reservationId: cell.reservationId,
              status: result.status,
              receiptNull: result.receipt === null,
              bundleNull: result.bundle === null,
              completedAt: result.completedAt,
              resultDigest: sha(cellMarker.resultDigest),
            });
          }
          if (input.rejectionProof) {
            if (!malformed) continue;
            // The authenticated planner job interval is the only admission
            // window a legacy manifest rejection may use; a missing or
            // non-causal interval fails closed instead of inventing authority.
            const plannerStartedAt = planners[0].started_at;
            const plannerCompletedAt = planners[0].completed_at;
            const startedMs = typeof plannerStartedAt === "string"
              ? Date.parse(plannerStartedAt)
              : Number.NaN;
            const completedMs = typeof plannerCompletedAt === "string"
              ? Date.parse(plannerCompletedAt)
              : Number.NaN;
            if (
              typeof plannerStartedAt !== "string" ||
              typeof plannerCompletedAt !== "string" ||
              !Number.isSafeInteger(startedMs) ||
              !Number.isSafeInteger(completedMs) || completedMs < startedMs
            ) refuse();
            rejected.push({
              reason: "reservation_after_manifest",
              proof: input.rejectionProof,
              planDigest,
              plannerJobId: positive(planners[0].id),
              plannerStartedAt,
              plannerCompletedAt,
              affected,
              cells: evidence,
            });
            continue;
          }
          if (runtimeMismatch) {
            if (
              !historical || !input.consumerRun ||
              evidence.length + missingArtifacts !== selected.length
            ) refuse();
            // A partially authenticated wave isolates exactly the cells with
            // complete evidence; unprovable cells were left charged above and
            // are never claimed.
            if (evidence.length === 0) continue;
            throw new MatrixHistoricalRuntimeMismatch({
              consumerRun: input.consumerRun,
              expectedRuntimeSha: input.runtimeSha,
              run,
              runtimeSha: waveRuntime,
              generation: positive(planner.generation),
              repairHead: repair.value.head,
              planDigest,
              planArtifactId: positive(artifact.id),
              planArchiveDigest: String(artifact.digest),
              plannerJobId: positive(planners[0].id),
              affected: evidence.map((cell) => ({
                work: snapshot.work.find((row) =>
                  row.id === cell.taskId &&
                  row.intent?.requestId === cell.reservationId
                )!,
                reservation: snapshot.reservations.find((row) =>
                  row.id === cell.reservationId
                )!,
                cell,
              })),
            });
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
        if (input.rejectionProof && staging) {
          await Deno.remove(staging, { recursive: true });
        }
        staging = null;
        return { recovered, rejected };
      } catch (error) {
        controller.abort();
        if (staging) {
          await Deno.remove(staging, { recursive: true }).catch(() => {});
        }
        if (error instanceof MatrixHistoricalRuntimeMismatch) throw error;
        try {
          console.error(JSON.stringify({
            kind: "sentinel_matrix_artifact_error",
            frames: refusalFrames(error),
          }));
        } catch {
          refuse();
        }
        if (error instanceof MatrixMissingCellArtifactError) throw error;
        refuse();
      } finally {
        controller.abort();
        deadline.dispose();
      }
    },
  };
  return {
    async confirmCompletedExecution(execution) {
      return (await recovery.run({
        requests: [],
        runtimeSha: execution.revision,
        launcherSha: execution.launcherSha,
        completedExecution: execution,
      })).completed === true;
    },
    async recover(input) {
      return (await recovery.run(input)).recovered;
    },
    async rejectHistorical({ proof, revalidateNotStarted, deadline }) {
      return (await recovery.run({
        requests: [],
        runtimeSha: proof.execution.revision,
        launcherSha: proof.execution.launcherSha,
        currentRun: {
          runId: proof.execution.runId,
          runAttempt: proof.execution.runAttempt,
          launcherSha: proof.execution.launcherSha,
        },
        rejectionProof: proof,
        revalidateNotStarted: revalidateNotStarted === true,
        ...(deadline === undefined ? {} : { deadline }),
      })).rejected;
    },
  };
}
