/**
 * Bounded self-observation core: turn this repository's own failed Actions
 * jobs into deduplicated, sanitized defect reports that the normal repair
 * loop can then work as ordinary issues.
 *
 * The rules are deliberately narrow:
 *  - only allowlisted, small patterns are extracted from a bounded log read;
 *    raw log bodies are never copied anywhere;
 *  - summaries and marker identities contain only closed diagnostic facts,
 *    never arbitrary log detail, so one class stays stable across runs;
 *  - one report per signature, filed at most once, and never for a signature
 *    that already carries its marker in an open issue.
 */

/** Marker prefix; the full marker is `<!-- sentinel:self-observation:<key> -->`. */
export const SELF_DEFECT_MARKER_PREFIX = "sentinel:self-observation:";

/** Hard caps, so one pass can never flood the tracker. */
export const SELF_DEFECT_MAX_LOG_BYTES = 262_144;
export const SELF_DEFECT_MAX_RUNS_PER_PASS = 3;
export const SELF_DEFECT_MAX_ISSUES_PER_PASS = 2;
export const SELF_DEFECT_MIN_OCCURRENCES = 1;
export const SELF_DEFECT_WINDOW_MS = 6 * 60 * 60_000;

/** Workflows whose failures describe this deployment's own health. */
export const SELF_DEFECT_WORKFLOWS: readonly string[] = [
  "sentinel-ci",
  "sentinel-supervisor",
  "sentinel-repair",
];

export interface SelfFailureV1 {
  runId: number;
  workflow: string;
  job: string;
  /** Exact job conclusion observed; never synthesized. */
  conclusion: string;
  createdAt: string;
}

export interface SelfFailureSignatureV1 {
  /** Stable identity of the defect class, safe to embed in a marker. */
  key: string;
  /** One sanitized line describing the observed pattern. */
  summary: string;
}

export interface SelfObservationIssueV1 {
  key: string;
  title: string;
  body: string;
  occurrences: number;
  runIds: number[];
}

const SELF_DEFECT_JOBS = [
  "quality",
  "test-local",
  "test-shards",
  "maintenance",
  "prepare",
  "matrix_plan",
  "matrix_cell",
  "repair",
  "finalize",
  "bootstrap",
  "observe",
  "dispatch",
  "review",
  "validate",
  "verify-artifact",
] as const;

const SELF_DEFECT_TEST_SHARD_NAMES = [
  "test-shards (modules)",
  "test-shards (integration)",
  "test-shards (host-1)",
  "test-shards (host-2)",
  "test-shards (host-3)",
] as const;

function safeWorkflow(value: string): string {
  return SELF_DEFECT_WORKFLOWS.includes(value) ? value : "unknown-workflow";
}

function safeJob(value: string): string {
  if (SELF_DEFECT_JOBS.some((job) => job === value)) return value;
  // The Actions API appends a fixed matrix value to this logical job name.
  return SELF_DEFECT_TEST_SHARD_NAMES.some((job) => job === value)
    ? "test-shards"
    : "unknown-job";
}

function keyOf(
  kind: string,
  context: SelfFailureV1,
  detail = "observed",
): string {
  return `${safeWorkflow(context.workflow)}:${
    safeJob(context.job)
  }:${kind}:${detail}`;
}

/**
 * Extract at most ONE signature from one job log, most specific first. A log
 * that matches nothing still yields the job-level class unless the structured
 * job conclusion identifies cancellation, which is honest even without log
 * output from a cancelled job.
 */
export function extractSelfFailureSignature(
  logText: string,
  context: SelfFailureV1,
): SelfFailureSignatureV1 {
  const shutdown = logText.match(
    /The runner has received a shutdown signal[^\n]*/i,
  );
  if (shutdown !== null) {
    return {
      key: keyOf("runner-shutdown", context),
      summary: "the runner was shut down while the job was running",
    };
  }
  const typeError = logText.match(/(TS\d{4}) \[ERROR\]:/);
  if (typeError !== null) {
    return {
      key: keyOf("ts", context, typeError[1].toLowerCase()),
      summary: `type error: ${typeError[1]}`,
    };
  }
  const assertion = logText.match(/error: AssertionError: ([^\n]+)/);
  if (assertion !== null) {
    return {
      key: keyOf("assertion", context),
      summary: "a test assertion failed",
    };
  }
  const genericError = logText.match(/^error: ([^\n]+)$/m);
  if (genericError !== null) {
    return {
      key: keyOf("error", context),
      summary: "the job reported an error",
    };
  }
  const exit = logText.match(/Process completed with exit code (\d+)/);
  if (exit !== null) {
    const value = Number(exit[1]);
    const code = Number.isSafeInteger(value) && value <= 255
      ? String(value)
      : "unknown";
    return {
      key: keyOf("exit", context, code),
      summary: `the job exited with code ${code}`,
    };
  }
  const cancellation = context.conclusion === "cancelled" ||
    /The operation was cancel(?:l)?ed\b/i.test(logText);
  if (cancellation) {
    return {
      key: keyOf("cancelled", context),
      summary: "the job was cancelled before it completed",
    };
  }
  return {
    key: keyOf("job", context),
    summary: "the job failed with no allowlisted log pattern",
  };
}

/** The exact marker carried by a filed report; also the dedup identity. */
export function selfDefectMarker(key: string): string {
  return `<!-- ${SELF_DEFECT_MARKER_PREFIX}${key} -->`;
}

/**
 * Group repeated observations of the same defect class and plan ONE issue per
 * class that no open issue already marks. Ordering is deterministic: most
 * observed first, then the stable key.
 */
export function planSelfObservations(input: {
  failures: readonly (SelfFailureV1 & { signature: SelfFailureSignatureV1 })[];
  existingMarkers: readonly string[];
  maxIssues?: number;
}): SelfObservationIssueV1[] {
  const known = new Set(input.existingMarkers);
  const groups = new Map<string, typeof input.failures[number][]>();
  for (const failure of input.failures) {
    const bucket = groups.get(failure.signature.key);
    if (bucket === undefined) groups.set(failure.signature.key, [failure]);
    else bucket.push(failure);
  }
  const planned: SelfObservationIssueV1[] = [];
  const ordered = [...groups.entries()].sort((a, b) =>
    b[1].length - a[1].length || a[0].localeCompare(b[0])
  );
  for (const [key, observed] of ordered) {
    if (observed.length < SELF_DEFECT_MIN_OCCURRENCES) continue;
    if (known.has(selfDefectMarker(key))) continue;
    const first = observed[0]!;
    const runIds = [...new Set(observed.map((entry) => entry.runId))].filter(
      (id) => Number.isSafeInteger(id) && id > 0,
    ).sort(
      (a, b) => a - b,
    );
    const conclusion = [
        "success",
        "failure",
        "cancelled",
        "timed_out",
        "action_required",
        "neutral",
        "skipped",
        "stale",
        "startup_failure",
      ].includes(first.conclusion)
      ? first.conclusion
      : "unknown";
    const instant = Date.parse(first.createdAt);
    const createdAt = Number.isFinite(instant)
      ? new Date(instant).toISOString()
      : "unknown";
    const lines = [
      selfDefectMarker(key),
      "",
      `Sentinel observed its own repeated failure: ${first.signature.summary}.`,
      "",
      `- workflow: \`${safeWorkflow(first.workflow)}\``,
      `- job: \`${safeJob(first.job)}\``,
      `- conclusion: \`${conclusion}\``,
      `- occurrences in the observation window: ${observed.length}`,
      `- run ids: ${runIds.map((id) => `\`${id}\``).join(", ")}`,
      `- first observed: ${createdAt}`,
      "",
      "Filed automatically from sanitized summary fields only; raw job logs stay in Actions.",
      "Fix it through the normal repair loop; this issue is not a release or policy change.",
    ];
    planned.push({
      key,
      title: `Sentinel self-observation: ${first.signature.summary}`.slice(
        0,
        220,
      ),
      body: lines.join("\n"),
      occurrences: observed.length,
      runIds,
    });
    if (
      planned.length >= (input.maxIssues ?? SELF_DEFECT_MAX_ISSUES_PER_PASS)
    ) {
      break;
    }
  }
  return planned;
}
