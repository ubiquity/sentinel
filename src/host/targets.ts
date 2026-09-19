/**
 * The committed target-repository setting.
 *
 * `sentinel.targets.json` is the ONLY source of the repositories this
 * deployment may repair. It is a plain array of `owner/name` slugs and nothing
 * else: per-repository conventions (commands, protected paths, session bounds,
 * live-start limits) come from the trusted template, and the base branch of a
 * target is that repository's own default branch, read from GitHub — never a
 * value in the file and never a hard-coded constant here.
 *
 * The file is a protected path: a model worker may not edit it. If it is
 * absent, empty, malformed, over the bound or duplicated, the deployment has
 * NO targets and repairs nothing. There is no built-in fallback repository, so
 * an unusable setting can never silently restore the previously welded target.
 *
 * This module is pure apart from the two injected capabilities (file read and
 * default-branch resolution), so every rejection is testable without network.
 */

import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { HttpTransportV1 } from "../github/http.ts";

/** Exact committed setting file name, relative to the runtime checkout root. */
export const TARGETS_FILE_NAME = "sentinel.targets.json";

/** Bounded target count: one exclusive writer, no unbounded fan-out. */
export const TARGETS_MAX = 32;

/** Static settings failure shared by every rejection path. */
export const STATIC_TARGETS_INVALID =
  "committed target setting is not a valid repository slug array";

/**
 * The setting authorizes nothing, so the deployment may repair nothing. This is
 * a refusal, never a quiet idle: an absent, empty or unusable setting must be
 * visible instead of looking like "no work today".
 */
export const STATIC_TARGETS_EMPTY =
  "committed target setting lists no repository";

/**
 * The setting does not include the repository this host addresses. The
 * composed GitHub port, candidate restorer and release path each own exactly
 * one repository, so running would act on a repository the setting does not
 * authorize. Refuse instead.
 */
export const STATIC_TARGETS_UNSUPPORTED =
  "committed target setting does not include the repository this host addresses";

const SLUG =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** One validated slug. Always the exact text from the committed file. */
export interface TargetSlugV1 {
  readonly slug: string;
  readonly owner: string;
  readonly name: string;
}

/**
 * Validate the committed array. Throws the static settings error for anything
 * that is not a bounded, duplicate-free array of `owner/name` slugs.
 */
export function parseTargetSlugsV1(input: unknown): TargetSlugV1[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError(STATIC_TARGETS_INVALID);
  }
  if (input.length > TARGETS_MAX) throw new TypeError(STATIC_TARGETS_INVALID);
  const seen = new Set<string>();
  const targets: TargetSlugV1[] = [];
  for (const item of input) {
    if (typeof item !== "string" || !SLUG.test(item)) {
      throw new TypeError(STATIC_TARGETS_INVALID);
    }
    const slash = item.indexOf("/");
    const owner = item.slice(0, slash);
    const name = item.slice(slash + 1);
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    if (seen.has(key)) throw new TypeError(STATIC_TARGETS_INVALID);
    seen.add(key);
    targets.push({ slug: item, owner, name });
  }
  return targets;
}

/** Read and validate the committed setting. Any failure yields no targets. */
export async function readTargetSlugsV1(options: {
  readonly root?: string;
  readonly readFile?: (path: string) => Promise<string>;
} = {}): Promise<TargetSlugV1[]> {
  const root = options.root ?? ".";
  const path = `${root}/${TARGETS_FILE_NAME}`;
  const readFile = options.readFile ??
    ((file: string) => Deno.readTextFile(file));
  let text: string;
  try {
    text = await readFile(path);
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  try {
    return parseTargetSlugsV1(parsed);
  } catch {
    return [];
  }
}

/**
 * Resolve one repository's default branch through the trusted GitHub API. The
 * caller supplies the authenticated transport; a non-200, unparsable or empty
 * answer is `null` and the target is then skipped rather than guessed.
 */
export function createDefaultBranchResolver(options: {
  readonly http: HttpTransportV1;
  readonly token: string;
  readonly apiBaseUrl?: string;
}): (target: TargetSlugV1) => Promise<string | null> {
  const base = options.apiBaseUrl ?? "https://api.github.com";
  return async (target) => {
    let response;
    try {
      response = await options.http({
        method: "GET",
        url: `${base}/repos/${target.owner}/${target.name}`,
        headers: new Map([
          ["authorization", `Bearer ${options.token}`],
          ["accept", "application/vnd.github+json"],
          ["x-github-api-version", "2022-11-28"],
        ]),
        body: null,
      });
    } catch {
      return null;
    }
    if (response.status !== 200) return null;
    try {
      const parsed = JSON.parse(response.bodyText) as {
        default_branch?: unknown;
      };
      const branch = parsed.default_branch;
      if (typeof branch !== "string" || branch.trim() === "") return null;
      return branch;
    } catch {
      return null;
    }
  };
}

/**
 * Build the trusted configuration of one target from the deployment template:
 * everything except identity and base branch is the template's, so a slug can
 * never introduce a command, protected-path list or limit of its own.
 */
export function createTargetConfigV1(
  template: RepositoryConfigV1,
  target: TargetSlugV1,
  defaultBranch: string,
): RepositoryConfigV1 {
  const repository: RepositoryIdentityV1 = {
    owner: target.owner,
    name: target.name,
    installationId: template.repository.installationId,
  };
  return {
    ...template,
    repository,
    baseBranch: defaultBranch,
  };
}

export interface LoadTargetConfigsResultV1 {
  readonly targets: readonly TargetSlugV1[];
  readonly configs: readonly RepositoryConfigV1[];
  /** Slug of every target skipped because its default branch was unavailable. */
  readonly skipped: readonly string[];
}

/**
 * Load the committed target setting into exact configuration objects. A target
 * whose default branch cannot be read is skipped (never defaulted); an empty
 * or invalid setting yields no configs at all.
 */
export async function loadTargetConfigsV1(options: {
  readonly template: RepositoryConfigV1;
  readonly resolveDefaultBranch: (
    target: TargetSlugV1,
  ) => Promise<string | null>;
  readonly root?: string;
  readonly readFile?: (path: string) => Promise<string>;
}): Promise<LoadTargetConfigsResultV1> {
  const targets = await readTargetSlugsV1({
    root: options.root,
    readFile: options.readFile,
  });
  const configs: RepositoryConfigV1[] = [];
  const skipped: string[] = [];
  for (const target of targets) {
    const branch = await options.resolveDefaultBranch(target);
    if (branch === null) {
      skipped.push(target.slug);
      continue;
    }
    configs.push(createTargetConfigV1(options.template, target, branch));
  }
  return { targets, configs, skipped };
}
