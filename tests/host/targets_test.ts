/**
 * Focused suite for the committed target setting (`sentinel.targets.json`).
 *
 * The setting is authority-bearing: it decides which repositories this
 * deployment may repair, so every rejection path is covered here without
 * network or state, and the shipped file itself is parsed.
 */
import assert from "node:assert/strict";

import { createLocalRepositoryConfig } from "../../src/host/local.ts";
import {
  createDefaultBranchResolver,
  createTargetConfigV1,
  loadTargetConfigsV1,
  parseTargetSlugsV1,
  readTargetSlugsV1,
  STATIC_TARGETS_INVALID,
  TARGETS_FILE_NAME,
  TARGETS_MAX,
} from "../../src/host/targets.ts";
import type { TargetSlugV1 } from "../../src/host/targets.ts";
import type { HttpRequestV1, HttpResponseV1 } from "../../src/github/http.ts";

const TEMPLATE = createLocalRepositoryConfig();

function response(status: number, body: string): HttpResponseV1 {
  return { status, headers: new Headers(), bodyText: body };
}

function slug(owner: string, name: string): TargetSlugV1 {
  return { slug: `${owner}/${name}`, owner, name };
}

Deno.test("targets: the shipped setting is a plain array naming the sentinel repo", async () => {
  const text = await Deno.readTextFile(`./${TARGETS_FILE_NAME}`);
  const parsed = JSON.parse(text) as unknown;
  assert.ok(Array.isArray(parsed), "the setting is a plain array");
  const targets = parseTargetSlugsV1(parsed);
  assert.deepEqual(targets.map((entry) => entry.slug), ["ubiquity/sentinel"]);
  assert.equal(targets[0].owner, "ubiquity");
  assert.equal(targets[0].name, "sentinel");
});

Deno.test("targets: the setting file is a protected path", () => {
  assert.ok(
    TEMPLATE.protectedPaths.includes(TARGETS_FILE_NAME),
    "a model worker must never be able to add itself a target repository",
  );
});

Deno.test("targets: only a bounded, duplicate-free slug array is accepted", () => {
  assert.deepEqual(
    parseTargetSlugsV1(["ubiquity/sentinel"]).map((entry) => entry.slug),
    ["ubiquity/sentinel"],
  );
  const rejected: unknown[] = [
    [],
    {},
    "ubiquity/sentinel",
    [""],
    ["sentinel"],
    ["/sentinel"],
    ["ubiquity/"],
    ["ubiquity/sentinel/extra"],
    ["ubiquity/sentinel", "Ubiquity/Sentinel"],
    ["ubiquity/sentinel", "ubiquity/sentinel"],
    [1],
    [null],
    Array.from(
      { length: TARGETS_MAX + 1 },
      (_unused, index) => `ubiquity/repo-${index}`,
    ),
  ];
  for (const input of rejected) {
    assert.throws(
      () => parseTargetSlugsV1(input),
      (error: unknown) =>
        error instanceof TypeError && error.message === STATIC_TARGETS_INVALID,
      `expected rejection for ${JSON.stringify(input).slice(0, 60)}`,
    );
  }
});

Deno.test("targets: an unreadable or malformed setting yields no targets", async () => {
  assert.deepEqual(
    await readTargetSlugsV1({
      readFile: () => Promise.reject(new Error("missing")),
    }),
    [],
  );
  assert.deepEqual(
    await readTargetSlugsV1({ readFile: () => Promise.resolve("{") }),
    [],
  );
  assert.deepEqual(
    await readTargetSlugsV1({ readFile: () => Promise.resolve("[]") }),
    [],
  );
  assert.deepEqual(
    await readTargetSlugsV1({
      readFile: () => Promise.resolve('["ubiquity/sentinel"]'),
    }),
    [slug("ubiquity", "sentinel")],
  );
  assert.deepEqual(
    await readTargetSlugsV1({
      root: ".",
      readFile: (path) =>
        Promise.resolve(
          path === `./${TARGETS_FILE_NAME}` ? '["ubiquity/sentinel"]' : "[]",
        ),
    }),
    [slug("ubiquity", "sentinel")],
  );
});

Deno.test("targets: a slug can only change identity and base branch", () => {
  const config = createTargetConfigV1(
    TEMPLATE,
    slug("ubiquity", "another-repo"),
    "main",
  );
  assert.deepEqual(config.repository, {
    owner: "ubiquity",
    name: "another-repo",
    installationId: TEMPLATE.repository.installationId,
  });
  assert.equal(config.baseBranch, "main");
  // Everything else stays the trusted template's value.
  assert.deepEqual(config.commands, TEMPLATE.commands);
  assert.deepEqual(config.commandRegistry, TEMPLATE.commandRegistry);
  assert.deepEqual(config.protectedPaths, TEMPLATE.protectedPaths);
  assert.deepEqual(config.sessionBound, TEMPLATE.sessionBound);
  assert.deepEqual(config.liveStartLimits, TEMPLATE.liveStartLimits);
  assert.equal(config.secretRef, TEMPLATE.secretRef);
});

Deno.test("targets: a target whose default branch is unavailable is skipped", async () => {
  const loaded = await loadTargetConfigsV1({
    template: TEMPLATE,
    readFile: () => Promise.resolve('["ubiquity/sentinel", "ubiquity/other"]'),
    resolveDefaultBranch: (target) =>
      Promise.resolve(target.name === "sentinel" ? "development" : null),
  });
  assert.deepEqual(
    loaded.configs.map((config) =>
      `${config.repository.name}@${config.baseBranch}`
    ),
    ["sentinel@development"],
  );
  assert.deepEqual([...loaded.skipped], ["ubiquity/other"]);
});

Deno.test("targets: the default branch comes from GitHub, never from the file", async () => {
  const seen: string[] = [];
  const resolve = createDefaultBranchResolver({
    http: (request: HttpRequestV1) => {
      seen.push(request.url);
      assert.equal(request.method, "GET");
      assert.equal(request.headers.get("authorization"), "Bearer token-value");
      return Promise.resolve(
        response(200, JSON.stringify({ default_branch: "trunk" })),
      );
    },
    token: "token-value",
  });
  assert.equal(await resolve(slug("ubiquity", "sentinel")), "trunk");
  assert.deepEqual(seen, ["https://api.github.com/repos/ubiquity/sentinel"]);

  const notFound = createDefaultBranchResolver({
    http: () => Promise.resolve(response(404, "{}")),
    token: "token-value",
  });
  assert.equal(await notFound(slug("ubiquity", "gone")), null);

  const garbage = createDefaultBranchResolver({
    http: () => Promise.resolve(response(200, "not json")),
    token: "token-value",
  });
  assert.equal(await garbage(slug("ubiquity", "sentinel")), null);

  const blank = createDefaultBranchResolver({
    http: () =>
      Promise.resolve(response(200, JSON.stringify({ default_branch: " " }))),
    token: "token-value",
  });
  assert.equal(await blank(slug("ubiquity", "sentinel")), null);

  const unavailable = createDefaultBranchResolver({
    http: () => Promise.reject(new Error("offline")),
    token: "token-value",
  });
  assert.equal(await unavailable(slug("ubiquity", "sentinel")), null);
});
