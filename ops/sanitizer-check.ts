/**
 * Local case evaluator for the issue-48 sanitizer candidate.
 *
 * Runs the candidate's own `sanitizeAutoCloseKeywords` against every case the
 * runtime review has reported plus the issue's acceptance cases, so the next
 * review round can be predicted without waiting for it. Read-only: it fetches
 * the repair branch and imports the reviewed revision of src/github/text.ts.
 *
 * Usage: deno run --allow-read --allow-run=git --allow-write=/tmp sanitizer-check.ts [ref]
 */
import { copy } from "https://deno.land/std@0.224.0/fs/copy.ts";
import { ensureDir } from "https://deno.land/std@0.224.0/fs/ensure_dir.ts";

const ref = Deno.args[0] ?? "origin/sentinel/repair/issue-ubiquity-sentinel-48";
const tmp = await Deno.makeTempDir({ prefix: "sanitizer-check-" });

async function git(args: string[], cwd: string) {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout);
}

await git(["fetch", "-q", "origin", ref.replace("origin/", "")], Deno.cwd());
const sha = (await git(["rev-parse", ref], Deno.cwd())).trim();
await ensureDir(`${tmp}/src/github`);
await git(["show", `${sha}:src/github/text.ts`], Deno.cwd()).then((text) =>
  Deno.writeTextFile(`${tmp}/src/github/text.ts`, text)
);

const module = await import(`file://${tmp}/src/github/text.ts`);
const sanitize = module.sanitizeAutoCloseKeywords as (body: string) => string;

/** Every case the runtime review reported, plus the issue's own acceptance. */
const CASES: { body: string; expect: "strip" | "keep"; source: string }[] = [
  { body: "Fixes #123", expect: "strip", source: "issue acceptance" },
  {
    body: "Fixes ubiquity/sentinel#123",
    expect: "strip",
    source: "issue acceptance",
  },
  { body: "CLOSES: #123", expect: "strip", source: "issue acceptance" },
  {
    body: "References fixed-tools/widget#123; keep this text.",
    expect: "keep",
    source: "issue acceptance",
  },
  { body: "fixesowner/repo#123", expect: "keep", source: "issue acceptance" },
  { body: "closed-source/project#123", expect: "keep", source: "issue" },
  { body: "resolved-tools/project#123", expect: "keep", source: "issue" },
  {
    body: "https://example.test/?x=fixes:#123",
    expect: "keep",
    source: "review round 7",
  },
  {
    body: "References ubiquity/repo.fixes #123",
    expect: "keep",
    source: "review round 8",
  },
  {
    body: "https://example.test/?fixes:#116",
    expect: "keep",
    source: "review round 9",
  },
  {
    body: "https://example.test/foo.fixes:#123",
    expect: "keep",
    source: "review round 10",
  },
];

let failures = 0;
for (const item of CASES) {
  const actual = sanitize(item.body);
  const keywordGone = actual !== item.body;
  const wanted = item.expect === "strip";
  const ok = keywordGone === wanted;
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} [${item.source}] ${JSON.stringify(item.body)} -> ${
      JSON.stringify(actual)
    }`,
  );
}
console.log(`\n${CASES.length - failures}/${CASES.length} cases satisfied`);
await Deno.remove(tmp, { recursive: true }).catch(() => {});
Deno.exit(failures === 0 ? 0 : 1);
