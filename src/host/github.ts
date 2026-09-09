/**
 * Wave C trusted GitHub host composition seam.
 *
 * One minimal, typed, side-effect-free factory that composes the existing
 * concrete m01 GitHub modules — `createGitHubPort` (`GitHubPortImpl`) and the
 * trusted `DenoGitExecutor` — from explicit caller-supplied capabilities and
 * configuration (MASTER-PLAN.md §Wave C):
 *
 * - the exact repository identity is re-parsed with the frozen
 *   `parseRepositoryIdentity` parser and the required trusted actor/reviewer
 *   inputs (trusted PR author, trusted reviewer, trusted resolution-authors
 *   allowlist) are re-validated with the frozen string validators BEFORE any
 *   instance is constructed; every rejection is a static `TypeError` that
 *   never echoes an input value;
 * - the port is constructed with the caller's GitHub REST HTTP transport,
 *   installation-token provider, durable cooldown gate, clock, narrow
 *   review-service transport and optional human-resolution verifier;
 *   credentials exist only inside the injected auth provider, never here;
 * - one `DenoGitExecutor` is built from the explicit localDir/remoteUrl/git
 *   settings and that EXACT instance is both passed into the port and
 *   returned as `git`: a trusted repair host performs its own trusted git
 *   operations against the same executor identity the port publishes
 *   through, so host-side reconciliation and port-side publication can
 *   never drift;
 * - the factory returns one `GitHubPort` plus that `GitExecutorV1`
 *   identity. The port keeps its frozen production defaults (API base,
 *   paging bounds, HTTP deadline, finding cap); no port setting is invented
 *   on this seam.
 *
 * Capability boundary: this composition seam never reads `Deno.env` or the
 * filesystem, never constructs credentials, never selects, guesses or
 * rewrites a revision, never performs a network or GitHub call and never
 * activates a workflow. It is a composition seam for a future trusted host
 * only: it publishes nothing and cannot make live activation possible.
 */

import type {
  Clock,
  GitHubCooldownGateV1,
  GitHubPort,
} from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { parseRepositoryIdentity } from "../contracts/shared.ts";
import { expectNonEmptyString, MaxText } from "../contracts/validation.ts";
import type { GitHubAuthProviderV1 } from "../github/auth.ts";
import {
  DenoGitExecutor,
  type DenoGitExecutorOptions,
  type GitExecutorV1,
} from "../github/git-executor.ts";
import type { HttpTransportV1 } from "../github/http.ts";
import { createGitHubPort } from "../github/impl.ts";
import type {
  HumanResolutionVerifierV1,
  ReviewServiceTransportV1,
} from "../github/review-service.ts";

/** Static reject texts; no input value is ever echoed. */
const ERR_REPOSITORY = "github host repository identity is invalid";
const ERR_PR_AUTHOR = "github host trusted PR author is invalid";
const ERR_REVIEWER = "github host trusted reviewer is invalid";
const ERR_RESOLUTION_AUTHORS =
  "github host trusted resolution authors are invalid";
const ERR_GIT_SETTINGS = "github host git settings are invalid";

/** Every capability the trusted host supplies to compose the GitHub port. */
export interface GitHubHostOptionsV1 {
  /**
   * Exact repository identity; re-parsed with the frozen repository parser
   * before anything is constructed.
   */
  repository: RepositoryIdentityV1;
  /** The injected GitHub REST HTTP transport. */
  http: HttpTransportV1;
  /** Installation auth provider (the credential source; never created here). */
  auth: GitHubAuthProviderV1;
  /**
   * The one durable cooldown gate every authenticated path uses: the SAME
   * instance the host injects into its token acquisition. No default gate
   * exists.
   */
  cooldownGate: GitHubCooldownGateV1;
  clock: Clock;
  /** Narrow injected review-service transport. */
  reviewService: ReviewServiceTransportV1;
  /**
   * Optional authenticated human-resolution resolver; when omitted every
   * resolved review finding keeps failing closed inside the port.
   */
  resolutionVerifier?: HumanResolutionVerifierV1;
  /** Actor login that authors Sentinel-owned PRs. */
  trustedPrAuthor: string;
  /** Expected reviewer identity (machine-verifiable review service). */
  trustedReviewer: string;
  /**
   * Humans authorized to resolve review findings (secondary constraint to the
   * resolver; an empty allowlist keeps every resolution fail-closed).
   */
  trustedResolutionAuthors: string[];
  /**
   * Explicit git settings for the ONE trusted executor: same instance is
   * passed into the port and returned as the host's executor identity.
   */
  git: DenoGitExecutorOptions;
}

/** The composed capability set a trusted repair host holds for GitHub. */
export interface GitHubHostResultV1 {
  /** The composed authenticated GitHub port (exact repository binding). */
  port: GitHubPort;
  /**
   * THE GitExecutor identity the port is constructed with (session identity,
   * not a parallel instance): host-side git reconciliation observes exactly
   * what the port publishes through.
   */
  git: GitExecutorV1;
}

/**
 * Compose one exact GitHub port plus the trusted git executor identity from
 * caller-supplied capabilities. Repository identity and the required trusted
 * actor/reviewer inputs are validated first; on any fault a static
 * `TypeError` is thrown and no transport, auth provider, gate, clock,
 * review service or git process has been touched.
 */
export function composeGitHubHost(
  options: GitHubHostOptionsV1,
): GitHubHostResultV1 {
  // 1. Exact repository identity and required trusted actor/reviewer inputs
  //    are validated BEFORE anything is constructed. Static TypeError text
  //    only; no value is ever echoed.
  let repository: RepositoryIdentityV1;
  try {
    repository = parseRepositoryIdentity(options.repository, "$");
  } catch {
    throw new TypeError(ERR_REPOSITORY);
  }
  const trustedPrAuthor = expectLogin(
    options.trustedPrAuthor,
    "trustedPrAuthor",
    ERR_PR_AUTHOR,
  );
  const trustedReviewer = expectLogin(
    options.trustedReviewer,
    "trustedReviewer",
    ERR_REVIEWER,
  );
  const trustedResolutionAuthors = expectResolutionAuthors(
    options.trustedResolutionAuthors,
  );
  if (typeof options.git !== "object" || options.git === null) {
    throw new TypeError(ERR_GIT_SETTINGS);
  }

  // 2. One concrete DenoGitExecutor from the explicit git settings. Its
  //    constructor keeps the frozen fail-closed option validation; when it
  //    rejects, no instance exists and the port is never constructed.
  const git = new DenoGitExecutor(options.git);

  // 3. The exact port over that SAME executor instance and every injected
  //    capability; the port keeps its frozen production defaults.
  const port = createGitHubPort({
    repository,
    http: options.http,
    auth: options.auth,
    cooldownGate: options.cooldownGate,
    clock: options.clock,
    git,
    reviewService: options.reviewService,
    trustedPrAuthor,
    trustedReviewer,
    trustedResolutionAuthors,
    resolutionVerifier: options.resolutionVerifier,
  });

  return { port, git };
}

/** Validate one trusted login; any fault is the given static TypeError. */
function expectLogin(value: unknown, path: string, error: string): string {
  try {
    return expectNonEmptyString(value, path, MaxText.login);
  } catch {
    throw new TypeError(error);
  }
}

/**
 * Validate the explicit resolution-authors allowlist shape: every entry must
 * be a non-empty bounded login string. No entry is dropped, trimmed or
 * deduplicated here.
 */
function expectResolutionAuthors(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(ERR_RESOLUTION_AUTHORS);
  }
  const authors: string[] = [];
  for (const author of value) {
    authors.push(
      expectLogin(author, "trustedResolutionAuthors", ERR_RESOLUTION_AUTHORS),
    );
  }
  return authors;
}
