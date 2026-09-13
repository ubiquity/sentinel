/**
 * Fixed hosted supervisor bootstrap.
 *
 * This entrypoint runs only from the protected `sentinel-supervisor` source
 * ref. Its first durable operation seeds the release-state ref through the
 * installation token minted by the workflow. The repair workflow never gets
 * this token or the environment that contains the App private key.
 *
 * Release promotion remains fail-closed until the trusted Deno target,
 * build-receipt resolver and monitoring policy are wired into a later
 * supervisor revision. This bootstrap never selects a revision and never
 * writes repair state.
 */

import { parseReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { createReleaseStateStore, DenoGitRunner } from "../state/mod.ts";
import { githubGitAuthEnv, joinPath } from "./local.ts";

const REMOTE_URL = "https://github.com/ubiquity/sentinel.git";
const SUPERVISOR_TOKEN_ENV = "SENTINEL_SUPERVISOR_TOKEN";
const STATIC_TOKEN = "hosted supervisor credentials are unavailable";
const STATIC_STATE = "hosted supervisor release state is unavailable";
const STATIC_SEED = "hosted supervisor release state could not be seeded";

export interface HostedSupervisorBootstrapResultV1 {
  status: "seeded" | "already_present";
  head: string;
  sequence: number;
}

/**
 * Seed the release-state branch exactly once, then reread its authoritative
 * commit. A concurrent or lost write response is reconciled by the same
 * reread; no force push or replacement state is attempted.
 */
export async function ensureHostedReleaseStateSeed(
  token: string,
  scratchDir: string,
  now = Date.now(),
): Promise<HostedSupervisorBootstrapResultV1> {
  if (!isToken(token)) throw new Error(STATIC_TOKEN);
  if (typeof scratchDir !== "string" || scratchDir.length === 0) {
    throw new Error(STATIC_STATE);
  }
  if (!Number.isSafeInteger(now) || now < 0) throw new Error(STATIC_STATE);

  const state = createReleaseStateStore({
    scratchDir,
    remoteUrl: REMOTE_URL,
    runner: new DenoGitRunner(
      joinPath(scratchDir, "git-home"),
      githubGitAuthEnv(token),
    ),
  });
  const current = await state.readRelease();
  if (!current.ok) throw new Error(`${STATIC_STATE} (${current.error.kind})`);
  if (current.value.status === "found") {
    return {
      status: "already_present",
      head: current.value.head,
      sequence: current.value.snapshot.sequence,
    };
  }

  const seed = emptyReleaseState(now);
  const written = await state.writeRelease(seed, null);
  if (!written.ok) throw new Error(`${STATIC_SEED} (${written.error.kind})`);
  if (written.value.status === "applied") {
    const afterWrite = await state.readRelease();
    if (!afterWrite.ok || afterWrite.value.status !== "found") {
      throw new Error(STATIC_SEED);
    }
    return {
      status: "seeded",
      head: afterWrite.value.head,
      sequence: afterWrite.value.snapshot.sequence,
    };
  }

  // A competing supervisor may have created the absent ref, or the response
  // may have been lost after the App write. Only an authoritative reread can
  // settle that ambiguity; a conflict never causes a force overwrite.
  const reconciled = await state.readRelease();
  if (!reconciled.ok || reconciled.value.status !== "found") {
    throw new Error(STATIC_SEED);
  }
  return {
    status: "already_present",
    head: reconciled.value.head,
    sequence: reconciled.value.snapshot.sequence,
  };
}

function emptyReleaseState(now: number): ReleaseStateSnapshotV1 {
  return parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: now,
    releases: [],
  });
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 &&
    value.length <= 256 && !/[\p{Cc}]/u.test(value);
}

async function main(): Promise<void> {
  const token = Deno.env.get(SUPERVISOR_TOKEN_ENV);
  if (!isToken(token)) throw new Error(STATIC_TOKEN);
  const scratch = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: ".sentinel-supervisor-",
  });
  try {
    const result = await ensureHostedReleaseStateSeed(token, scratch);
    console.log(JSON.stringify(result));
  } finally {
    try {
      await Deno.remove(scratch, { recursive: true });
    } catch {
      // The runner is ephemeral; cleanup is best effort after the receipt.
    }
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (
      message === STATIC_TOKEN ||
      message === STATIC_STATE ||
      message === STATIC_SEED ||
      /^hosted supervisor release state (?:is unavailable|could not be seeded) \((?:unavailable|auth_failed|rate_limited|not_found|conflict|invalid)\)$/
        .test(
          message,
        )
    ) {
      console.error(message);
    } else {
      console.error(STATIC_SEED);
    }
    Deno.exit(1);
  }
}
