/**
 * Wave C trusted-host runner seam: one explicit typed entry into the real
 * production entrypoints through the host composition factories.
 *
 * `runComposedRepairHost(options, runOptions)` composes the trusted repair
 * host from the caller-supplied capability set (`composeRepairHost`) and then
 * invokes the actual injected `runRepairEntrypoint` with the caller's bounded
 * deadline/step limit. `runComposedReleaseHost(options)` composes the trusted
 * release host (`composeReleaseHost`) and then invokes the actual injected
 * `runReleaseEntrypoint`.
 *
 * The seam itself carries no capability: it performs no I/O of its own and
 * reads nothing outside the factories' explicit callers — never `Deno.env`,
 * the filesystem, the network, credentials, state, a model session or a
 * release/repair effect. The two factories keep their own fail-closed
 * validation and preserve the exact repair/release capability separation
 * (repair host: repair state + budget + model port, no release writer;
 * release host: read-only view + release-only writer, no model/budget).
 *
 * This module adds no environment variable, secret, CLI argument, workflow
 * activation, fallback model, revision selector, GitHub call, model call or
 * deployment. The production entrypoints keep their own static direct-
 * execution faults (`src/main.ts`, `src/release-main.ts`): importing this
 * seam never makes a direct `deno run src/main.ts` or
 * `deno run src/release-main.ts` succeed.
 */

import type { PortResultV1 } from "../contracts/ports.ts";
import type { RepairCycleOutcomeV1 } from "../repair/loop.ts";
import type { ReleaseCycleResultV1 } from "../release/controller.ts";
import type { RepairEntrypointOptionsV1 } from "../main.ts";
import { runRepairEntrypoint } from "../main.ts";
import { runReleaseEntrypoint } from "../release-main.ts";
import { composeRepairHost, type RepairHostOptionsV1 } from "./repair.ts";
import { composeReleaseHost, type ReleaseHostOptionsV1 } from "./release.ts";

/**
 * Compose the trusted repair host from the caller-supplied capabilities and
 * run one bounded repair polling pass through the actual production
 * entrypoint. The caller's deadline and step limit are passed through
 * unchanged; `runRepairEntrypoint` keeps the fixed 120-minute ceiling and the
 * 90-minute no-new-model-work cutoff.
 */
export function runComposedRepairHost(
  options: RepairHostOptionsV1,
  runOptions: RepairEntrypointOptionsV1,
): Promise<RepairCycleOutcomeV1> {
  return runRepairEntrypoint(composeRepairHost(options), runOptions);
}

/**
 * Compose the trusted release host from the caller-supplied capabilities and
 * run one bounded release controller cycle through the actual production
 * entrypoint. Without an explicitly supplied authenticated build-receipt
 * resolver the production unavailable-resolver default stays active, so the
 * controller waits and can never promote.
 */
export function runComposedReleaseHost(
  options: ReleaseHostOptionsV1,
): Promise<PortResultV1<ReleaseCycleResultV1>> {
  return runReleaseEntrypoint(composeReleaseHost(options));
}
