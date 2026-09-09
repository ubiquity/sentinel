/**
 * Read-only GitHub Actions observer for the ai.ubq.fi gateway.
 *
 * This entrypoint is deliberately narrower than the repair and release
 * entrypoints. It reads the gateway's authenticated unresolved-incident index,
 * retains the provider's already encrypted replay captures in a private local
 * store, and emits only bounded counts. It does not receive a GitHub writer,
 * model session, state writer, replay runner or deployment capability.
 *
 * The gateway capture is AES-256-GCM ciphertext before it reaches this
 * process. The 32-byte replay key is required and validated at startup so a
 * scheduled run cannot collect evidence that it could not later authenticate
 * for replay. The key is used only for a WebCrypto capability check and is
 * never written, logged, uploaded or returned. The observer never decrypts a
 * capture and never writes plaintext evidence.
 */

import type { Clock, PortResultV1 } from "./contracts/ports.ts";
import { SystemClock } from "./contracts/ports.ts";
import {
  parseRepositoryConfigV1,
  type RepositoryConfigV1,
} from "./contracts/repository-config.ts";
import type { GatewayTransportV1 } from "./adapters/gateway/http.ts";
import { GatewayIncidentAdapter } from "./adapters/gateway/incident-adapter.ts";
import {
  type ArtifactStoreLimitsV1,
  LocalArtifactStore,
} from "./adapters/gateway/store.ts";
import { createGatewayAuthProvider } from "./host/providers.ts";

const TARGET_OWNER = "ubiquity";
const TARGET_NAME = "ai.ubq.fi";
const TARGET_BASE_URL = "https://ai.ubq.fi";
const CONFIG_PATH = "docs/config.example.json";
const AUTH_ENV = "SENTINEL_GATEWAY_AUTH_JSON";
const KEY_ENV = "SENTINEL_REPLAY_KEY_B64";
const STORE_ROOT = ".sentinel-artifacts";
const PAGE_LIMIT = 100;
const MAX_PAGES = 32;
const MAX_INCIDENTS = PAGE_LIMIT * MAX_PAGES;
const DEFAULT_LIMITS: ArtifactStoreLimitsV1 = {
  // A bounded one-run capture budget. This is intentionally smaller than the
  // hosted runner's disk allowance and is not a production retention policy.
  totalMaxBytes: 64 * 1024 * 1024,
  artifactMaxBytes: 8 * 1024 * 1024,
  retentionMaxAgeMs: 24 * 60 * 60 * 1000,
};

export interface ObserveConfigV1 {
  config: RepositoryConfigV1;
  authHeaders: Record<string, string>;
  keyBytes: Uint8Array<ArrayBuffer>;
  storeRoot: string;
  limits?: ArtifactStoreLimitsV1;
  transport?: GatewayTransportV1;
  clock?: Clock;
}

export interface ObserveResultV1 {
  status: "read_only";
  target: "ai.ubq.fi";
  pages: number;
  incidents: number;
  evidenceRecords: number;
  retainedCiphertexts: number;
  retainedCiphertextBytes: number;
}

export class ObserveConfigurationError extends Error {
  constructor(readonly code: ObserveConfigurationErrorCodeV1) {
    super(code);
    this.name = "ObserveConfigurationError";
  }
}

export type ObserveConfigurationErrorCodeV1 =
  | "observe_config_unavailable"
  | "observe_config_invalid"
  | "observe_auth_missing"
  | "observe_auth_invalid"
  | "observe_replay_key_missing"
  | "observe_replay_key_invalid"
  | "observe_store_unavailable";

/** Read and validate the checked-in target configuration. */
export async function loadObserveConfig(
  path = CONFIG_PATH,
): Promise<RepositoryConfigV1> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch {
    throw new ObserveConfigurationError("observe_config_unavailable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ObserveConfigurationError("observe_config_invalid");
  }
  let config: RepositoryConfigV1;
  try {
    config = parseRepositoryConfigV1(parsed);
  } catch {
    throw new ObserveConfigurationError("observe_config_invalid");
  }
  if (
    config.repository.owner !== TARGET_OWNER ||
    config.repository.name !== TARGET_NAME ||
    config.adapter.kind !== "gateway" ||
    config.adapter.baseUrl !== TARGET_BASE_URL
  ) {
    throw new ObserveConfigurationError("observe_config_invalid");
  }
  return config;
}

/** Parse the protected JSON header secret without exposing its contents. */
export function parseObserveAuthHeaders(value: string): Record<string, string> {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 16_384
  ) {
    throw new ObserveConfigurationError("observe_auth_missing");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ObserveConfigurationError("observe_auth_invalid");
  }
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
  ) {
    throw new ObserveConfigurationError("observe_auth_invalid");
  }
  const headers: Record<string, string> = {};
  try {
    for (const [name, headerValue] of Object.entries(parsed)) {
      if (typeof headerValue !== "string") {
        throw new ObserveConfigurationError("observe_auth_invalid");
      }
      headers[name] = headerValue;
    }
  } catch (error) {
    if (error instanceof ObserveConfigurationError) throw error;
    throw new ObserveConfigurationError("observe_auth_invalid");
  }
  if (Object.keys(headers).length === 0) {
    throw new ObserveConfigurationError("observe_auth_invalid");
  }
  return headers;
}

/** Decode exactly one 32-byte key from hex, standard base64 or base64url. */
export function parseObserveReplayKey(value: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new ObserveConfigurationError("observe_replay_key_missing");
  }
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    throw new ObserveConfigurationError("observe_replay_key_invalid");
  }
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  let decoded: string;
  try {
    decoded = atob(padded);
  } catch {
    throw new ObserveConfigurationError("observe_replay_key_invalid");
  }
  if (decoded.length !== 32) {
    throw new ObserveConfigurationError("observe_replay_key_invalid");
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}

/**
 * Run one bounded, read-only observation pass. The only writes are private
 * encrypted capture bytes and their non-plaintext manifest metadata under
 * `storeRoot`; no remote claim, issue, PR, branch, model or release write is
 * reachable from this capability set.
 */
export async function runReadOnlyObservation(
  input: ObserveConfigV1,
): Promise<PortResultV1<ObserveResultV1>> {
  const clock = input.clock ?? new SystemClock();
  const store = new LocalArtifactStore({
    root: input.storeRoot,
    limits: input.limits ?? DEFAULT_LIMITS,
  });
  const opened = await store.open();
  if (!opened.ok) {
    return {
      ok: false,
      error: { kind: "unavailable", detail: "observe store unavailable" },
    };
  }

  // Validate the key against the exact AES-GCM primitive used by the replay
  // decryptor. No plaintext or key-derived value is persisted or emitted.
  const key = input.keyBytes.slice();
  try {
    await crypto.subtle.importKey(
      "raw",
      key,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
  } catch {
    key.fill(0);
    return {
      ok: false,
      error: { kind: "invalid", detail: "observe replay key invalid" },
    };
  }
  key.fill(0);

  const auth = createGatewayAuthProvider(() => input.authHeaders);
  const transport = input.transport ?? ((url, init) => fetch(url, init));
  const adapter = new GatewayIncidentAdapter({
    config: input.config,
    transport,
    auth,
    clock,
    store,
  });

  let cursor: string | null = null;
  let pages = 0;
  let incidents = 0;
  let evidenceRecords = 0;
  for (;;) {
    pages++;
    if (pages > MAX_PAGES) {
      return {
        ok: false,
        error: {
          kind: "invalid",
          detail: "observe pagination exceeded its bound",
        },
      };
    }
    const page = await adapter.listUnresolvedIncidents(cursor, PAGE_LIMIT);
    if (!page.ok) return page;
    if (page.value.coverage.status !== "complete") {
      return {
        ok: false,
        error: {
          kind: "unavailable",
          detail: "observe discovery coverage is incomplete",
        },
      };
    }
    incidents += page.value.items.length;
    if (incidents > MAX_INCIDENTS) {
      return {
        ok: false,
        error: { kind: "invalid", detail: "observe incident bound exceeded" },
      };
    }
    for (const item of page.value.items) {
      const evidence = await adapter.readIncident(item.id);
      if (!evidence.ok) return evidence;
      if (evidence.value !== null) evidenceRecords++;
    }
    cursor = page.value.nextCursor;
    if (cursor === null) break;
  }
  const stats = await store.stats();
  if (!stats.ok) {
    return {
      ok: false,
      error: { kind: "unavailable", detail: "observe store unavailable" },
    };
  }
  return {
    ok: true,
    value: {
      status: "read_only",
      target: "ai.ubq.fi",
      pages,
      incidents,
      evidenceRecords,
      retainedCiphertexts: stats.value.count,
      retainedCiphertextBytes: stats.value.totalBytes,
    },
  };
}

async function main(): Promise<void> {
  try {
    const config = await loadObserveConfig();
    const authRaw = Deno.env.get(AUTH_ENV);
    if (authRaw === undefined) {
      throw new ObserveConfigurationError("observe_auth_missing");
    }
    const keyRaw = Deno.env.get(KEY_ENV);
    if (keyRaw === undefined) {
      throw new ObserveConfigurationError("observe_replay_key_missing");
    }
    const result = await runReadOnlyObservation({
      config,
      authHeaders: parseObserveAuthHeaders(authRaw),
      keyBytes: parseObserveReplayKey(keyRaw),
      storeRoot: STORE_ROOT,
    });
    if (!result.ok) {
      console.error(
        JSON.stringify({ status: "blocked", reason: result.error.kind }),
      );
      Deno.exit(2);
    }
    console.log(JSON.stringify(result.value));
  } catch (error) {
    const code = error instanceof ObserveConfigurationError
      ? error.code
      : "observe_config_invalid";
    console.error(JSON.stringify({ status: "blocked", reason: code }));
    Deno.exit(2);
  }
}

if (import.meta.main) await main();
