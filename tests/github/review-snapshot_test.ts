/**
 * T03: bounded trusted Git manifest producer against REAL temporary Git
 * object repositories. No network, no model, no GitHub and no paid calls.
 */

import assert from "node:assert/strict";
import { asGitSha, type GitSha } from "../../src/contracts/brands.ts";
import {
  GitReviewSnapshot,
  isSafeReviewPath,
  MAX_CAPTURE_BLOB_BYTES,
  MAX_CHANGED_PATHS,
  MAX_FILE_BYTES,
  MAX_NEW_COMMITS,
  MAX_NEW_OBJECTS,
  MAX_PROMPT_BYTES,
  renderReviewPrompt,
  type ReviewSnapshotV1,
  validateReviewSnapshotV1,
  verifyReviewSnapshotDigest,
} from "../../src/github/review-snapshot.ts";
import type {
  ReplayCommandInputV1,
  ReplayCommandOutcomeV1,
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "../../src/replay/runtime.ts";

const here = new URL(import.meta.url);
if (here.protocol !== "file:") throw new Error("expected a file: test module");
const testsDir = decodeURIComponent(here.pathname).replace(
  /\/review-snapshot_test\.ts$/,
  "",
);

const PATH = Deno.env.get("PATH") ?? "/usr/bin:/bin";
const ZERO_SHA = "0".repeat(40);
const ZERO_MODE = "000000";

function contains(text: string, needle: string, message?: string): void {
  assert.ok(text.includes(needle), message ?? `expected ${needle} in text`);
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<Deno.CommandOutput> {
  return await new Deno.Command("git", {
    args,
    cwd,
    clearEnv: true,
    env: {
      PATH,
      HOME: cwd,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      // Test-side probes stay honest: a missing promisor object is observed as
      // missing, never silently materialized by a lazy fetch.
      GIT_NO_LAZY_FETCH: "1",
      GIT_AUTHOR_NAME: "Sentinel Test",
      GIT_AUTHOR_EMAIL: "sentinel-test@example.invalid",
      GIT_COMMITTER_NAME: "Sentinel Test",
      GIT_COMMITTER_EMAIL: "sentinel-test@example.invalid",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (!result.success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${
        new TextDecoder().decode(result.stderr)
      }`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}

/** True when the command exits 0; used to prove an object stays missing. */
async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  return (await runGit(cwd, args)).success;
}

/**
 * Run one tiny Git fixture command with piped stdin. Used only to build the
 * explicit empty-tree fixture through `git mktree`, which reads stdin.
 */
async function gitWithInput(
  cwd: string,
  args: string[],
  input: string,
): Promise<string> {
  const child = new Deno.Command("git", {
    args,
    cwd,
    clearEnv: true,
    env: {
      PATH,
      HOME: cwd,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_NO_LAZY_FETCH: "1",
      GIT_AUTHOR_NAME: "Sentinel Test",
      GIT_AUTHOR_EMAIL: "sentinel-test@example.invalid",
      GIT_COMMITTER_NAME: "Sentinel Test",
      GIT_COMMITTER_EMAIL: "sentinel-test@example.invalid",
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const result = await child.output();
  if (!result.success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${
        new TextDecoder().decode(result.stderr)
      }`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}

/** Exact blob identity of one repository-relative path at one commit. */
async function blobAt(
  repo: string,
  commit: GitSha,
  path: string,
): Promise<string> {
  return (await git(repo, ["rev-parse", `${commit}:${path}`])).trim();
}

async function withRepo<T>(fn: (repo: string) => Promise<T>): Promise<T> {
  const repo = await Deno.makeTempDir({
    prefix: ".review-snapshot-",
    dir: testsDir,
  });
  try {
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "sentinel-test@example.invalid"]);
    await git(repo, ["config", "user.name", "Sentinel Test"]);
    await git(repo, ["config", "commit.gpgsign", "false"]);
    return await fn(repo);
  } finally {
    await Deno.remove(repo, { recursive: true }).catch(() => {});
  }
}

/** Stage the whole worktree and commit it. */
async function commitAll(repo: string, message: string): Promise<GitSha> {
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", message]);
  return asGitSha((await git(repo, ["rev-parse", "HEAD"])).trim());
}

/** Commit exactly the prepared index (used for gitlink fixtures). */
async function commitIndex(repo: string, message: string): Promise<GitSha> {
  await git(repo, ["commit", "-q", "-m", message]);
  return asGitSha((await git(repo, ["rev-parse", "HEAD"])).trim());
}

function producer(
  repo: string,
  overrides: Partial<ConstructorParameters<typeof GitReviewSnapshot>[0]> = {},
): GitReviewSnapshot {
  return new GitReviewSnapshot({
    trustedPath: PATH,
    repositoryDir: repo,
    ...overrides,
  });
}

/** Deterministic injected runtime for process/deadline failure paths. */
function fakeRuntime(
  result: Partial<ReplayCommandResultV1> & { outcome: ReplayCommandOutcomeV1 },
): ReplayRuntimeV1 {
  return {
    run: () =>
      Promise.resolve({
        exitCode: 0,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        truncated: false,
        settled: true,
        detail: "",
        ...result,
      }),
  };
}

async function seedTwoCommitRepo(
  repo: string,
): Promise<{ base: GitSha; head: GitSha }> {
  await Deno.writeTextFile(
    `${repo}/account.ts`,
    "export function deposit(balance: number, amount: number) {\n" +
      "  return balance + amount;\n" +
      "}\n",
  );
  await Deno.writeTextFile(`${repo}/README.md`, "synthetic specification\n");
  const base = await commitAll(repo, "base");
  await Deno.writeTextFile(
    `${repo}/account.ts`,
    "export function deposit(balance: number, amount: number) {\n" +
      '  if (amount < 0) throw new Error("negative");\n' +
      "  return balance + amount;\n" +
      "}\n",
  );
  await Deno.writeTextFile(`${repo}/new.ts`, "export const added = true;\n");
  await Deno.remove(`${repo}/README.md`);
  const head = await commitAll(repo, "head");
  return { base, head };
}

Deno.test(
  "snapshot: exact manifest identities despite mutable checkout changes and a deletion",
  async () => {
    await withRepo(async (repo) => {
      const { base, head } = await seedTwoCommitRepo(repo);
      const capture = await producer(repo).capture({ base, head });
      if (!capture.ok) {
        assert.fail(`expected snapshot: ${capture.error.detail}`);
      }
      const snapshot = capture.value;
      assert.equal(snapshot.base, base);
      assert.equal(snapshot.head, head);
      assert.equal(snapshot.mergeBase, base);
      assert.equal(snapshot.digest.length, 64);
      assert.ok(await verifyReviewSnapshotDigest(snapshot));
      assert.equal("diff" in snapshot, false, "no aggregate diff is carried");

      const account = snapshot.files.find((file) => file.path === "account.ts");
      assert.deepEqual(account, {
        path: "account.ts",
        kind: "modified",
        oldBlob: await blobAt(repo, base, "account.ts"),
        newBlob: await blobAt(repo, head, "account.ts"),
        oldMode: "100644",
        newMode: "100644",
        candidateLines: 4,
      });
      assert.deepEqual(
        snapshot.files.map((file) => [file.path, file.kind]),
        [
          ["README.md", "deleted"],
          ["account.ts", "modified"],
          ["new.ts", "added"],
        ],
      );
      const readme = snapshot.files.find((file) => file.path === "README.md");
      assert.equal(readme?.candidateLines, null);
      assert.equal(readme?.newBlob, ZERO_SHA);
      assert.equal(readme?.newMode, ZERO_MODE);
      const added = snapshot.files.find((file) => file.path === "new.ts");
      assert.equal(added?.oldBlob, ZERO_SHA);
      assert.equal(added?.oldMode, ZERO_MODE);
      assert.equal(added?.candidateLines, 1);
      for (const file of snapshot.files) {
        assert.equal("content" in file, false, "no blob content is carried");
      }

      // The mutable checkout moves (and even loses files) AFTER capture: the
      // immutable manifest and its digest must not move with it.
      await Deno.writeTextFile(`${repo}/account.ts`, "export const x = 1;\n");
      await Deno.remove(`${repo}/new.ts`);
      await Deno.writeTextFile(`${repo}/untracked.ts`, "export const y = 1;\n");
      const again = await producer(repo).capture({ base, head });
      if (!again.ok) assert.fail(`expected recapture: ${again.error.detail}`);
      assert.equal(again.value.digest, snapshot.digest);
      assert.deepEqual(again.value.files, snapshot.files);

      const prompt = renderReviewPrompt(snapshot);
      contains(prompt, `Base ${base}; head ${head};`);
      contains(prompt, snapshot.digest);
      contains(prompt, "COMPLETE CHANGED-PATH MANIFEST");
      contains(prompt, 'path "new.ts"; kind added');
      contains(prompt, 'path "README.md"; kind deleted');
      contains(prompt, `newBlob ${await blobAt(repo, head, "new.ts")}`);
      contains(prompt, "--no-ext-diff");
      contains(prompt, "--no-textconv");
      assert.equal(
        prompt.includes("export const added = true"),
        false,
        "the manifest prompt embeds no candidate content",
      );
      assert.ok(prompt.length < MAX_PROMPT_BYTES);
      assert.equal(prompt, renderReviewPrompt(again.value));
    });
  },
);

Deno.test(
  "snapshot: stale base (head not descended from base) is rejected",
  async () => {
    await withRepo(async (repo) => {
      const { base, head } = await seedTwoCommitRepo(repo);
      const capture = await producer(repo).capture({ base: head, head: base });
      assert.ok(!capture.ok, "a nonintegrated base must be unavailable");
      if (capture.ok) assert.fail("expected rejection");
      assert.equal(capture.error.kind, "unavailable");
      contains(capture.error.detail, "ancestor");
    });
  },
);

Deno.test(
  "snapshot: an unchanged base/head pair has nothing to review",
  async () => {
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/account.ts`, "export const a = 1;\n");
      const base = await commitAll(repo, "only");
      const capture = await producer(repo).capture({ base, head: base });
      assert.ok(!capture.ok, "an unchanged pair must be unavailable");
      if (capture.ok) assert.fail("expected rejection");
      assert.equal(capture.error.kind, "unavailable");
    });
  },
);

Deno.test(
  "snapshot: binary blobs are rejected, never omitted or truncated",
  async () => {
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/account.ts`, "export const a = 1;\n");
      const base = await commitAll(repo, "base");
      await Deno.writeFile(
        `${repo}/blob.bin`,
        new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff]),
      );
      const head = await commitAll(repo, "binary");
      const capture = await producer(repo).capture({ base, head });
      assert.ok(!capture.ok, "binary content must be unavailable");
      if (capture.ok) assert.fail("expected rejection");
      contains(capture.error.detail, "binary");
    });
  },
);

Deno.test("snapshot: symlinks and submodules are unsupported", async () => {
  await withRepo(async (repo) => {
    await Deno.writeTextFile(`${repo}/account.ts`, "export const a = 1;\n");
    const base = await commitAll(repo, "base");
    // Deno.symlink is outside the scoped read grants, so create the link with
    // a credential-free `ln` child inside the repository.
    const linked = await new Deno.Command("ln", {
      args: ["-s", "account.ts", `${repo}/link.ts`],
      cwd: repo,
      clearEnv: true,
      env: { PATH },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(linked.code, 0, "ln -s must create the symlink");
    const symlinkHead = await commitAll(repo, "symlink");
    const symlink = await producer(repo).capture({ base, head: symlinkHead });
    assert.ok(!symlink.ok, "symlink changes must be unavailable");
    if (symlink.ok) assert.fail("expected rejection");
    contains(symlink.error.detail, "symlink");

    // A gitlink (submodule) entry staged directly in the index.
    await Deno.remove(`${repo}/link.ts`);
    await git(repo, ["update-index", "--force-remove", "link.ts"]);
    await git(repo, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${base},vendor`,
    ]);
    const submoduleHead = await commitIndex(repo, "submodule");
    const submodule = await producer(repo).capture({
      base,
      head: submoduleHead,
    });
    assert.ok(!submodule.ok, "submodule changes must be unavailable");
    if (submodule.ok) assert.fail("expected rejection");
    contains(submodule.error.detail, "submodule");
  });
});

Deno.test("snapshot: a regular deletion is captured explicitly", async () => {
  await withRepo(async (repo) => {
    await Deno.writeTextFile(`${repo}/a.ts`, "export const a = 1;\n");
    await Deno.writeTextFile(`${repo}/b.ts`, "export const b = 1;\n");
    const base = await commitAll(repo, "base");
    await Deno.remove(`${repo}/b.ts`);
    const head = await commitAll(repo, "delete b");
    const capture = await producer(repo).capture({ base, head });
    if (!capture.ok) assert.fail(`expected snapshot: ${capture.error.detail}`);
    assert.deepEqual(capture.value.files, [{
      path: "b.ts",
      kind: "deleted",
      oldBlob: await blobAt(repo, base, "b.ts"),
      newBlob: ZERO_SHA,
      oldMode: "100644",
      newMode: ZERO_MODE,
      candidateLines: null,
    }]);
  });
});

Deno.test(
  "snapshot: candidate line counts are exact for added and modified files",
  async () => {
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/seed.ts`, "seed\n");
      const base = await commitAll(repo, "base");
      await Deno.writeTextFile(`${repo}/empty.ts`, "");
      await Deno.writeTextFile(`${repo}/no-newline.ts`, "a\nb");
      await Deno.writeTextFile(`${repo}/with-newline.ts`, "a\nb\n");
      const head = await commitAll(repo, "line counts");
      const capture = await producer(repo).capture({ base, head });
      if (!capture.ok) {
        assert.fail(`expected snapshot: ${capture.error.detail}`);
      }
      const lines = new Map(
        capture.value.files.map((file) => [file.path, file.candidateLines]),
      );
      assert.equal(lines.get("empty.ts"), 0);
      assert.equal(lines.get("no-newline.ts"), 2);
      assert.equal(lines.get("with-newline.ts"), 2);
      const prompt = renderReviewPrompt(capture.value);
      contains(prompt, 'path "empty.ts"; kind added');
      contains(prompt, "candidateLines 0");
      contains(prompt, "candidateLines 2");
    });
  },
);

Deno.test("snapshot: unsafe paths are rejected by the trusted validator", () => {
  for (
    const hostile of [
      "/etc/passwd",
      "a/../b",
      "..",
      "./x",
      "a//b",
      "a\\b",
      "C:/windows",
      "a\u0000b",
      "a\u001fb",
      "",
      "-leading-dash",
      "x".repeat(2048),
    ]
  ) {
    assert.ok(!isSafeReviewPath(hostile), `hostile path accepted: ${hostile}`);
  }
  assert.ok(isSafeReviewPath("src/handler.ts"));
  assert.ok(isSafeReviewPath("docs/a b/c d.md"));
});

Deno.test("snapshot: invalid UTF-8 candidate content is rejected", async () => {
  await withRepo(async (repo) => {
    await Deno.writeTextFile(`${repo}/account.ts`, "export const a = 1;\n");
    const base = await commitAll(repo, "base");
    await Deno.writeFile(
      `${repo}/bad.ts`,
      new Uint8Array([0x61, 0x20, 0xc3, 0x28, 0x0a]),
    );
    const head = await commitAll(repo, "invalid utf8");
    const capture = await producer(repo).capture({ base, head });
    assert.ok(!capture.ok, "invalid UTF-8 must be unavailable");
    if (capture.ok) assert.fail("expected rejection");
    assert.equal(capture.error.kind, "unavailable");
    contains(capture.error.detail, "UTF-8");
  });
});

Deno.test(
  "snapshot: changed-path bound rejects overflow and the aggregate patch never enters the manifest",
  async () => {
    assert.equal(MAX_CHANGED_PATHS, 128);
    assert.equal(MAX_PROMPT_BYTES, 1024 * 1024);
    assert.equal(MAX_FILE_BYTES, 512 * 1024);
    assert.equal(MAX_CAPTURE_BLOB_BYTES, 1024 * 1024);
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/seed.txt`, "seed\n");
      const base = await commitAll(repo, "base");
      for (let index = 0; index <= MAX_CHANGED_PATHS; index++) {
        await Deno.writeTextFile(
          `${repo}/f${String(index).padStart(3, "0")}.txt`,
          `file ${index}\n`,
        );
      }
      const head = await commitAll(repo, "many paths");
      const paths = await producer(repo).capture({ base, head });
      assert.ok(!paths.ok, "more changed paths than the bound must fail");
      if (paths.ok) assert.fail("expected rejection");
      contains(paths.error.detail, "changed-path bound");
    });

    // Three ~600 KiB files whose aggregate patch exceeds the former prompt
    // bound: the manifest stays complete, exact and small, and no aggregate
    // patch is produced at capture time.
    await withRepo(async (repo) => {
      const line = "a".repeat(99) + "\n";
      const lines = line.repeat(6000);
      for (let index = 0; index < 3; index++) {
        await Deno.writeTextFile(`${repo}/big${index}.txt`, lines);
      }
      const base = await commitAll(repo, "base");
      for (let index = 0; index < 3; index++) {
        await Deno.writeTextFile(
          `${repo}/big${index}.txt`,
          lines.split("a").join("b"),
        );
      }
      const head = await commitAll(repo, "small diffs big contents");
      const aggregatePatch = await git(repo, [
        "diff",
        "--no-renames",
        `${base}...${head}`,
      ]);
      assert.ok(
        aggregatePatch.length > MAX_PROMPT_BYTES,
        "the fixture genuinely exceeds the former aggregate prompt bound",
      );
      const capture = await producer(repo).capture({ base, head });
      if (!capture.ok) {
        assert.fail(`expected snapshot: ${capture.error.detail}`);
      }
      assert.equal(capture.value.files.length, 3);
      for (const file of capture.value.files) {
        assert.equal(file.kind, "modified");
        assert.equal(file.candidateLines, 6000);
      }
      const prompt = renderReviewPrompt(capture.value);
      assert.ok(prompt.length < MAX_PROMPT_BYTES);
      assert.equal(prompt.includes("a".repeat(99)), false);
      assert.equal(prompt.includes("b".repeat(99)), false);
    });
  },
);

Deno.test(
  "snapshot: oversized old and new blobs are inspected by the capture scan bound",
  async () => {
    const BIG = "a".repeat(700 * 1024);
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/keep.ts`, "export const a = 1;\n");
      await Deno.writeTextFile(`${repo}/old-big.txt`, BIG);
      await Deno.writeTextFile(`${repo}/deleted-big.txt`, BIG);
      const base = await commitAll(repo, "base");
      await Deno.writeTextFile(`${repo}/old-big.txt`, BIG.replace("a", "b"));
      await Deno.writeTextFile(`${repo}/new-big.txt`, BIG.replace("a", "c"));
      await Deno.remove(`${repo}/deleted-big.txt`);
      const head = await commitAll(repo, "oversized old and new blobs");
      const capture = await producer(repo).capture({ base, head });
      if (!capture.ok) {
        assert.fail(`expected snapshot: ${capture.error.detail}`);
      }
      const files = new Map(
        capture.value.files.map((file) => [file.path, file]),
      );
      assert.equal(files.get("old-big.txt")?.kind, "modified");
      assert.equal(files.get("old-big.txt")?.candidateLines, 1);
      assert.equal(files.get("new-big.txt")?.kind, "added");
      assert.equal(files.get("new-big.txt")?.candidateLines, 1);
      assert.equal(files.get("deleted-big.txt")?.kind, "deleted");
      assert.equal(files.get("deleted-big.txt")?.candidateLines, null);
      assert.ok(
        renderReviewPrompt(capture.value).length < MAX_PROMPT_BYTES,
        "700 KiB blobs never enter the prompt",
      );
    });

    // One blob above the NEW separate capture scan bound is still refused.
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/keep.ts`, "export const a = 1;\n");
      const base = await commitAll(repo, "base");
      await Deno.writeTextFile(
        `${repo}/huge.txt`,
        "x".repeat(MAX_CAPTURE_BLOB_BYTES + 1),
      );
      const head = await commitAll(repo, "over the capture scan bound");
      const capture = await producer(repo).capture({ base, head });
      assert.ok(!capture.ok, "an over-bound blob must be unavailable");
      if (capture.ok) assert.fail("expected rejection");
      contains(capture.error.detail, "capture bound");
    });
  },
);

Deno.test("snapshot: process and deadline failures fail closed", async () => {
  await withRepo(async (repo) => {
    const { base, head } = await seedTwoCommitRepo(repo);
    const timedOut = await producer(repo, {
      runtime: fakeRuntime({ outcome: "timed_out", exitCode: null }),
    }).capture({ base, head });
    assert.ok(!timedOut.ok);
    if (timedOut.ok) assert.fail("expected rejection");
    contains(timedOut.error.detail, "deadline");

    const truncated = await producer(repo, {
      runtime: fakeRuntime({ outcome: "exited", truncated: true }),
    }).capture({ base, head });
    assert.ok(!truncated.ok);
    if (truncated.ok) assert.fail("expected rejection");
    contains(truncated.error.detail, "finite output bound");

    const unsettled = await producer(repo, {
      runtime: fakeRuntime({ outcome: "exited", settled: false }),
    }).capture({ base, head });
    assert.ok(!unsettled.ok);
    if (unsettled.ok) assert.fail("expected rejection");
    contains(unsettled.error.detail, "settlement");

    const failedExit = await producer(repo, {
      runtime: fakeRuntime({ outcome: "exited", exitCode: 1 }),
    }).capture({ base, head });
    assert.ok(!failedExit.ok);
    if (failedExit.ok) assert.fail("expected rejection");
    assert.equal(failedExit.error.kind, "unavailable");

    const expired = await producer(repo, { totalDeadlineMs: 1 }).capture({
      base,
      head,
    });
    assert.ok(!expired.ok, "an elapsed operation deadline must fail closed");
  });
});

Deno.test(
  "snapshot: validation and digest binding reject tampered manifests",
  async () => {
    await withRepo(async (repo) => {
      const { base, head } = await seedTwoCommitRepo(repo);
      const capture = await producer(repo).capture({ base, head });
      if (!capture.ok) {
        assert.fail(`expected snapshot: ${capture.error.detail}`);
      }
      const snapshot = capture.value;
      assert.equal(validateReviewSnapshotV1(snapshot), null);

      const tamperedIdentity: ReviewSnapshotV1 = {
        ...snapshot,
        files: [{ ...snapshot.files[0], newBlob: "f".repeat(40) }],
      };
      assert.equal(await verifyReviewSnapshotDigest(tamperedIdentity), false);
      const tamperedLines: ReviewSnapshotV1 = {
        ...snapshot,
        files: [{ ...snapshot.files[0], candidateLines: 99 }],
      };
      assert.equal(await verifyReviewSnapshotDigest(tamperedLines), false);
      assert.equal(
        validateReviewSnapshotV1({ ...snapshot, digest: "not-a-digest" }),
        "review snapshot unavailable: the supplied snapshot value is malformed",
      );

      const modified = snapshot.files.find((file) => file.kind === "modified");
      if (modified === undefined) assert.fail("expected a modified entry");
      const cases: { name: string; needle: string; value: unknown }[] = [
        {
          name: "unsafe path",
          needle: "unsafe",
          value: {
            ...snapshot,
            files: [{ ...modified, path: "../escape.ts" }],
          },
        },
        {
          name: "duplicate path",
          needle: "malformed",
          value: { ...snapshot, files: [modified, { ...modified }] },
        },
        {
          name: "base is not merge base",
          needle: "merge base",
          value: { ...snapshot, mergeBase: asGitSha("c".repeat(40)) },
        },
        {
          name: "missing candidate line count",
          needle: "malformed",
          value: {
            ...snapshot,
            files: [{ ...modified, candidateLines: null }],
          },
        },
        {
          name: "added entry with an old blob",
          needle: "malformed",
          value: {
            ...snapshot,
            files: [{
              path: "added.ts",
              kind: "added",
              oldBlob: "e".repeat(40),
              newBlob: "f".repeat(40),
              oldMode: "100644",
              newMode: "100644",
              candidateLines: 1,
            }],
          },
        },
        {
          name: "deleted entry with candidate content lines",
          needle: "malformed",
          value: {
            ...snapshot,
            files: [{
              path: "gone.ts",
              kind: "deleted",
              oldBlob: "d".repeat(40),
              newBlob: ZERO_SHA,
              oldMode: "100644",
              newMode: ZERO_MODE,
              candidateLines: 3,
            }],
          },
        },
        {
          name: "modified entry with a zero blob",
          needle: "malformed",
          value: {
            ...snapshot,
            files: [{ ...modified, newBlob: ZERO_SHA }],
          },
        },
        {
          name: "symlink mode",
          needle: "symlink",
          value: {
            ...snapshot,
            files: [{ ...modified, newMode: "120000" }],
          },
        },
        {
          name: "submodule mode",
          needle: "submodule",
          value: {
            ...snapshot,
            files: [{ ...modified, oldMode: "160000" }],
          },
        },
      ];
      for (const item of cases) {
        contains(
          validateReviewSnapshotV1(item.value) ?? "",
          item.needle,
          item.name,
        );
      }
    });
  },
);

Deno.test(
  "snapshot: diff.ignoreSubmodules=all cannot hide a gitlink change",
  async () => {
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/account.ts`, "export const a = 1;\n");
      const base = await commitAll(repo, "base");
      // Mutable repository-local configuration attempts to hide gitlinks.
      await git(repo, ["config", "diff.ignoreSubmodules", "all"]);
      await Deno.writeTextFile(`${repo}/account.ts`, "export const a = 2;\n");
      await Deno.writeTextFile(`${repo}/extra.ts`, "export const b = 1;\n");
      await git(repo, ["add", "-A"]);
      await git(repo, [
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${base},vendor`,
      ]);
      const head = await commitIndex(repo, "mixed regular file and gitlink");
      const capture = await producer(repo).capture({ base, head });
      assert.ok(!capture.ok, "an ignored gitlink change must be unavailable");
      if (capture.ok) assert.fail("expected rejection");
      assert.equal(capture.error.kind, "unavailable");
      contains(capture.error.detail, "submodule");
    });
  },
);

Deno.test(
  "snapshot: forced-text attributes cannot hide deleted or replaced binaries",
  async () => {
    // NUL-carrying but UTF-8-valid bytes: once the textual-diff attribute
    // disables the numstat heuristic, only the exact blob inspection rejects
    // this content.
    const BINARY = new Uint8Array([0x61, 0x00, 0x62, 0x0a]);

    // A deleted old binary blob forced to a textual diff by `.gitattributes`.
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/.gitattributes`, "*.bin diff\n");
      await Deno.writeTextFile(`${repo}/keep.ts`, "export const a = 1;\n");
      await Deno.writeFile(`${repo}/payload.bin`, BINARY);
      const base = await commitAll(repo, "base");
      await Deno.remove(`${repo}/payload.bin`);
      const head = await commitAll(repo, "delete binary");
      const forced = await git(repo, [
        "diff",
        "--numstat",
        "-z",
        "--no-renames",
        `${base}...${head}`,
      ]);
      assert.equal(
        forced.includes("-\t-"),
        false,
        "the fixture genuinely bypasses the numstat binary heuristic",
      );
      const capture = await producer(repo).capture({ base, head });
      assert.ok(
        !capture.ok,
        "a forced-text deleted binary must be unavailable",
      );
      if (capture.ok) assert.fail("expected rejection");
      assert.equal(capture.error.kind, "unavailable");
      contains(capture.error.detail, "binary");
    });

    // A replaced old binary blob forced to a textual diff by `.gitattributes`.
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/.gitattributes`, "*.bin diff\n");
      await Deno.writeTextFile(`${repo}/keep.ts`, "export const a = 1;\n");
      await Deno.writeFile(`${repo}/payload.bin`, BINARY);
      const base = await commitAll(repo, "base");
      await Deno.writeTextFile(
        `${repo}/payload.bin`,
        "export const replaced = 1;\n",
      );
      await Deno.writeTextFile(`${repo}/keep.ts`, "export const a = 2;\n");
      const head = await commitAll(repo, "replace binary");
      const forced = await git(repo, [
        "diff",
        "--numstat",
        "-z",
        "--no-renames",
        `${base}...${head}`,
      ]);
      assert.equal(
        forced.includes("-\t-"),
        false,
        "the fixture genuinely bypasses the numstat binary heuristic",
      );
      const capture = await producer(repo).capture({ base, head });
      assert.ok(
        !capture.ok,
        "a forced-text replaced binary must be unavailable",
      );
      if (capture.ok) assert.fail("expected rejection");
      contains(capture.error.detail, "binary");
    });
  },
);

Deno.test(
  "snapshot: a missing promisor blob is never lazily fetched",
  async () => {
    const source = await Deno.makeTempDir({
      prefix: ".review-snapshot-src-",
      dir: testsDir,
    });
    const partial = await Deno.makeTempDir({
      prefix: ".review-snapshot-partial-",
      dir: testsDir,
    });
    try {
      await git(source, ["init", "-q"]);
      await git(source, [
        "config",
        "user.email",
        "sentinel-test@example.invalid",
      ]);
      await git(source, ["config", "user.name", "Sentinel Test"]);
      await git(source, ["config", "uploadpack.allowFilter", "true"]);
      await Deno.writeTextFile(`${source}/account.ts`, "export const a = 1;\n");
      const base = await commitAll(source, "base");
      await Deno.writeTextFile(`${source}/account.ts`, "export const a = 2;\n");
      await Deno.writeTextFile(`${source}/added.ts`, "export const b = 2;\n");
      const head = await commitAll(source, "head");
      const blob = (await git(source, ["rev-parse", `${head}:account.ts`]))
        .trim();
      await git(partial, [
        "clone",
        "-q",
        "--filter=blob:none",
        "--no-checkout",
        `file://${source}`,
        ".",
      ]);
      assert.equal(
        await gitSucceeds(partial, ["cat-file", "-e", blob]),
        false,
        "the fixture must not contain the promisor blob",
      );
      const capture = await producer(partial).capture({ base, head });
      assert.ok(!capture.ok, "a missing promisor object must fail closed");
      if (capture.ok) assert.fail("expected rejection");
      assert.equal(capture.error.kind, "unavailable");
      assert.equal(
        await gitSucceeds(partial, ["cat-file", "-e", blob]),
        false,
        "no lazy fetch may materialize the missing blob",
      );
    } finally {
      await Deno.remove(source, { recursive: true }).catch(() => {});
      await Deno.remove(partial, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "snapshot: trusted child controls disable lazy fetch, protocols and helpers",
  async () => {
    await withRepo(async (repo) => {
      const { base, head } = await seedTwoCommitRepo(repo);
      const calls: ReplayCommandInputV1[] = [];
      const recording: ReplayRuntimeV1 = {
        run: (input) => {
          calls.push(input);
          return Promise.resolve({
            outcome: "spawn_failed",
            exitCode: null,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
            truncated: false,
            settled: true,
            detail: "recorded",
          });
        },
      };
      const capture = await producer(repo, { runtime: recording }).capture({
        base,
        head,
      });
      assert.ok(!capture.ok, "a spawn failure must fail closed");
      assert.ok(
        calls.length >= 1,
        "at least one trusted Git read was attempted",
      );
      for (const call of calls) {
        assert.equal(call.env.GIT_NO_LAZY_FETCH, "1");
        assert.equal(call.env.GIT_ALLOW_PROTOCOL, "");
        assert.equal(call.env.GIT_TERMINAL_PROMPT, "0");
        let clearedHelper = false;
        for (let index = 0; index + 1 < call.args.length; index++) {
          if (
            call.args[index] === "-c" &&
            call.args[index + 1] === "credential.helper="
          ) {
            clearedHelper = true;
          }
        }
        assert.ok(clearedHelper, "the fixed argv clears credential.helper");
      }
    });
  },
);

// ---------------------------------------------------------------------------
// M14: bounded validation before candidate preservation
// ---------------------------------------------------------------------------

/** Exact publication validation input; protected paths default to none. */
function publicationInput(
  base: GitSha,
  head: GitSha,
  overrides: {
    publishedHead?: GitSha | null;
    protectedPaths?: readonly string[];
  } = {},
): {
  base: GitSha;
  head: GitSha;
  publishedHead: GitSha | null;
  protectedPaths: readonly string[];
} {
  return {
    base,
    head,
    publishedHead: overrides.publishedHead ?? null,
    protectedPaths: overrides.protectedPaths ?? [],
  };
}

/** Base commit with one protected subtree and one public file. */
async function seedProtectedRepo(repo: string): Promise<GitSha> {
  await Deno.mkdir(`${repo}/protected`, { recursive: true });
  await Deno.writeTextFile(`${repo}/protected/keep.txt`, "keep v1\n");
  await Deno.writeTextFile(`${repo}/protected/sibling.txt`, "sibling v1\n");
  await Deno.writeTextFile(`${repo}/public.txt`, "public v1\n");
  return await commitAll(repo, "base");
}

Deno.test(
  "publication: an ordinary clean candidate passes the negative check",
  async () => {
    await withRepo(async (repo) => {
      const base = await seedProtectedRepo(repo);
      await Deno.writeTextFile(`${repo}/public.txt`, "public v2\n");
      await Deno.writeTextFile(`${repo}/added.txt`, "added v1\n");
      const head = await commitAll(repo, "candidate change");

      const clean = await producer(repo).validatePublication(
        publicationInput(base, head, { protectedPaths: ["protected/"] }),
      );
      assert.ok(clean.ok, clean.ok ? "" : clean.error.detail);
      if (!clean.ok) assert.fail("expected a clean candidate to pass");
      assert.equal(clean.value, undefined);

      const unprotected = await producer(repo).validatePublication(
        publicationInput(base, head),
      );
      assert.ok(
        unprotected.ok,
        unprotected.ok ? "" : unprotected.error.detail,
      );

      const stale = await producer(repo).validatePublication(
        publicationInput(head, base),
      );
      assert.ok(!stale.ok, "a nonintegrated base must reject");
      if (stale.ok) assert.fail("expected rejection");
      contains(stale.error.detail, "ancestor");

      const unchanged = await producer(repo).validatePublication(
        publicationInput(base, base),
      );
      assert.ok(!unchanged.ok, "an unchanged head must reject");
      if (unchanged.ok) assert.fail("expected rejection");
      contains(unchanged.error.detail, "no new commit");
    });
  },
);

Deno.test(
  "publication: a secret-shaped intermediate blob is never hidden",
  async () => {
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/seed.txt`, "seed\n");
      const base = await commitAll(repo, "base");
      await Deno.writeTextFile(
        `${repo}/token.txt`,
        `token ghp_${"A".repeat(30)}\n`,
      );
      await commitAll(repo, "add secret-shaped material");
      await Deno.remove(`${repo}/token.txt`);
      const head = await commitAll(repo, "remove it again");

      const result = await producer(repo).validatePublication(
        publicationInput(base, head),
      );
      assert.ok(!result.ok, "an intermediate secret-shaped blob must reject");
      if (result.ok) assert.fail("expected rejection");
      contains(result.error.detail, "secret-shaped");
    });
  },
);

Deno.test(
  "publication: issue-closing commit metadata rejects every ordinary form",
  async () => {
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/seed.txt`, "seed 0\n");
      const base = await commitAll(repo, "base");
      const forms = [
        "fix #12",
        "fixes: #34",
        "Fixes owner/repo#56",
        "closed: https://github.com/owner/repo/issues/78",
        "resolved https://github.com/owner/repo/issues/90",
      ];
      for (let index = 0; index < forms.length; index++) {
        // Each form is one fresh candidate commit on top of the base, so the
        // newly exposed set under test is exactly that commit.
        await git(repo, ["checkout", "-q", "-B", `form-${index}`, base]);
        await Deno.writeTextFile(`${repo}/seed.txt`, `seed ${index + 1}\n`);
        const form = forms[index];
        const head = await commitAll(repo, form);
        const result = await producer(repo).validatePublication(
          publicationInput(base, head),
        );
        assert.ok(!result.ok, `issue-closing metadata must reject: ${form}`);
        if (result.ok) assert.fail("expected rejection");
        contains(result.error.detail, "issue-closing");
      }
    });
  },
);

Deno.test(
  "publication: protected candidate edits, removals, mode/type and ancestor blocks reject",
  async () => {
    // A protected edit inside a protected subtree.
    await withRepo(async (repo) => {
      const base = await seedProtectedRepo(repo);
      await Deno.writeTextFile(`${repo}/protected/keep.txt`, "keep v2\n");
      const head = await commitAll(repo, "edit protected");
      const result = await producer(repo).validatePublication(
        publicationInput(base, head, { protectedPaths: ["protected/"] }),
      );
      assert.ok(!result.ok, "a protected edit must reject");
      if (result.ok) assert.fail("expected rejection");
      contains(result.error.detail, "protected");
    });

    // A protected removal.
    await withRepo(async (repo) => {
      const base = await seedProtectedRepo(repo);
      await Deno.remove(`${repo}/protected/keep.txt`);
      const head = await commitAll(repo, "remove protected");
      const result = await producer(repo).validatePublication(
        publicationInput(base, head, {
          protectedPaths: ["protected/keep.txt"],
        }),
      );
      assert.ok(!result.ok, "a protected removal must reject");
      if (result.ok) assert.fail("expected rejection");
      contains(result.error.detail, "protected");
    });

    // A protected mode change with the content preserved.
    await withRepo(async (repo) => {
      const base = await seedProtectedRepo(repo);
      await git(repo, ["add", "-A"]);
      await git(repo, ["update-index", "--chmod=+x", "protected/keep.txt"]);
      const head = await commitIndex(repo, "mode change");
      const result = await producer(repo).validatePublication(
        publicationInput(base, head, {
          protectedPaths: ["protected/keep.txt"],
        }),
      );
      assert.ok(!result.ok, "a protected mode change must reject");
      if (result.ok) assert.fail("expected rejection");
      contains(result.error.detail, "protected");
    });

    // A protected type change to a symlink.
    await withRepo(async (repo) => {
      const base = await seedProtectedRepo(repo);
      await Deno.remove(`${repo}/protected/keep.txt`);
      const linked = await new Deno.Command("ln", {
        args: ["-s", "../public.txt", `${repo}/protected/keep.txt`],
        cwd: repo,
        clearEnv: true,
        env: { PATH },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert.equal(linked.code, 0, "ln -s must create the symlink");
      const head = await commitAll(repo, "symlink protected");
      const result = await producer(repo).validatePublication(
        publicationInput(base, head, {
          protectedPaths: ["protected/keep.txt"],
        }),
      );
      assert.ok(!result.ok, "a protected type change must reject");
      if (result.ok) assert.fail("expected rejection");
    });

    // An ancestor-blocking change: the protected path no longer resolves.
    await withRepo(async (repo) => {
      const base = await seedProtectedRepo(repo);
      await Deno.remove(`${repo}/protected`, { recursive: true });
      await Deno.writeTextFile(`${repo}/protected`, "not a directory\n");
      const head = await commitAll(repo, "block protected ancestor");
      const result = await producer(repo).validatePublication(
        publicationInput(base, head, {
          protectedPaths: ["protected/keep.txt"],
        }),
      );
      assert.ok(!result.ok, "a blocked protected ancestor must reject");
      if (result.ok) assert.fail("expected rejection");
      contains(result.error.detail, "protected");
    });

    // An allowed sibling change next to an exactly protected entry passes:
    // the ancestor tree SHA changes while the protected entry does not.
    await withRepo(async (repo) => {
      const base = await seedProtectedRepo(repo);
      await Deno.writeTextFile(`${repo}/protected/sibling.txt`, "sibling v2\n");
      const head = await commitAll(repo, "allowed sibling");
      const result = await producer(repo).validatePublication(
        publicationInput(base, head, {
          protectedPaths: ["protected/keep.txt"],
        }),
      );
      assert.ok(result.ok, result.ok ? "" : result.error.detail);
    });
  },
);

Deno.test(
  "publication: a replaced protected ancestor is not hidden by an empty leaf diff",
  async () => {
    await withRepo(async (repo) => {
      await Deno.mkdir(`${repo}/dir`, { recursive: true });
      await Deno.writeTextFile(`${repo}/dir/other.txt`, "other v1\n");
      const base = await commitAll(repo, "base with a protected ancestor");
      // The exact protected `dir/missing.txt` is absent in both trees, so a
      // leaf-filtered diff for it is empty; the ancestor `dir` changes from a
      // directory tree to a regular file and must still fail closed.
      await Deno.remove(`${repo}/dir`, { recursive: true });
      await Deno.writeTextFile(`${repo}/dir`, "not a directory\n");
      const head = await commitAll(repo, "replace protected ancestor");

      const result = await producer(repo).validatePublication(
        publicationInput(base, head, { protectedPaths: ["dir/missing.txt"] }),
      );
      assert.ok(!result.ok, "a replaced protected ancestor must reject");
      if (result.ok) assert.fail("expected rejection");
      contains(result.error.detail, "protected");
    });
  },
);

Deno.test(
  "publication: an explicit empty protected subtree entry is not hidden by an empty leaf diff",
  async () => {
    await withRepo(async (repo) => {
      const base = await seedProtectedRepo(repo);
      // Rebuild the protected subtree with one added explicit empty tree
      // entry: no leaf path changes, but the protected subtree object SHA
      // does, so the protected entry no longer matches the trusted base.
      const emptyTree = (await gitWithInput(repo, ["mktree"], "")).trim();
      const protectedEntries = await git(repo, [
        "ls-tree",
        `${base}:protected`,
      ]);
      const rewrittenProtected = (await gitWithInput(
        repo,
        ["mktree"],
        `${protectedEntries}040000 tree ${emptyTree}\tempty\n`,
      )).trim();
      const rootEntries = (await git(repo, ["ls-tree", base]))
        .split("\n")
        .filter((line) => line !== "" && !line.endsWith("\tprotected"));
      const rootTree = (await gitWithInput(
        repo,
        ["mktree"],
        `${
          rootEntries.join("\n")
        }\n040000 tree ${rewrittenProtected}\tprotected\n`,
      )).trim();
      const head = asGitSha(
        (await git(repo, [
          "commit-tree",
          rootTree,
          "-p",
          base,
          "-m",
          "explicit empty protected tree entry",
        ])).trim(),
      );

      const result = await producer(repo).validatePublication(
        publicationInput(base, head, { protectedPaths: ["protected/"] }),
      );
      assert.ok(
        !result.ok,
        "an explicit empty protected subtree entry must reject",
      );
      if (result.ok) assert.fail("expected rejection");
      contains(result.error.detail, "protected");
    });
  },
);

Deno.test(
  "publication: a refreshed H2 with legitimate protected base changes passes",
  async () => {
    await withRepo(async (repo) => {
      const base = await seedProtectedRepo(repo);
      await git(repo, ["checkout", "-q", "-b", "candidate"]);
      await Deno.writeTextFile(`${repo}/public.txt`, "public v2\n");
      const h1 = await commitAll(repo, "candidate H1");

      await git(repo, ["checkout", "-q", "-b", "refreshed", base]);
      await Deno.writeTextFile(`${repo}/protected/keep.txt`, "keep base v2\n");
      const b1 = await commitAll(repo, "authenticated base refresh B1");

      // H2 merges the old candidate H1 with the new authenticated base B1:
      // its protected entries come from B1 even though the H1 edge changes
      // protected paths.
      const b1Tree = (await git(repo, ["rev-parse", `${b1}^{tree}`])).trim();
      const h2 = asGitSha(
        (await git(repo, [
          "commit-tree",
          b1Tree,
          "-p",
          h1,
          "-p",
          b1,
          "-m",
          "merge refreshed base",
        ])).trim(),
      );
      const refreshed = await producer(repo).validatePublication(
        publicationInput(b1, h2, {
          publishedHead: h1,
          protectedPaths: ["protected/"],
        }),
      );
      assert.ok(refreshed.ok, refreshed.ok ? "" : refreshed.error.detail);

      // The same merge keeping the old protected tree must reject: protected
      // entries have to match the authenticated base, not the old candidate.
      const h1Tree = (await git(repo, ["rev-parse", `${h1}^{tree}`])).trim();
      const stale = asGitSha(
        (await git(repo, [
          "commit-tree",
          h1Tree,
          "-p",
          h1,
          "-p",
          b1,
          "-m",
          "stale merge",
        ])).trim(),
      );
      const rejected = await producer(repo).validatePublication(
        publicationInput(b1, stale, {
          publishedHead: h1,
          protectedPaths: ["protected/"],
        }),
      );
      assert.ok(!rejected.ok, "a stale protected merge must reject");
      if (rejected.ok) assert.fail("expected rejection");
      contains(rejected.error.detail, "protected");
    });
  },
);

Deno.test(
  "publication: trusted base history is excluded from blob inspection",
  async () => {
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/seed.txt`, "seed\n");
      await Deno.writeFile(
        `${repo}/base.bin`,
        new Uint8Array([0x00, 0x01, 0x02, 0xff]),
      );
      const base = await commitAll(repo, "base with an untouched binary");
      await Deno.writeTextFile(`${repo}/seed.txt`, "seed v2\n");
      const head = await commitAll(repo, "candidate");

      const result = await producer(repo).validatePublication(
        publicationInput(base, head),
      );
      assert.ok(result.ok, result.ok ? "" : result.error.detail);
    });
  },
);

Deno.test(
  "publication: a merged unrelated root commit exposes and inspects its tree",
  async () => {
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/main.txt`, "main v1\n");
      const base = await commitAll(repo, "base");
      const initial = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]))
        .trim();

      await git(repo, ["checkout", "-q", "--orphan", "side"]);
      await git(repo, ["rm", "-rf", "."]);
      await Deno.writeTextFile(`${repo}/side.txt`, "side v1\n");
      await commitAll(repo, "orphan side root");

      await git(repo, ["checkout", "-q", initial]);
      await git(repo, [
        "merge",
        "--no-ff",
        "--allow-unrelated-histories",
        "-q",
        "-m",
        "merge side",
        "side",
      ]);
      const head = asGitSha((await git(repo, ["rev-parse", "HEAD"])).trim());

      const result = await producer(repo).validatePublication(
        publicationInput(base, head),
      );
      assert.ok(result.ok, result.ok ? "" : result.error.detail);
    });
  },
);

Deno.test(
  "publication: malformed, over-bound and unsettled reads fail closed",
  async () => {
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/seed.txt`, "seed\n");
      const base = await commitAll(repo, "base");
      await Deno.writeTextFile(`${repo}/seed.txt`, "seed 2\n");
      const head = await commitAll(repo, "head");
      const input = publicationInput(base, head);

      const timedOut = await producer(repo, {
        runtime: fakeRuntime({ outcome: "timed_out", exitCode: null }),
      }).validatePublication(input);
      assert.ok(!timedOut.ok);
      if (timedOut.ok) assert.fail("expected rejection");
      contains(timedOut.error.detail, "deadline");

      const truncated = await producer(repo, {
        runtime: fakeRuntime({ outcome: "exited", truncated: true }),
      }).validatePublication(input);
      assert.ok(!truncated.ok);
      if (truncated.ok) assert.fail("expected rejection");
      contains(truncated.error.detail, "finite output bound");

      const unsettled = await producer(repo, {
        runtime: fakeRuntime({ outcome: "exited", settled: false }),
      }).validatePublication(input);
      assert.ok(!unsettled.ok);
      if (unsettled.ok) assert.fail("expected rejection");
      contains(unsettled.error.detail, "settlement");

      const malformed = await producer(repo, {
        runtime: fakeRuntime({
          outcome: "exited",
          stdout: new TextEncoder().encode("not-a-sha\n"),
        }),
      }).validatePublication(input);
      assert.ok(!malformed.ok);
      if (malformed.ok) assert.fail("expected rejection");
      contains(malformed.error.detail, "exact commit object");

      const badSha = await producer(repo).validatePublication({
        ...input,
        base: "not-a-sha" as GitSha,
      });
      assert.ok(!badSha.ok);
      if (badSha.ok) assert.fail("expected rejection");
      contains(badSha.error.detail, "expected exact base");

      const badProtected = await producer(repo).validatePublication({
        ...input,
        protectedPaths: ["../escape"],
      });
      assert.ok(!badProtected.ok);
      if (badProtected.ok) assert.fail("expected rejection");
      contains(badProtected.error.detail, "protected paths");
    });

    // One parent edge over the changed-path bound rejects, never trims.
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/seed.txt`, "seed\n");
      const base = await commitAll(repo, "base");
      for (let index = 0; index <= MAX_CHANGED_PATHS; index++) {
        await Deno.writeTextFile(
          `${repo}/f${String(index).padStart(3, "0")}.txt`,
          `file ${index}\n`,
        );
      }
      const head = await commitAll(repo, "over bound edge");
      const result = await producer(repo).validatePublication(
        publicationInput(base, head),
      );
      assert.ok(!result.ok, "an over-bound parent edge must reject");
      if (result.ok) assert.fail("expected rejection");
      contains(result.error.detail, "structural");
    });

    // One newly exposed blob over the per-file bound rejects.
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/seed.txt`, "seed\n");
      const base = await commitAll(repo, "base");
      await Deno.writeTextFile(
        `${repo}/big.txt`,
        "b".repeat(MAX_FILE_BYTES + 1024),
      );
      const head = await commitAll(repo, "over bound blob");
      const result = await producer(repo).validatePublication(
        publicationInput(base, head),
      );
      assert.ok(!result.ok, "an over-bound blob must reject");
      if (result.ok) assert.fail("expected rejection");
      contains(result.error.detail, "finite content bound");
    });

    // More newly exposed commits than the bound reject.
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/seed.txt`, "seed\n");
      const base = await commitAll(repo, "base");
      for (let index = 0; index <= MAX_NEW_COMMITS; index++) {
        await git(repo, [
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          `empty ${index}`,
        ]);
      }
      const head = asGitSha((await git(repo, ["rev-parse", "HEAD"])).trim());
      const result = await producer(repo).validatePublication(
        publicationInput(base, head),
      );
      assert.ok(!result.ok, "an over-bound commit list must reject");
      if (result.ok) assert.fail("expected rejection");
      contains(result.error.detail, "commit bound");
    });

    // More newly exposed objects than the bound reject (scripted runtime:
    // the bounded list read retains exactly one entry past the bound).
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/seed.txt`, "seed\n");
      const base = await commitAll(repo, "base");
      await Deno.writeTextFile(`${repo}/seed.txt`, "seed 2\n");
      const head = await commitAll(repo, "head");
      const objects = Array.from(
        { length: MAX_NEW_OBJECTS + 1 },
        (_, index) => (index + 1).toString(16).padStart(40, "0"),
      );
      const scripted: ReplayRuntimeV1 = {
        run: (command) => {
          const args = command.args;
          const last = args[args.length - 1] ?? "";
          let stdout = "";
          let exitCode = 0;
          if (args.includes("--verify")) {
            stdout = `${last.replace(/\^\{commit\}$/, "")}\n`;
          } else if (args.includes("--objects")) {
            stdout = `${objects.join("\n")}\n`;
          } else if (args.includes("rev-list")) {
            stdout = `${head}\n`;
          } else if (!args.includes("merge-base")) {
            exitCode = 1;
          }
          const result: ReplayCommandResultV1 = {
            outcome: "exited",
            exitCode,
            stdout: new TextEncoder().encode(stdout),
            stderr: new Uint8Array(),
            truncated: false,
            settled: true,
            detail: "scripted",
          };
          return Promise.resolve(result);
        },
      };
      const result = await producer(repo, { runtime: scripted })
        .validatePublication(publicationInput(base, head));
      assert.ok(!result.ok, "an over-bound object list must reject");
      if (result.ok) assert.fail("expected rejection");
      contains(result.error.detail, "object bound");
    });
  },
);

Deno.test(
  "publication: a protected tree record without a terminal NUL rejects",
  async () => {
    await withRepo(async (repo) => {
      const base = await seedProtectedRepo(repo);
      await Deno.writeTextFile(`${repo}/public.txt`, "public v2");
      const head = await commitAll(repo, "public change");

      // Dropping only the required trailing NUL leaves one successful,
      // unterminated record: the fail-closed parser must reject it.
      const runtimeModule = await import("../../src/replay/runtime.ts");
      const real = new runtimeModule.DenoReplayRuntime(PATH);
      const withoutTerminalNul: ReplayRuntimeV1 = {
        run: async (command) => {
          const result = await real.run(command);
          if (!command.args.includes("ls-tree")) return result;
          if (!command.args.includes("-z")) return result;
          if (result.outcome !== "exited") return result;
          if (result.exitCode !== 0) return result;
          if (result.truncated || !result.settled) return result;
          if (result.stdout.length === 0) return result;
          if (result.stdout[result.stdout.length - 1] !== 0) return result;
          return { ...result, stdout: result.stdout.slice(0, -1) };
        },
      };

      const result = await producer(repo, { runtime: withoutTerminalNul })
        .validatePublication(
          publicationInput(base, head, { protectedPaths: ["protected/"] }),
        );
      assert.ok(!result.ok, "an unterminated protected record must reject");
      if (result.ok) assert.fail("expected rejection");
    });
  },
);
