/**
 * Trusted hosted release-evidence reader (fixed self scope 0).
 *
 * The hosted repair host composes this read-only capability onto its repair
 * state view so the self release path can consume the exact successful Actions
 * runtime execution instead of waiting forever for a receipt that only a local
 * supervisor can write. It performs no writes, starts no model, and every
 * failure is a bounded sanitized `unavailable`.
 */

import type { ActionsReleaseReceiptV1 } from "../contracts/actions-release.ts";
import type {
  Clock,
  GitHubCooldownGateV1,
  PortResultV1,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { GitHubApiClient } from "../github/client.ts";
import type { HttpTransportV1 } from "../github/http.ts";

/** Public GitHub REST API used by the hosted release-evidence reader. */
export const ACTIONS_RELEASE_API_BASE_URL = "https://api.github.com";

/** Exact hosted self scope: the no-App owner credential identity. */
const SELF_REPOSITORY: RepositoryIdentityV1 = {
  owner: "ubiquity",
  name: "sentinel",
  installationId: 0,
};

export interface ActionsReleaseReaderInputV1 {
  gate: GitHubCooldownGateV1;
  http: HttpTransportV1;
  token: string;
  clock: Clock;
  /** Trusted API base for tests; production uses the public API. */
  apiBaseUrl?: string;
}

/**
 * Read the strict hosted receipt for one self production request through the
 * real authenticated client (same token/http/gate/clock as every other
 * request). Never throws.
 */
export async function readActionsReleaseReceipt(
  input: ActionsReleaseReaderInputV1,
  request: ReleaseRequestV1,
): Promise<PortResultV1<ActionsReleaseReceiptV1 | null>> {
  try {
    const client = new GitHubApiClient({
      repository: { ...SELF_REPOSITORY },
      apiBaseUrl: input.apiBaseUrl ?? ACTIONS_RELEASE_API_BASE_URL,
      http: input.http,
      auth: {
        authorizationHeader: () =>
          Promise.resolve(portOk(`Bearer ${input.token}`)),
      },
      cooldownGate: input.gate,
      clock: input.clock,
    });
    return await client.readActionsRelease(request);
  } catch {
    return portError("unavailable", "hosted release evidence is unavailable");
  }
}
