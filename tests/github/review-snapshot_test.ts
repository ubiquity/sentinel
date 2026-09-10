/**
 * T03: bounded trusted Git snapshot producer against REAL temporary Git
 * object repositories. No network, no model, no GitHub and no paid calls.
 */

import assert from "node:assert/strict";
import { asGitSha, type GitSha } from "../../src/contracts/brands.ts";
import {
  GitReviewSnapshot,
  isSafeReviewPath,
  MAX_CHANGED_PATHS,
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
  "snapshot: exact committed contents despite mutable checkout changes and a deletion",
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
      assert.deepEqual(
        snapshot.files.map((file) => [file.path, file.kind]),
        [
          ["README.md", "deleted"],
          ["account.ts", "modified"],
          ["new.ts", "added"],
        ],
      );
      const account = snapshot.files.find((file) => file.path === "account.ts");
      assert.equal(
        account?.content,
        "export function deposit(balance: number, amount: number) {\n" +
          '  if (amount < 0) throw new Error("negative");\n' +
          "  return balance + amount;\n}\n",
      );
      const readme = snapshot.files.find((file) => file.path === "README.md");
      assert.equal(readme?.content, null);
      contains(snapshot.diff, "deleted file mode");
      contains(snapshot.diff, "+export const added = true;");

      // The mutable checkout moves (and even loses files) AFTER capture: the
      // immutable snapshot and its digest must not move with it.
      await Deno.writeTextFile(`${repo}/account.ts`, "export const x = 1;\n");
      await Deno.remove(`${repo}/new.ts`);
      await Deno.writeTextFile(`${repo}/untracked.ts`, "export const y = 1;\n");
      const again = await producer(repo).capture({ base, head });
      if (!again.ok) assert.fail(`expected recapture: ${again.error.detail}`);
      assert.equal(again.value.digest, snapshot.digest);
      assert.deepEqual(again.value.files, snapshot.files);
      assert.equal(again.value.diff, snapshot.diff);

      const prompt = renderReviewPrompt(snapshot);
      contains(prompt, `Base ${base}; head ${head};`);
      contains(prompt, snapshot.digest);
      contains(prompt, "===== FILE new.ts (added) =====");
      contains(prompt, "===== DELETED README.md =====");
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
    await Deno.symlink("account.ts", `${repo}/link.ts`);
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
      content: null,
    }]);
  });
});

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
  "snapshot: changed-path and aggregate prompt bounds reject overflow",
  async () => {
    assert.equal(MAX_CHANGED_PATHS, 128);
    assert.equal(MAX_PROMPT_BYTES, 1024 * 1024);
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

    await withRepo(async (repo) => {
      const line = "a".repeat(99) + "\n";
      const lines = line.repeat(4000);
      for (let index = 0; index < 3; index++) {
        await Deno.writeTextFile(`${repo}/big${index}.txt`, lines);
      }
      const base = await commitAll(repo, "base");
      for (let index = 0; index < 3; index++) {
        await Deno.writeTextFile(
          `${repo}/big${index}.txt`,
          lines.replace("a".repeat(99), "b".repeat(99)),
        );
      }
      const head = await commitAll(repo, "small diffs big contents");
      const capture = await producer(repo).capture({ base, head });
      assert.ok(!capture.ok, "an over-bound complete prompt must fail");
      if (capture.ok) assert.fail("expected rejection");
      contains(capture.error.detail, "prompt");
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
  "snapshot: validation and digest binding reject tampered snapshots",
  async () => {
    await withRepo(async (repo) => {
      const { base, head } = await seedTwoCommitRepo(repo);
      const capture = await producer(repo).capture({ base, head });
      if (!capture.ok) {
        assert.fail(`expected snapshot: ${capture.error.detail}`);
      }
      const snapshot = capture.value;
      assert.equal(validateReviewSnapshotV1(snapshot), null);
      const tampered: ReviewSnapshotV1 = {
        ...snapshot,
        diff: `${snapshot.diff}\n+injected\n`,
      };
      assert.equal(await verifyReviewSnapshotDigest(tampered), false);
      assert.equal(
        validateReviewSnapshotV1({ ...snapshot, digest: "not-a-digest" }),
        "review snapshot unavailable: the supplied snapshot value is malformed",
      );
      const unsafePath = {
        ...snapshot,
        files: [{ path: "../escape.ts", kind: "added", content: "x\n" }],
      };
      contains(
        validateReviewSnapshotV1(unsafePath) ?? "",
        "unsafe",
      );
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
    // this content (the patch itself still decodes as UTF-8 text).
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
