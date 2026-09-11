// Test-only helpers for the ReplayPort suite (m03). Everything here creates
// CREDENTIAL-FREE real local toy repositories and trusted test fixtures; no
// network, no model calls, no paid upstream. The toy app is a tiny streaming
// gateway handler whose original revision 500s on a missing completion
// terminator and whose candidate revision tolerates it — the recorded
// upstream fixture is replayed locally through the handler.
import type {
  CommandId,
  FixtureDigest,
  GitSha,
  WorkItemId,
} from "../../src/contracts/brands.ts";
import { parseRepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type {
  PortResultV1,
  ReplayRunRequestV1,
} from "../../src/contracts/ports.ts";
import {
  computeReplayFixtureDigest,
  markerProofParser,
} from "../../src/replay/fixture.ts";
import type {
  FixtureResolverV1,
  ReplayPolicyV1,
  ResolvedFixtureV1,
} from "../../src/replay/fixture.ts";
import type {
  ReplayIsolationCapabilityV1,
  ReplayPortOptions,
  ReplaySourceV1,
} from "../../src/replay/port.ts";
import { ReplayPortImpl } from "../../src/replay/port.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import type { ReplayRuntimeV1 } from "../../src/replay/runtime.ts";

export const TEST_ID = "gateway:stream-termination";
export const FIXTURE_REF = "fixture://captures/toy/upstream.json";
export const TOY_REPOSITORY = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 12345,
} as const;

export interface ToyApp {
  root: string;
  env: Record<string, string>;
  originalSha: GitSha;
  candidateSha: GitSha;
  unrelatedSha: GitSha;
}

// ---------------------------------------------------------------------------
// Toy application source (real files committed to the toy git repository)
// ---------------------------------------------------------------------------

const TOY_DENO_JSON = JSON.stringify(
  {
    tasks: {
      test: "deno test --allow-read=tests/,src/ tests/",
      replay: "deno run --allow-read=tests/,src/ scripts/replay.ts",
    },
  },
  null,
  2,
) + "\n";

const APP_BUGGY = `/** Toy streaming gateway handler. */
export interface StreamFixture {
  lines: string[];
  completed: boolean;
}

export async function handleRequest(
  fixture: StreamFixture,
): Promise<Response> {
  const payload = fixture.lines
    .map((line) => line.replace(/^data: /, ""))
    .join("\\n");
  if (!fixture.completed) {
    // ORIGINAL BUG: a stream that ends without the completion terminator
    // is treated as a server failure.
    return new Response("stream terminated unexpectedly", { status: 500 });
  }
  return new Response(JSON.stringify({ payload }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
`;

const APP_FIXED = `/** Toy streaming gateway handler. */
export interface StreamFixture {
  lines: string[];
  completed: boolean;
}

export async function handleRequest(
  fixture: StreamFixture,
): Promise<Response> {
  const payload = fixture.lines
    .map((line) => line.replace(/^data: /, ""))
    .join("\\n");
  // CANDIDATE FIX: the recorded upstream ends after the final data line
  // without a separate terminator; that is a complete stream, not a failure.
  return new Response(JSON.stringify({ payload, completed: fixture.completed }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
`;

const APP_UNRELATED = `/** Toy streaming gateway handler. */
export interface StreamFixture {
  lines: string[];
  completed: boolean;
}

export async function handleRequest(
  _fixture: StreamFixture,
): Promise<Response> {
  // UNRELATED BREAKAGE: fails for a different reason than the regression.
  return new Response("unrelated failure: boom", { status: 503 });
}
`;

// ---------------------------------------------------------------------------
// Trusted sanitized fixture bundle (the exact candidate regression test plus
// the recorded upstream data, replayed locally — no network)
// ---------------------------------------------------------------------------

export const FIXTURE_JSON = JSON.stringify(
  { lines: ["data: hello", "data: world"], completed: false },
  null,
  2,
) + "\n";

export const REGRESSION_TEST = `import assert from "node:assert/strict";
import { handleRequest } from "../src/app.ts";

Deno.test("gateway: stream termination honors recorded upstream", async () => {
  console.log("sentinel-replay-test:gateway:stream-termination");
  const recorded = JSON.parse(
    await Deno.readTextFile("tests/fixtures/upstream.json"),
  );
  const response = await handleRequest(recorded);
  const body = await response.text();
  assert.equal(
    response.status,
    200,
    \`expected 200 but got \${response.status}: \${body}\`,
  );
  assert.deepEqual(JSON.parse(body), {
    payload: "hello\\nworld",
    completed: false,
  });
});
`;

export const REPLAY_SCRIPT = `import { handleRequest } from "../src/app.ts";

const recorded = JSON.parse(
  await Deno.readTextFile("tests/fixtures/upstream.json"),
);
const response = await handleRequest(recorded);
const body = await response.text();
console.log("sentinel-replay-test:gateway:stream-termination");
console.log(\`status=\${response.status}\`);
if (response.status !== 200) {
  console.error(body);
  Deno.exit(1);
}
`;

/** The exact toy bundle files, as delivered into the toy's normal CI. */
export const TOY_BUNDLE_FILES: Record<string, string> = {
  "tests/regression_test.ts": REGRESSION_TEST,
  "tests/fixtures/upstream.json": FIXTURE_JSON,
  "scripts/replay.ts": REPLAY_SCRIPT,
};

/** The candidate implementation bytes (fix only; tests live in the bundle). */
export const TOY_APP_FIXED = APP_FIXED;

export function toyBundle(
  overrides: Partial<ResolvedFixtureV1> = {},
): ResolvedFixtureV1 {
  return {
    testIds: [TEST_ID],
    expectedFailure: {
      reason: "missing completion terminator produces 500",
      match: { kind: "contains", text: "stream terminated unexpectedly" },
    },
    entries: [
      { path: "tests/regression_test.ts", bytes: encode(REGRESSION_TEST) },
      { path: "tests/fixtures/upstream.json", bytes: encode(FIXTURE_JSON) },
      { path: "scripts/replay.ts", bytes: encode(REPLAY_SCRIPT) },
    ],
    provenance: {
      sanitized: true,
      sanitizer: "toy-sanitizer",
      provenanceRef: "fixture://provenance/toy/upstream",
      redacted: false,
      note: "recorded upstream replayed locally; no credentials",
    },
    ...overrides,
  };
}

export function toyPolicy(): ReplayPolicyV1 {
  return {
    bundleScopes: ["tests/", "scripts/"],
    maxFixtureBytes: 256 * 1024,
    maxEntryBytes: 128 * 1024,
    proof: markerProofParser(),
  };
}

/**
 * Explicitly trusted fixture-mode capability for local toy tests only. The
 * callable `run` is an explicit fixture-only boundary: it delegates to the
 * supplied test runtime, or to a fresh DenoReplayRuntime when none is given.
 * It never stands in for a production restricted-execution host.
 */
export function toyIsolation(
  runtime?: ReplayRuntimeV1,
): ReplayIsolationCapabilityV1 {
  const fixtureRuntime = runtime ??
    new DenoReplayRuntime(Deno.env.get("PATH") ?? "/usr/bin:/bin");
  return {
    attestation: {
      version: "v1",
      host: "toy-restricted-host",
      restrictedExecution: true,
      boundary:
        "test fixture mode: disposable local toy checkout, no external calls",
      attestationRef: "fixture://isolation/toy",
    },
    run: (input) => fixtureRuntime.run(input),
  };
}

export function toySource(root: string): ReplaySourceV1 {
  return { kind: "local", path: root };
}

export function toyConfig(): RepositoryConfigV1 {
  return parseRepositoryConfigV1({
    version: "v1",
    kind: "repository_config",
    repository: TOY_REPOSITORY,
    baseBranch: "main",
    adapter: { kind: "gateway", baseUrl: "https://ai.ubq.fi" },
    commands: { replay: "replay", test: "test" },
    commandRegistry: {
      version: "v1",
      commands: {
        replay: {
          executable: "deno",
          args: ["task", "replay"],
          maxDurationMs: 15000,
          maxOutputBytes: 262144,
        },
        test: {
          executable: "deno",
          args: ["task", "test"],
          maxDurationMs: 15000,
          maxOutputBytes: 262144,
        },
      },
    },
    protectedPaths: ["src/"],
    build: { projectId: null, acceptance: null },
    secretRef: null,
    liveStartLimits: null,
    sessionBound: null,
    retention: null,
    stabilityPolicy: null,
  });
}

export function toyOptions(
  toyRoot: string,
  scratchDir: string,
  overrides: Partial<ReplayPortOptions> = {},
): ReplayPortOptions {
  return {
    config: toyConfig(),
    source: toySource(toyRoot),
    scratchDir,
    fixtures: new ToyFixtureResolver(toyBundle()),
    policy: toyPolicy(),
    // Bind the fixture boundary to the caller-supplied runtime BEFORE the
    // override spread, so a deliberate `isolation: undefined` stays invalid
    // instead of being silently repaired by a later override.
    isolation: toyIsolation(overrides.runtime),
    ...overrides,
  };
}

export function makePort(
  toyRoot: string,
  scratchDir: string,
  overrides: Partial<ReplayPortOptions> = {},
): ReplayPortImpl {
  return new ReplayPortImpl(toyOptions(toyRoot, scratchDir, overrides));
}

export async function replayRequest(
  bundle: ResolvedFixtureV1,
  revision: GitSha,
  overrides: Record<string, unknown> = {},
): Promise<ReplayRunRequestV1> {
  const digest = await computeReplayFixtureDigest(bundle.entries);
  return {
    taskId: "incident:toy-0001" as WorkItemId,
    repository: TOY_REPOSITORY,
    revision,
    commandId: "test" as CommandId,
    fixtureRef: FIXTURE_REF,
    fixtureDigest: digest,
    testIds: bundle.testIds,
    outputLimitBytes: 262144,
    ...overrides,
  } as ReplayRunRequestV1;
}

// ---------------------------------------------------------------------------
// Trusted test resolver (injected fixture transport; no product logic)
// ---------------------------------------------------------------------------

export class ToyFixtureResolver implements FixtureResolverV1 {
  constructor(private readonly bundle: ResolvedFixtureV1) {}

  resolveFixture(ref: string): Promise<PortResultV1<ResolvedFixtureV1>> {
    if (ref !== FIXTURE_REF) {
      return Promise.resolve(
        portError("not_found", `no fixture resolved for ref ${ref}`),
      );
    }
    return Promise.resolve(portOk(this.bundle));
  }
}

// ---------------------------------------------------------------------------
// Credential-free git helpers (mirror the state suite's environment shape)
// ---------------------------------------------------------------------------

export function testGitEnv(home: string): Record<string, string> {
  return {
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "sentinel-replay-test",
    GIT_AUTHOR_EMAIL: "sentinel-replay-test@localhost",
    GIT_COMMITTER_NAME: "sentinel-replay-test",
    GIT_COMMITTER_EMAIL: "sentinel-replay-test@localhost",
  };
}

export interface GitRunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export async function gitRun(
  cwd: string,
  args: string[],
  env: Record<string, string>,
): Promise<GitRunResult> {
  const result = await new Deno.Command("git", {
    args,
    cwd,
    clearEnv: true,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    ok: result.success,
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

export async function revParse(
  cwd: string,
  env: Record<string, string>,
): Promise<GitSha> {
  const result = await gitRun(cwd, ["rev-parse", "HEAD"], env);
  if (!result.ok) throw new Error(`rev-parse HEAD failed: ${result.stderr}`);
  return result.stdout.trim() as GitSha;
}

/**
 * Create the tiny toy repository: original bug, candidate fix, unrelated
 * breakage — three commits on a single main branch, all credential-free.
 */
export async function createToyApp(root: string): Promise<ToyApp> {
  await Deno.mkdir(root, { recursive: true });
  const env = testGitEnv(`${root}/home`);
  const init = await gitRun(root, ["init", "-q", "-b", "main"], env);
  if (!init.ok) throw new Error(`toy init failed: ${init.stderr}`);

  const write = async (path: string, text: string): Promise<void> => {
    const full = `${root}/${path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, text);
  };

  await write("deno.json", TOY_DENO_JSON);
  await write("src/app.ts", APP_BUGGY);
  await commitAll(root, env, "original: missing terminator produces 500");
  const originalSha = await revParse(root, env);

  // The candidate is the DELIVERED head: the fix plus the permanent
  // regression test + recorded upstream fixture, wired into the toy's
  // normal CI (`deno task test` picks up tests/). The trusted bundle must
  // replay original-intended-failure AND this exact candidate head even
  // though the candidate already contains the bundle bytes.
  await write("src/app.ts", APP_FIXED);
  for (const [path, text] of Object.entries(TOY_BUNDLE_FILES)) {
    await write(path, text);
  }
  await commitAll(
    root,
    env,
    "candidate: tolerate missing terminator; deliver permanent regression fixtures",
  );
  const candidateSha = await revParse(root, env);

  await write("src/app.ts", APP_UNRELATED);
  await commitAll(root, env, "unrelated: different breakage");
  const unrelatedSha = await revParse(root, env);

  return { root, env, originalSha, candidateSha, unrelatedSha };
}

export async function commitWith(
  root: string,
  env: Record<string, string>,
  files: Record<string, string>,
  message: string,
): Promise<GitSha> {
  for (const [path, text] of Object.entries(files)) {
    const full = `${root}/${path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, text);
  }
  await commitAll(root, env, message);
  return revParse(root, env);
}

async function commitAll(
  root: string,
  env: Record<string, string>,
  message: string,
): Promise<void> {
  const add = await gitRun(root, ["add", "-A"], env);
  if (!add.ok) throw new Error(`toy add failed: ${add.stderr}`);
  const commit = await gitRun(root, ["commit", "-q", "-m", message], env);
  if (!commit.ok) throw new Error(`toy commit failed: ${commit.stderr}`);
}

/**
 * Commit a symlink at `linkPath` whose blob text is `blobText`
 * (malicious-checkout fixture). Built with git plumbing so the test process
 * never needs symlink permissions: a gitlink entry (mode 120000) replaces
 * any existing index entry at `linkPath` (the delivered candidate contains
 * real files there, so the old entry is removed from the index first; the
 * worktree files remain untracked and never enter this commit).
 */
export async function commitSymlink(
  root: string,
  env: Record<string, string>,
  linkPath = "tests",
  blobText = "src",
): Promise<GitSha> {
  const remove = await gitRun(
    root,
    ["rm", "-r", "--cached", "--quiet", linkPath],
    env,
  );
  if (
    !remove.ok && !/did not match any files|pathspec .* did not match/.test(
      remove.stderr,
    )
  ) {
    throw new Error(`git rm --cached failed: ${remove.stderr}`);
  }
  const targetFile = `${root}/.link-target`;
  await Deno.writeTextFile(targetFile, blobText);
  try {
    const blob = await gitRun(
      root,
      ["hash-object", "-w", targetFile],
      env,
    );
    if (!blob.ok) throw new Error(`hash-object failed: ${blob.stderr}`);
    const blobSha = blob.stdout.trim();
    const index = await gitRun(
      root,
      ["update-index", "--add", "--cacheinfo", `120000,${blobSha},${linkPath}`],
      env,
    );
    if (!index.ok) throw new Error(`update-index failed: ${index.stderr}`);
  } finally {
    await Deno.remove(targetFile).catch(() => {});
  }
  const commit = await gitRun(
    root,
    ["commit", "-q", "-m", `symlink ${linkPath} -> ${blobText}`],
    env,
  );
  if (!commit.ok) throw new Error(`symlink commit failed: ${commit.stderr}`);
  return revParse(root, env);
}

/** Expected digest over a bundle entry set (independent of the port impl). */
export function bundleDigest(
  text: Record<string, string>,
): Promise<FixtureDigest> {
  const entries = Object.entries(text)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, content]) => ({ path, bytes: encode(content) }));
  return computeReplayFixtureDigest(entries);
}

export async function sha256HexText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
