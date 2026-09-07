/**
 * Build receipt resolver: the trusted authenticated capability that binds an
 * accepted merged Git SHA to the exact buildTransactionId and Deno revision
 * id for one ReleaseRequestV1.
 *
 * This is the ONLY accepted candidate source. Never is a revision selected by
 * list order, timestamp, or any model-provided identity. When the exact
 * receipt is absent or ambiguous the release controller waits/blocks without
 * promotion.
 *
 * The target build-receipt integration (GitHub CI receipt published per
 * request, m06/WaveC) is a later seam; until it is wired, the production
 * resolver `UnavailableBuildReceiptResolver` refuses every request, so this
 * module can never promote a build it cannot bind.
 */

import type { PortResultV1 } from "../contracts/ports.ts";
import { portError } from "../contracts/ports.ts";
import type { DeploymentIdentityV1 } from "../contracts/shared.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";

/** The exact verified receipt for one request. */
export interface BuildReceiptV1 {
  buildTransactionId: string;
  /** Exact platform identity: the accepted merged Git SHA plus Deno revision. */
  identity: DeploymentIdentityV1;
}

export type BuildReceiptLookupV1 =
  | { status: "found"; receipt: BuildReceiptV1 }
  | { status: "absent" }
  | { status: "ambiguous"; detail: string };

/**
 * Explicit constructor capability keyed by the full request: the resolver
 * returns the exact receipt FOR THAT REQUEST or nothing; a same-SHA build
 * under another transaction is never substituted.
 */
export interface BuildReceiptResolverV1 {
  resolve(
    request: ReleaseRequestV1,
  ): Promise<PortResultV1<BuildReceiptLookupV1>>;
}

/**
 * Production default until the m06/WaveC build-receipt integration is wired:
 * every request is unavailable (not absent, not ambiguous — the capability
 * itself is not installed). The controller therefore always waits/blocks
 * without promotion. The detail is static and never echoes request content.
 */
export class UnavailableBuildReceiptResolver implements BuildReceiptResolverV1 {
  resolve(): Promise<PortResultV1<BuildReceiptLookupV1>> {
    return Promise.resolve(
      portError(
        "unavailable",
        "build receipt integration is not wired",
      ),
    );
  }
}
