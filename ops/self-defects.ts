/**
 * Bounded self-observation core: turn this repository's own failed Actions
 * jobs into deduplicated, sanitized defect reports that the normal repair
 * loop can then work as ordinary issues.
 *
 * The rules are deliberately narrow:
 *  - only allowlisted, small patterns are extracted from a bounded log read;
 *    raw log bodies are never copied anywhere;
 *  - every extracted signature is normalized (SHAs, numbers and paths are
 *    redacted and the text is capped) so the same defect maps to one stable
 *    identity across runs;
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

/**
 * Key-safe normalization: SHAs, numbers, paths, spaces and every other
 * character outside `[a-z0-9:._-]` collapse to `-`, so one defect class keeps
 * one stable identity and the resulting marker can never be truncated by the
 * `<`/`>` of a placeholder.
 */
function normalize(text: string): string {
  let value = text.toLowerCase();
  value = value.replace(/[0-9a-f]{40}/g, "sha");
  value = value.replace(/[0-9a-f]{12,39}/g, "sha");
  value = value.replace(/[0-9]+/g, "n");
  // Any path-like token collapses to one placeholder, so the same defect in a
  // different file still maps to one class.
  value = value.replace(/\S*\/\S*/g, "path");
  value = value.replace(/[^a-z0-9:._-]+/g, "-");
  value = value.replace(/-+/g, "-");
  value = value.replace(/^-+|-+$/g, "");
  return value.slice(0, 96).replace(/-+$/g, "");
}

function keyOf(kind: string, context: SelfFailureV1, detail: string): string {
  const basis = `${context.workflow}:${context.job}:${kind}:${
    normalize(detail)
  }`;
  return basis.slice(0, 160);
}

/**
 * Extract at most ONE signature from one job log, most specific first. A log
 * that matches nothing still yields the job-level class, which is honest: the
 * job failed and no allowlisted pattern explained it.
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
      key: keyOf("runner-shutdown", context, shutdown[0]),
      summary: "the runner was shut down while the job was running",
    };
  }
  const typeError = logText.match(/TS\d{4} \[ERROR\]: ([^\n]+)/);
  if (typeError !== null) {
    return {
      key: keyOf("ts", context, typeError[1]),
      summary: `type error: ${typeError[1].slice(0, 120)}`,
    };
  }
  const assertion = logText.match(/error: AssertionError: ([^\n]+)/);
  if (assertion !== null) {
    return {
      key: keyOf("assertion", context, assertion[1]),
      summary: `assertion: ${assertion[1].slice(0, 120)}`,
    };
  }
  const genericError = logText.match(/^error: ([^\n]+)$/m);
  if (genericError !== null) {
    return {
      key: keyOf("error", context, genericError[1]),
      summary: `error: ${genericError[1].slice(0, 120)}`,
    };
  }
  const exit = logText.match(/Process completed with exit code (\d+)/);
  if (exit !== null) {
    return {
      key: keyOf("exit", context, exit[1]),
      summary: `the job exited with code ${exit[1]}`,
    };
  }
  return {
    key: keyOf("job", context, "no allowlisted pattern"),
    summary: `the ${context.job} job failed with no allowlisted log pattern`,
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
    const runIds = [...new Set(observed.map((entry) => entry.runId))].sort(
      (a, b) => a - b,
    );
    const lines = [
      selfDefectMarker(key),
      "",
      `Sentinel observed its own repeated failure: ${first.signature.summary}.`,
      "",
      `- workflow: \`${first.workflow}\``,
      `- job: \`${first.job}\``,
      `- conclusion: \`${first.conclusion}\``,
      `- occurrences in the observation window: ${observed.length}`,
      `- run ids: ${runIds.map((id) => `\`${id}\``).join(", ")}`,
      `- first observed: ${first.createdAt}`,
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
