/**
 * RepositoryConfigV1: per-repository configuration. No field may carry a
 * secret literal; credential-bearing inputs are injected by the trusted host
 * outside this record. Commands are referenced by trusted command IDs only —
 * the config never holds shell argv, and model-supplied commands are outside
 * the contract by construction.
 */

import { asCommandId } from "./brands.ts";
import type { CommandId } from "./brands.ts";
import { parseCommandRegistryV1 } from "./command-registry.ts";
import type { CommandRegistryV1 } from "./command-registry.ts";
import { expectRestrictedRef, parseRepositoryIdentity } from "./shared.ts";
import type { RepositoryIdentityV1 } from "./shared.ts";
import {
  expectArray,
  expectCommandId,
  expectCount,
  expectEnum,
  expectExactKeys,
  expectNonEmptyString,
  expectNullable,
  expectPattern,
  expectPositiveInt,
  expectRate,
  expectRecord,
  expectStringArray,
  expectVersion,
  fail,
  MaxItems,
  MaxText,
} from "./validation.ts";

export type AdapterKindV1 = "gateway" | "github";
/** Discriminated adapter variant: a GitHub host names no gateway base URL. */
export type RepositoryAdapterV1 =
  | { kind: "gateway"; baseUrl: string }
  | { kind: "github" };
export type StabilityMetricV1 =
  | "five_xx_rate"
  | "timeout_rate"
  | "stream_failure_rate";

export interface LiveStartLimitsV1 {
  /** Rolling one-hour model-start cap (required before inference is enabled). */
  perHour: number;
  /** Rolling seven-day model-start cap. */
  perSevenDays: number;
}

export interface SessionBoundV1 {
  /** Declared maximum duration of one model session, in milliseconds. */
  maxDurationMs: number;
  /** Declared maximum output characters of one model session. */
  maxOutputChars: number;
}

export interface RetentionPolicyV1 {
  /** Live evidence expiry bound, in milliseconds (owner-approved). */
  evidenceMaxAgeMs: number;
  /** Byte bound on one retained encrypted artifact (restricted storage). */
  evidenceMaxBytes: number;
}

export interface StabilityThresholdV1 {
  metric: StabilityMetricV1;
  /** Owner-approved maximum observed rate; acceptance fails above it. */
  maxRate: number;
  /**
   * Owner-approved allowed rate increase against the baseline (rate points);
   * acceptance fails when observedRate exceeds baselineRate + maxIncrease.
   */
  maxIncrease: number;
}

export interface StabilityPolicyV1 {
  /** Monitoring window for acceptance, in milliseconds. */
  windowMs: number;
  /** Sampling interval, in milliseconds. */
  sampleIntervalMs: number;
  /** Minimum samples that must be collected to count the window as covered. */
  minSamples: number;
  /** Minimum requests per sample; below this telemetry is too sparse to judge. */
  minRequests: number;
  /** Baseline window used to compare current behavior, in milliseconds. */
  baselineWindowMs: number;
  /** Minimum baseline samples; below this the baseline is unusable. */
  baselineMinSamples: number;
  thresholds: StabilityThresholdV1[];
}

export interface AcceptanceIdentityV1 {
  /** Health endpoint path under the deployment domain. */
  healthPath: string;
  /** Metrics endpoint path (5xx/timeouts/stream failures denominators). */
  metricsPath: string;
  /** Marker string that must appear in the managed body. */
  managedBodyMarker: string;
  /** Non-secret managed response headers that must match exactly. */
  managedHeaders: { name: string; value: string }[];
  /** Custom domain to verify; null when no custom domain is configured. */
  domain: string | null;
}

export interface BuildIdentifiersV1 {
  /** Deno Deploy project id; null when the repository is not deployed. */
  projectId: string | null;
  /** Health/identity identifiers used by release acceptance; null when not deployed. */
  acceptance: AcceptanceIdentityV1 | null;
}

export interface RepositoryConfigV1 {
  version: "v1";
  kind: "repository_config";
  repository: RepositoryIdentityV1;
  baseBranch: string;
  adapter: RepositoryAdapterV1;
  /** Trusted credential-free command IDs resolved by the trusted host. */
  commands: { replay: CommandId; test: CommandId };
  /** Concrete resolved command registry (file/injected config, never env/flag). */
  commandRegistry: CommandRegistryV1;
  protectedPaths: string[];
  build: BuildIdentifiersV1;
  /** Restricted storage reference to injected credentials; never a literal URL. */
  secretRef: string | null;
  /** Explicit nullable caps; null means inference is not enabled. */
  liveStartLimits: LiveStartLimitsV1 | null;
  sessionBound: SessionBoundV1 | null;
  retention: RetentionPolicyV1 | null;
  stabilityPolicy: StabilityPolicyV1 | null;
}

const REQUIREMENT_KEYS = [
  "version",
  "kind",
  "repository",
  "baseBranch",
  "adapter",
  "commands",
  "commandRegistry",
  "protectedPaths",
  "build",
  "secretRef",
  "liveStartLimits",
  "sessionBound",
  "retention",
  "stabilityPolicy",
] as const;
const COMMANDS_KEYS = ["replay", "test"] as const;
const GATEWAY_ADAPTER_KEYS = ["kind", "baseUrl"] as const;
const GITHUB_ADAPTER_KEYS = ["kind"] as const;
const BUILD_KEYS = ["projectId", "acceptance"] as const;
const ACCEPTANCE_KEYS = [
  "healthPath",
  "metricsPath",
  "managedBodyMarker",
  "managedHeaders",
  "domain",
] as const;
const HEADER_KEYS = ["name", "value"] as const;
const LIMITS_KEYS = ["perHour", "perSevenDays"] as const;
const SESSION_KEYS = ["maxDurationMs", "maxOutputChars"] as const;
const RETENTION_KEYS = ["evidenceMaxAgeMs", "evidenceMaxBytes"] as const;
const STABILITY_KEYS = [
  "windowMs",
  "sampleIntervalMs",
  "minSamples",
  "minRequests",
  "baselineWindowMs",
  "baselineMinSamples",
  "thresholds",
] as const;
const THRESHOLD_KEYS = ["metric", "maxRate", "maxIncrease"] as const;

export function parseRepositoryConfigV1(input: unknown): RepositoryConfigV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, REQUIREMENT_KEYS, "$");
  expectVersion(obj.version, "$.version");
  expectEnum(obj.kind, ["repository_config"], "$.kind");

  const repository = parseRepositoryIdentity(obj.repository, "$.repository");

  const baseBranch = expectPattern(
    obj.baseBranch,
    "$.baseBranch",
    /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,255})$/,
    "invalid_pattern",
    "expected branch name (letters/digits/._/-)",
    MaxText.branch,
  );

  const adapter = parseRepositoryAdapter(obj.adapter, "$.adapter");

  const commandsObj = expectRecord(obj.commands, "$.commands");
  expectExactKeys(commandsObj, COMMANDS_KEYS, "$.commands");
  const replay = asCommandId(
    expectCommandId(commandsObj.replay, "$.commands.replay"),
  );
  const test = asCommandId(
    expectCommandId(commandsObj.test, "$.commands.test"),
  );

  const commandRegistry = parseCommandRegistryV1(obj.commandRegistry);
  // Own-property lookup only: a configured id like "constructor" or
  // "toString" with an empty registry must never resolve to an inherited
  // Object.prototype member and silently pass for a missing command.
  if (!Object.hasOwn(commandRegistry.commands, replay)) {
    fail(
      "$.commandRegistry",
      "invalid_lifecycle",
      "configured replay command is missing from the registry",
    );
  }
  if (!Object.hasOwn(commandRegistry.commands, test)) {
    fail(
      "$.commandRegistry",
      "invalid_lifecycle",
      "configured test command is missing from the registry",
    );
  }

  const protectedPaths = expectStringArray(
    obj.protectedPaths,
    "$.protectedPaths",
    MaxItems.protectedPaths,
    MaxText.path,
  );

  const buildObj = expectRecord(obj.build, "$.build");
  expectExactKeys(buildObj, BUILD_KEYS, "$.build");
  const projectId = expectNullableNonEmptyString(
    buildObj.projectId,
    "$.build.projectId",
    MaxText.token,
  );
  const acceptance = expectNullable(
    buildObj.acceptance,
    "$.build.acceptance",
    parseAcceptance,
  );

  const secretRef = expectNullable(
    obj.secretRef,
    "$.secretRef",
    expectRestrictedRef,
  );

  const liveStartLimits = expectNullable(
    obj.liveStartLimits,
    "$.liveStartLimits",
    parseLiveStartLimits,
  );
  const sessionBound = expectNullable(
    obj.sessionBound,
    "$.sessionBound",
    parseSessionBound,
  );
  const retention = expectNullable(
    obj.retention,
    "$.retention",
    parseRetentionPolicy,
  );
  const stabilityPolicy = expectNullable(
    obj.stabilityPolicy,
    "$.stabilityPolicy",
    parseStabilityPolicy,
  );

  if (
    liveStartLimits !== null &&
    liveStartLimits.perHour > liveStartLimits.perSevenDays
  ) {
    fail(
      "$.liveStartLimits",
      "invalid_lifecycle",
      "perHour cap cannot exceed perSevenDays cap",
    );
  }

  return {
    version: "v1",
    kind: "repository_config",
    repository,
    baseBranch,
    adapter,
    commands: { replay, test },
    commandRegistry,
    protectedPaths,
    build: { projectId, acceptance },
    secretRef,
    liveStartLimits,
    sessionBound,
    retention,
    stabilityPolicy,
  };
}

/**
 * The adapter variant is discriminated and exact: the GitHub variant names no
 * gateway base address — an extra key is an unknown key, never ignored — and
 * an unknown kind falls through to the existing gateway validation, which
 * refuses it.
 */
function parseRepositoryAdapter(
  input: unknown,
  path: string,
): RepositoryAdapterV1 {
  const obj = expectRecord(input, path);
  if (obj.kind === "github") {
    expectExactKeys(obj, GITHUB_ADAPTER_KEYS, path);
    return { kind: "github" };
  }
  // Existing gateway validation order is preserved: exact keys, then kind,
  // then the base URL pattern.
  expectExactKeys(obj, GATEWAY_ADAPTER_KEYS, path);
  expectEnum(obj.kind, ["gateway"], `${path}.kind`);
  const baseUrl = expectPattern(
    obj.baseUrl,
    `${path}.baseUrl`,
    /^https?:\/\/[^ /]+(?::\d+)?(?:\/[^ ]*)?$/,
    "invalid_pattern",
    "expected http(s) base URL",
    MaxText.url,
  );
  return { kind: "gateway", baseUrl };
}

function parseAcceptance(input: unknown, path: string): AcceptanceIdentityV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, ACCEPTANCE_KEYS, path);
  const healthPath = expectPattern(
    obj.healthPath,
    `${path}.healthPath`,
    /^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,254})?$/,
    "invalid_pattern",
    "expected absolute health path",
    MaxText.path,
  );
  const metricsPath = expectPattern(
    obj.metricsPath,
    `${path}.metricsPath`,
    /^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,254})?$/,
    "invalid_pattern",
    "expected absolute metrics path",
    MaxText.path,
  );
  const managedBodyMarker = expectNonEmptyString(
    obj.managedBodyMarker,
    `${path}.managedBodyMarker`,
    MaxText.message,
  );
  const managedHeaders = expectArray(
    obj.managedHeaders,
    `${path}.managedHeaders`,
    MaxItems.managedHeaders,
    (item, itemPath) => {
      const header = expectRecord(item, itemPath);
      expectExactKeys(header, HEADER_KEYS, itemPath);
      return {
        name: expectNonEmptyString(
          header.name,
          `${itemPath}.name`,
          MaxText.headerName,
        ),
        value: expectNonEmptyString(
          header.value,
          `${itemPath}.value`,
          MaxText.headerValue,
        ),
      };
    },
  );
  const domain = expectNullableNonEmptyString(
    obj.domain,
    `${path}.domain`,
    MaxText.url,
  );
  return { healthPath, metricsPath, managedBodyMarker, managedHeaders, domain };
}

function parseLiveStartLimits(input: unknown, path: string): LiveStartLimitsV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, LIMITS_KEYS, path);
  const perHour = expectCount(obj.perHour, `${path}.perHour`);
  const perSevenDays = expectCount(obj.perSevenDays, `${path}.perSevenDays`);
  return { perHour, perSevenDays };
}

function parseSessionBound(input: unknown, path: string): SessionBoundV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, SESSION_KEYS, path);
  return {
    maxDurationMs: expectPositiveInt(
      obj.maxDurationMs,
      `${path}.maxDurationMs`,
    ),
    maxOutputChars: expectPositiveInt(
      obj.maxOutputChars,
      `${path}.maxOutputChars`,
    ),
  };
}

function parseRetentionPolicy(input: unknown, path: string): RetentionPolicyV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, RETENTION_KEYS, path);
  return {
    evidenceMaxAgeMs: expectPositiveInt(
      obj.evidenceMaxAgeMs,
      `${path}.evidenceMaxAgeMs`,
    ),
    evidenceMaxBytes: expectPositiveInt(
      obj.evidenceMaxBytes,
      `${path}.evidenceMaxBytes`,
    ),
  };
}

function parseStabilityPolicy(input: unknown, path: string): StabilityPolicyV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, STABILITY_KEYS, path);
  const windowMs = expectPositiveInt(obj.windowMs, `${path}.windowMs`);
  const sampleIntervalMs = expectPositiveInt(
    obj.sampleIntervalMs,
    `${path}.sampleIntervalMs`,
  );
  const minSamples = expectPositiveInt(obj.minSamples, `${path}.minSamples`);
  const minRequests = expectPositiveInt(
    obj.minRequests,
    `${path}.minRequests`,
  );
  const baselineWindowMs = expectPositiveInt(
    obj.baselineWindowMs,
    `${path}.baselineWindowMs`,
  );
  const baselineMinSamples = expectPositiveInt(
    obj.baselineMinSamples,
    `${path}.baselineMinSamples`,
  );
  const thresholds = expectArray(
    obj.thresholds,
    `${path}.thresholds`,
    MaxItems.thresholds,
    parseStabilityThreshold,
  );
  if (thresholds.length === 0) {
    fail(
      `${path}.thresholds`,
      "invalid_lifecycle",
      "at least one threshold is required",
    );
  }
  if (sampleIntervalMs > windowMs) {
    fail(path, "invalid_lifecycle", "sampleIntervalMs cannot exceed windowMs");
  }
  return {
    windowMs,
    sampleIntervalMs,
    minSamples,
    minRequests,
    baselineWindowMs,
    baselineMinSamples,
    thresholds,
  };
}

function parseStabilityThreshold(
  input: unknown,
  path: string,
): StabilityThresholdV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, THRESHOLD_KEYS, path);
  const metric = expectEnum(
    obj.metric,
    ["five_xx_rate", "timeout_rate", "stream_failure_rate"],
    `${path}.metric`,
  );
  const maxRate = expectRate(obj.maxRate, `${path}.maxRate`);
  const maxIncrease = expectRate(obj.maxIncrease, `${path}.maxIncrease`);
  return { metric, maxRate, maxIncrease };
}

/**
 * Global budget policy is one owner configuration across all repositories.
 * This refuses to infer a policy when configured limits conflict; per-repo
 * independent caps are never used.
 */
export type GlobalLiveStartLimitsV1 =
  | { status: "disabled" }
  | { status: "enabled"; limits: LiveStartLimitsV1 }
  | { status: "conflict"; repositories: string[] };

export function resolveGlobalLiveStartLimits(
  configs: readonly RepositoryConfigV1[],
): GlobalLiveStartLimitsV1 {
  const configured = configs.filter((c) => c.liveStartLimits !== null);
  if (configured.length === 0) return { status: "disabled" };
  const first = configured[0].liveStartLimits;
  if (first === null) return { status: "disabled" };
  const conflicting = configured.some((c) =>
    c.liveStartLimits!.perHour !== first.perHour ||
    c.liveStartLimits!.perSevenDays !== first.perSevenDays
  );
  if (conflicting) {
    return {
      status: "conflict",
      repositories: configured.map((c) =>
        `${c.repository.owner}/${c.repository.name}`
      ),
    };
  }
  return { status: "enabled", limits: first };
}

function expectNullableNonEmptyString(
  value: unknown,
  path: string,
  maxLength: number,
): string | null {
  return expectNullable(
    value,
    path,
    (v, p) => expectNonEmptyString(v, p, maxLength),
  );
}
