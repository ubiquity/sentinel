/**
 * m01-github: GitHubPort, App installation-token access, strict GitHub REST
 * wire parsing with bounded pagination, the review-service transport boundary
 * and fail-closed review normalization.
 *
 * Exports are grouped so callers take only the capability they need: the port
 * (`createGitHubPort`), the auth provider (`GitHubInstallationTokenProvider`),
 * the git executor (`DenoGitExecutor`), the review transport contract and the
 * pure normalization helpers used to derive ReviewReceiptV1 records.
 */

export * from "./http.ts";
export * from "./auth.ts";
export * from "./git-executor.ts";
export * from "./wire.ts";
export * from "./review-service.ts";
export * from "./review-normalize.ts";
export * from "./client.ts";
export * from "./text.ts";
export * from "./impl.ts";
