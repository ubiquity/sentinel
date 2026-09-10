// Pure strict codec suite: structured review result and review journal
// render/parse. No network, no models, no git — every case is a value or a
// rendered body exercised through the exported parsers.
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { RecordParseError, tryParse } from "../../src/contracts/validation.ts";
import {
  findingMessage,
  isJournalBoundExceeded,
  MAX_FINDING_MESSAGE,
  MAX_FINDINGS,
  MAX_JOURNAL_BYTES,
  parseReviewJournalBody,
  parseReviewJournalMetadata,
  parseReviewResultJson,
  parseReviewResultV1,
  renderReviewJournalBody,
  reviewResultDigest,
} from "../../src/github/review-journal.ts";
import type {
  ReviewFindingV1,
  ReviewJournalIntentV1,
  ReviewJournalReadyV1,
  ReviewJournalRunningV1,
  ReviewJournalV1,
  ReviewResultV1,
} from "../../src/github/review-journal.ts";

const SHA_A = "aafb7ee0598699bb7fb8a72ea133693ed64462da";
const SHA_B = "6dc35d06e757107b91eb58232bd15e5f671d79b4";
const T0 = 1786000000000;

const BASELINE = {
  version: "v1",
  repository: { owner: "ubiquity", name: "sentinel" },
  prNumber: 7,
  expectedHead: SHA_A,
  expectedBase: SHA_B,
  operationKey: "review:work-1",
  publisher: "sentinel[bot]",
  requestId: "req-1",
  requestedAt: T0,
} as const;

function intentJournal(
  overrides: Record<string, unknown> = {},
): ReviewJournalIntentV1 {
  return {
    ...BASELINE,
    phase: "intent",
    ...overrides,
  } as ReviewJournalIntentV1;
}

function runningJournal(
  overrides: Record<string, unknown> = {},
): ReviewJournalRunningV1 {
  return {
    ...BASELINE,
    phase: "running",
    reviewId: 100,
    execution: runningExecution(),
    ...overrides,
  } as ReviewJournalRunningV1;
}

function runningExecution(overrides: Record<string, unknown> = {}) {
  return {
    ownerRunId: "run-1",
    invocationId: "inv-1",
    threadId: "thread-1",
    submittedProvider: "codex-provider",
    model: "gpt-5.6-luna",
    reasoning: "max",
    startMayOccur: true,
    ...overrides,
  };
}

function readyExecution(overrides: Record<string, unknown> = {}) {
  return {
    ...runningExecution(),
    turnId: "turn-1",
    resultId: "result-9",
    actual: {
      evidenceKind: "request-runtime",
      provider: "codex-provider",
      threadId: "thread-1",
      turnId: "turn-1",
      terminalOrigin: "runtime",
      observedTerminalStatus: "completed",
      observedModel: "gpt-5.6-luna",
      observedReasoning: "max",
      durationMs: 4200,
      outputChars: 512,
    },
    ...overrides,
  };
}

async function readyJournal(
  result: ReviewResultV1,
  overrides: Record<string, unknown> = {},
): Promise<ReviewJournalReadyV1> {
  return {
    ...BASELINE,
    phase: "ready",
    reviewId: 100,
    completedAt: T0 + 60_000,
    result,
    resultDigest: await reviewResultDigest(result),
    execution: readyExecution(),
    ...overrides,
  } as ReviewJournalReadyV1;
}

function cleanResult(): ReviewResultV1 {
  return { verdict: "clean", summary: "no issues found", findings: [] };
}

function finding(overrides: Record<string, unknown> = {}): ReviewFindingV1 {
  return {
    priority: 1,
    title: "error handling is broken",
    body: "the error path swallows the failure\n\nand returns success",
    path: "src/github/client.ts",
    lineStart: 10,
    lineEnd: 24,
    ...overrides,
  } as ReviewFindingV1;
}

function findingsResult(): ReviewResultV1 {
  return {
    verdict: "findings",
    summary: "two findings reported",
    findings: [
      finding(),
      finding({
        priority: 3,
        title: "style nit",
        body: "",
        path: "tests/readme_test.ts",
        lineStart: 1,
        lineEnd: 1,
      }),
    ],
  };
}

function unavailableResult(): ReviewResultV1 {
  return {
    verdict: "unavailable",
    summary: "completion could not be verified",
    findings: [],
  };
}

function asReady(journal: ReviewJournalV1): ReviewJournalReadyV1 {
  if (journal.phase !== "ready") assert.fail("expected a ready journal");
  return journal;
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(encoded: string): string {
  return new TextDecoder().decode(
    Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)),
  );
}

function bodyFromMetadataText(metadataText: string, human = "x"): string {
  return `<!--sentinel-review-journal-v1\n${
    toBase64(metadataText)
  }\n-->\n\n${human}`;
}

/** Splice a transformed metadata JSON text back into a rendered body. */
function replaceMetadataText(
  body: string,
  mutate: (text: string) => string,
): string {
  const marker = "<!--sentinel-review-journal-v1\n";
  const rest = body.slice(marker.length);
  const end = rest.indexOf("\n-->");
  const encoded = rest.slice(0, end);
  return body.replace(encoded, toBase64(mutate(fromBase64(encoded))));
}

function metadataTextOf(body: string): string {
  const marker = "<!--sentinel-review-journal-v1\n";
  assert.ok(body.startsWith(marker), "body starts with the metadata marker");
  const rest = body.slice(marker.length);
  const end = rest.indexOf("\n-->");
  assert.ok(end !== -1, "body contains the metadata terminator");
  return fromBase64(rest.slice(0, end));
}

// ---------------------------------------------------------------------------
// Structured result: positive cases
// ---------------------------------------------------------------------------

Deno.test("strict result: clean, findings and unavailable roundtrip through the journal", async () => {
  for (const result of [cleanResult(), findingsResult(), unavailableResult()]) {
    const journal = await readyJournal(result);
    const body = renderReviewJournalBody(journal);
    const parsed = asReady(await parseReviewJournalBody(body));
    assert.equal(canonicalStringify(parsed), canonicalStringify(journal));
    assert.equal(parsed.result.summary, result.summary);
    assert.equal(parsed.result.verdict, result.verdict);
  }
});

Deno.test("strict result: full multiline finding body is preserved exactly", async () => {
  const multilineBody =
    "first line\nsecond line\n\n\n\ttab-indented\nends with <tag> & ampersand → unicode ☕\n---\ntrailing";
  const result: ReviewResultV1 = {
    verdict: "findings",
    summary: "multiline finding",
    findings: [
      finding({ priority: 0, body: multilineBody, path: "src/dir-1/deep.ts" }),
    ],
  };
  const journal = await readyJournal(result);
  const body = renderReviewJournalBody(journal);
  const parsed = asReady(await parseReviewJournalBody(body));
  assert.equal(parsed.result.findings[0].body, multilineBody);
  assert.equal(parsed.result.findings[0].title, finding().title);
  assert.equal(parsed.result.findings[0].path, "src/dir-1/deep.ts");
  assert.equal(parsed.result.findings[0].lineStart, 10);
  assert.equal(parsed.result.findings[0].lineEnd, 24);
  assert.ok(
    findingMessage(parsed.result.findings[0]).length <= MAX_FINDING_MESSAGE,
  );
});

Deno.test("strict result: unavailable shape allows an empty finding list only", async () => {
  // With real execution evidence preserved (a failed terminal is real evidence).
  const withFailure = await readyJournal(unavailableResult(), {
    execution: readyExecution({
      actual: {
        ...readyExecution().actual,
        terminalOrigin: "runtime",
        observedTerminalStatus: "failed",
      },
    }),
  });
  const parsed = asReady(
    await parseReviewJournalBody(renderReviewJournalBody(withFailure)),
  );
  assert.equal(parsed.result.verdict, "unavailable");
  assert.equal(parsed.execution?.actual.observedTerminalStatus, "failed");
  // Without any runtime completion evidence (no runtime is invented).
  const withoutExecution = await readyJournal(unavailableResult(), {
    execution: null,
  });
  const parsed2 = asReady(
    await parseReviewJournalBody(renderReviewJournalBody(withoutExecution)),
  );
  assert.equal(parsed2.execution, null);
});

Deno.test("strict result: intent and running journal phases roundtrip", async () => {
  const intent = intentJournal();
  const parsedIntent = await parseReviewJournalBody(
    renderReviewJournalBody(intent),
  );
  assert.equal(canonicalStringify(parsedIntent), canonicalStringify(intent));

  const running = runningJournal();
  const parsedRunning = await parseReviewJournalBody(
    renderReviewJournalBody(running),
  );
  assert.equal(canonicalStringify(parsedRunning), canonicalStringify(running));
  if (parsedRunning.phase !== "running") {
    assert.fail("expected a running journal");
  }
  assert.equal(parsedRunning.execution.startMayOccur, true);
  assert.equal("turnId" in parsedRunning.execution, false);

  // Metadata-only parse agrees for every phase.
  const ready = await readyJournal(cleanResult());
  const metadataOnly = parseReviewJournalMetadata(
    metadataTextOf(renderReviewJournalBody(ready)),
  );
  assert.equal(canonicalStringify(metadataOnly), canonicalStringify(ready));
});

// ---------------------------------------------------------------------------
// Structured result: negative cases
// ---------------------------------------------------------------------------

Deno.test("strict result: contradictory verdict shapes are rejected", () => {
  assert.throws(() =>
    parseReviewResultV1({
      verdict: "clean",
      summary: "s",
      findings: [finding()],
    })
  );
  assert.throws(() =>
    parseReviewResultV1({
      verdict: "findings",
      summary: "s",
      findings: [],
    })
  );
  assert.throws(() =>
    parseReviewResultV1({
      verdict: "unavailable",
      summary: "s",
      findings: [finding()],
    })
  );
  assert.throws(() =>
    parseReviewResultV1({
      verdict: "unavailable",
      summary: "s",
      findings: [],
      extra: true,
    })
  );
  assert.throws(() =>
    parseReviewResultV1({
      verdict: "clean",
      summary: "s",
      findings: [{ ...finding(), extra: 1 }],
    })
  );
  assert.throws(() =>
    parseReviewResultJson('```json\n{"verdict":"clean"}\n```')
  );
  assert.throws(() =>
    parseReviewResultJson('{"verdict":"clean"} trailing prose')
  );
  assert.throws(() => parseReviewResultJson('{"verdict":"clean"'));
  assert.throws(() => parseReviewResultJson(""));
  // Duplicate keys are rejected, never resolved to the last value.
  assert.throws(() =>
    parseReviewResultJson(
      '{"verdict":"clean","verdict":"findings","summary":"s","findings":[]}',
    )
  );
});

Deno.test("strict result: unknown priority, invalid lines and bad paths are rejected", () => {
  const cases: Record<string, Record<string, unknown>> = {
    "priority high": { priority: 4 },
    "priority negative": { priority: -1 },
    "priority string": { priority: "1" },
    "line zero": { lineStart: 0 },
    "line reversed": { lineEnd: 9 },
    "path empty": { path: "" },
    "path absolute": { path: "/etc/passwd" },
    "path traversal": { path: "src/../../etc/passwd" },
    "path dot": { path: "./src/x.ts" },
    "path double": { path: "src//x.ts" },
    "path backslash": { path: "src\\x.ts" },
    "path drive": { path: "C:/src/x.ts" },
    "path newline": { path: "src\nx.ts" },
    "title empty": { title: "" },
    "title newline": { title: "a\nb" },
    "body return": { body: "a\r\nb" },
    "body control": { body: "a\u0000b" },
  };
  for (const [name, overrides] of Object.entries(cases)) {
    const result: ReviewResultV1 = {
      verdict: "findings",
      summary: "s",
      findings: [finding(overrides)],
    };
    assert.throws(() => parseReviewResultV1(result), Error, name);
  }
  // Result-level text bounds and control characters.
  assert.throws(() =>
    parseReviewResultV1({
      verdict: "clean",
      summary: "",
      findings: [],
    })
  );
  assert.throws(() =>
    parseReviewResultV1({
      verdict: "clean",
      summary: "a\u0001b",
      findings: [],
    })
  );
});

Deno.test("strict result: duplicates and field bounds are rejected", () => {
  const duplicate = [finding(), finding()];
  assert.throws(() =>
    parseReviewResultV1({
      verdict: "findings",
      summary: "s",
      findings: duplicate,
    })
  );
  const tooMany = Array.from(
    { length: MAX_FINDINGS + 1 },
    (_, i) => finding({ title: `t-${i}`, lineStart: i + 1, lineEnd: i + 1 }),
  );
  const overflow = tryParse(parseReviewResultV1, {
    verdict: "findings",
    summary: "s",
    findings: tooMany,
  });
  assert.ok(
    !overflow.ok && overflow.issues.some((i) => i.code === "bound_exceeded"),
  );
  // Combined title+body+location bound: never truncated, always rejected.
  const tooWide = [finding({
    title: "t".repeat(2048),
    body: "b".repeat(8192 - 2048 + 1),
  })];
  const wide = tryParse(parseReviewResultV1, {
    verdict: "findings",
    summary: "s",
    findings: tooWide,
  });
  assert.ok(!wide.ok && wide.issues.some((i) => i.code === "bound_exceeded"));
  // Summary is bounded at 4096 chars.
  const longSummary = tryParse(parseReviewResultV1, {
    verdict: "clean",
    summary: "s".repeat(4097),
    findings: [],
  });
  assert.ok(
    !longSummary.ok &&
      longSummary.issues.some((i) => i.code === "bound_exceeded"),
  );
});

// ---------------------------------------------------------------------------
// Journal: body integrity
// ---------------------------------------------------------------------------

Deno.test("journal: altered display text fails exact re-render equality", async () => {
  const journal = await readyJournal(cleanResult());
  const body = renderReviewJournalBody(journal);
  const altered = body.replace(
    "# Model review: clean",
    "# Model review: clean ",
  );
  assert.ok(altered !== body);
  await assert.rejects(parseReviewJournalBody(altered), /does not match/);
});

Deno.test("journal: altered metadata bytes fail parsing and equality", async () => {
  const journal = await readyJournal(cleanResult());
  const body = renderReviewJournalBody(journal);
  // Contradictory verdict introduced into the metadata.
  const contradictory = replaceMetadataText(
    body,
    (text) => text.replace('"verdict":"clean"', '"verdict":"findings"'),
  );
  await assert.rejects(parseReviewJournalBody(contradictory));
  // Altered summary value: metadata parses but the body no longer matches.
  const changedSummary = replaceMetadataText(
    body,
    (text) =>
      text.replace(
        '"summary":"no issues found"',
        '"summary":"changed summary"',
      ),
  );
  await assert.rejects(
    parseReviewJournalBody(changedSummary),
    /result digest mismatch/,
  );
  // Corrupt-but-decodable base64 metadata.
  const marker = "<!--sentinel-review-journal-v1\n";
  const rest = body.slice(marker.length);
  const end = rest.indexOf("\n-->");
  const encoded = rest.slice(0, end);
  const corrupted = body.replace(
    encoded,
    `${encoded[0] === "A" ? "B" : "A"}${encoded.slice(1)}`,
  );
  await assert.rejects(parseReviewJournalBody(corrupted));
});

Deno.test("journal: result digest is verified against the canonical result", async () => {
  const journal = await readyJournal(findingsResult());
  const body = renderReviewJournalBody(journal);
  const digest = journal.resultDigest;
  const flipped = digest[0] === "0" ? "1" : "0";
  const tampered = replaceMetadataText(
    body,
    (text) => text.replace(digest, `${flipped}${digest.slice(1)}`),
  );
  await assert.rejects(
    parseReviewJournalBody(tampered),
    /result digest mismatch/,
  );
  const parsed = asReady(await parseReviewJournalBody(body));
  assert.equal(parsed.resultDigest, digest);
});

Deno.test("journal: human text cannot forge or terminate the metadata region", async () => {
  const hostile = findingsResult();
  hostile.findings[0] = finding({
    title: "--> <!-- <script> --!> -- > --",
    body: "mostly harmless -- but also <!-- -->\nsecond line",
  });
  const journal = await readyJournal(hostile);
  const body = renderReviewJournalBody(journal);
  // Exactly one comment region with no raw comment delimiters elsewhere.
  assert.equal(countOccurrences(body, "<!--"), 1);
  assert.equal(countOccurrences(body, "-->"), 1);
  assert.equal(body.includes("<script>"), false);
  const parsed = asReady(await parseReviewJournalBody(body));
  assert.equal(parsed.result.findings[0].title, hostile.findings[0].title);
  assert.equal(parsed.result.findings[0].body, hostile.findings[0].body);
});

Deno.test("journal: duplicate JSON object keys in metadata are rejected", async () => {
  const duplicate = `{"version":"v1","version":"v1","phase":"intent",` +
    `"repository":{"owner":"ubiquity","name":"sentinel"},"prNumber":7,` +
    `"expectedHead":"${SHA_A}","expectedBase":"${SHA_B}",` +
    `"operationKey":"review:work-1","publisher":"sentinel[bot]",` +
    `"requestId":"req-1","requestedAt":${T0}}`;
  await assert.rejects(
    parseReviewJournalBody(bodyFromMetadataText(duplicate)),
    /strict JSON/,
  );
  // Key order and whitespace are fine; only duplicates are rejected.
  const reordered =
    `{  "phase":"intent","requestedAt":${T0},"requestId":"req-1",` +
    `"operationKey":"review:work-1","publisher":"sentinel[bot]",` +
    `"repository":{"name":"sentinel","owner":"ubiquity"},"prNumber":7,` +
    `"expectedBase":"${SHA_B}","expectedHead":"${SHA_A}",` +
    `"version":"v1"}`;
  const parsed = parseReviewJournalMetadata(reordered);
  assert.equal(parsed.phase, "intent");
  // The full-body parser is byte-exact: arbitrary display text never matches
  // the canonical render, so the same metadata inside a foreign body rejects.
  await assert.rejects(
    parseReviewJournalBody(bodyFromMetadataText(reordered)),
    /does not match/,
  );
});

Deno.test("journal: metadata version must be the exact v1 enum", () => {
  // Exported metadata parser validation, not re-render equality: a parser
  // that hardcodes `version: "v1"` would roundtrip these but must reject them.
  assert.throws(() =>
    parseReviewJournalMetadata(JSON.stringify({
      ...intentJournal(),
      version: "v2",
    }))
  );
  const missingVersion: Record<string, unknown> = { ...intentJournal() };
  delete missingVersion.version;
  assert.throws(() =>
    parseReviewJournalMetadata(JSON.stringify(missingVersion))
  );
});

Deno.test("journal: id/timestamp bounds hold (256 id, 128 login, completedAt>=requestedAt)", async () => {
  const longId = "x".repeat(257);
  assert.throws(() =>
    parseReviewJournalMetadata(JSON.stringify(intentJournal({
      operationKey: longId,
    })))
  );
  assert.throws(() =>
    parseReviewJournalMetadata(JSON.stringify(intentJournal({
      requestId: longId,
    })))
  );
  assert.throws(() =>
    parseReviewJournalMetadata(JSON.stringify(intentJournal({
      publisher: "x".repeat(129),
    })))
  );
  const ready = await readyJournal(cleanResult());
  const earlierCompleted: ReviewJournalReadyV1 = {
    ...ready,
    phase: "ready",
    completedAt: T0 - 1,
  };
  await assert.rejects(
    parseReviewJournalBody(renderReviewJournalBody(earlierCompleted)),
    /completion precedes/,
  );
});

Deno.test("journal: phase-specific unknown keys fail", async () => {
  // Intent carries no reviewId/execution.
  assert.throws(() =>
    parseReviewJournalMetadata(JSON.stringify({
      ...intentJournal(),
      reviewId: 100,
    }))
  );
  assert.throws(() =>
    parseReviewJournalMetadata(JSON.stringify({
      ...intentJournal(),
      execution: runningExecution(),
    }))
  );
  // Running carries no turnId yet.
  assert.throws(() =>
    parseReviewJournalMetadata(JSON.stringify({
      ...runningJournal(),
      turnId: "turn-1",
    }))
  );
  // Ready rejects unknown top-level keys and execution must follow its shape.
  const ready = await readyJournal(cleanResult());
  assert.throws(() =>
    parseReviewJournalMetadata(JSON.stringify({
      ...ready,
      turnId: "turn-1",
    }))
  );
  assert.throws(() =>
    parseReviewJournalMetadata(JSON.stringify({
      ...ready,
      execution: { ...readyExecution(), turn: "x" },
    }))
  );
});

Deno.test("journal: unknown secret-like keys are never echoed into diagnostics", () => {
  // A hostile unknown key must not leak the key name or its value into the
  // error message or any issue path/message at every exact-key boundary.
  const secretKey = "access_token";
  const secretValue = "ghs_xw9q4Gh7s2Lm8pT1cV5";
  const cases: { name: string; run: () => unknown }[] = [
    {
      name: "result",
      run: () =>
        parseReviewResultV1({
          verdict: "clean",
          summary: "no issues found",
          findings: [],
          [secretKey]: secretValue,
        }),
    },
    {
      name: "finding",
      run: () =>
        parseReviewResultV1({
          verdict: "findings",
          summary: "s",
          findings: [{ ...finding(), [secretKey]: secretValue }],
        }),
    },
    {
      name: "metadata",
      run: () =>
        parseReviewJournalMetadata(
          JSON.stringify({ ...intentJournal(), [secretKey]: secretValue }),
        ),
    },
    {
      name: "execution",
      run: () =>
        parseReviewJournalMetadata(
          JSON.stringify({
            ...runningJournal(),
            execution: { ...runningExecution(), [secretKey]: secretValue },
          }),
        ),
    },
  ];
  for (const { name, run } of cases) {
    let caught: unknown = null;
    try {
      run();
      assert.fail(`${name}: expected an unknown-key rejection`);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof RecordParseError, name);
    const error = caught as RecordParseError;
    assert.ok(!error.message.includes(secretKey), name);
    assert.ok(!error.message.includes(secretValue), name);
    assert.ok(
      error.issues.filter((issue) => issue.code === "unknown_key").length === 1,
      name,
    );
    for (const issue of error.issues) {
      assert.ok(!issue.path.includes(secretKey), `${name}: ${issue.path}`);
      assert.ok(!issue.path.includes(secretValue), `${name}: ${issue.path}`);
      assert.ok(!issue.message.includes(secretKey), name);
      assert.ok(!issue.message.includes(secretValue), name);
    }
  }
});

Deno.test("journal: completed verdicts require real runtime completion evidence", async () => {
  const completedViaHostTimeout = await readyJournal(cleanResult(), {
    execution: readyExecution({
      actual: {
        ...readyExecution().actual,
        terminalOrigin: "host-timeout",
        observedTerminalStatus: null,
      },
    }),
  });
  await assert.rejects(
    parseReviewJournalBody(renderReviewJournalBody(completedViaHostTimeout)),
    /requires observed runtime completion/,
  );
  const failedTerminal = await readyJournal(findingsResult(), {
    execution: readyExecution({
      actual: {
        ...readyExecution().actual,
        observedTerminalStatus: "interrupted",
      },
    }),
  });
  await assert.rejects(
    parseReviewJournalBody(renderReviewJournalBody(failedTerminal)),
    /requires observed runtime completion/,
  );
  const noExecution = await readyJournal(findingsResult(), { execution: null });
  await assert.rejects(
    parseReviewJournalBody(renderReviewJournalBody(noExecution)),
    /requires execution evidence/,
  );
  // Matching IDs and configured model/effort are enforced.
  const mismatchedIds = await readyJournal(cleanResult(), {
    execution: readyExecution({
      actual: {
        ...readyExecution().actual,
        threadId: "other-thread",
      },
    }),
  });
  await assert.rejects(
    parseReviewJournalBody(renderReviewJournalBody(mismatchedIds)),
    /thread identity does not match/,
  );
  const wrongModel = await readyJournal(cleanResult(), {
    execution: readyExecution({
      actual: {
        ...readyExecution().actual,
        observedModel: "gpt-4",
      },
    }),
  });
  await assert.rejects(
    parseReviewJournalBody(renderReviewJournalBody(wrongModel)),
    /observedModel.*expected one of/,
  );
  assert.throws(() =>
    parseReviewJournalMetadata(JSON.stringify({
      ...runningJournal(),
      execution: runningExecution({ model: "gpt-4" }),
    }))
  );
  assert.throws(() =>
    parseReviewJournalMetadata(JSON.stringify({
      ...runningJournal(),
      execution: runningExecution({ startMayOccur: false }),
    }))
  );
});

Deno.test("journal: rendered body overflow is unavailable, never partial", async () => {
  const big: ReviewFindingV1[] = Array.from({ length: 100 }, (_, i) =>
    finding({
      title: `t${i}-${"x".repeat(2000)}`,
      body: "",
      path: "src/a.ts",
      lineStart: i + 1,
      lineEnd: i + 1,
    }));
  const journal = await readyJournal({
    verdict: "findings",
    summary: "s",
    findings: big,
  });
  let caught: unknown = null;
  try {
    renderReviewJournalBody(journal);
  } catch (error) {
    caught = error;
  }
  assert.equal(isJournalBoundExceeded(caught), true);
  assert.ok(findingMessage(big[0]).length <= MAX_FINDING_MESSAGE);
  // The byte bound also applies to the parser input.
  const oversized = "x".repeat(MAX_JOURNAL_BYTES + 1);
  let caughtOver: unknown = null;
  try {
    await parseReviewJournalBody(oversized);
  } catch (error) {
    caughtOver = error;
  }
  assert.equal(isJournalBoundExceeded(caughtOver), true);
});

Deno.test("journal: missing or misplaced metadata regions are rejected", async () => {
  await assert.rejects(
    parseReviewJournalBody("no metadata here"),
    /metadata marker/,
  );
  await assert.rejects(
    parseReviewJournalBody(`<!--sentinel-review-journal-v1\n${toBase64("{}")}`),
    /metadata terminator/,
  );
  await assert.rejects(
    parseReviewJournalBody("<!--sentinel-review-journal-v1\n\n-->\n\nx"),
    /malformed/,
  );
  await assert.rejects(
    parseReviewJournalBody(
      `<!--sentinel-review-journal-v1\n${toBase64("{not json")}\n-->\n\nx`,
    ),
    /strict JSON/,
  );
});

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let at = 0;
  for (;;) {
    const found = text.indexOf(needle, at);
    if (found === -1) return count;
    count++;
    at = found + needle.length;
  }
}
