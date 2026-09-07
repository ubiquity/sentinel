/**
 * Trusted command registry: the concrete type/shape for resolved command
 * execution. Repository configs reference commands by ID only; the registry
 * binds each ID to a concrete executable plus argv array — never a shell
 * string, never model-supplied text — with bounded runtime and output.
 * The registry is part of file/injected configuration, not an env var or CLI
 * flag, and never carries template/secret substitutions.
 */

import { asCommandId } from "./brands.ts";
import type { CommandId } from "./brands.ts";
import {
  expectArray,
  expectExactKeys,
  expectPattern,
  expectPositiveInt,
  expectRecord,
  expectString,
  expectVersion,
  fail,
  MaxItems,
  MaxText,
} from "./validation.ts";

export interface CommandSpecV1 {
  /** Executable name or absolute path; no whitespace or shell metacharacters. */
  executable: string;
  /** Exact argv elements (no shell text, no redirection/globbing). */
  args: string[];
  /** Bounded wall-clock runtime before the run is terminated. */
  maxDurationMs: number;
  /** Bounded combined output bytes retained for digests. */
  maxOutputBytes: number;
}

export interface CommandRegistryV1 {
  version: "v1";
  commands: Record<CommandId, CommandSpecV1>;
}

const ID_RE = /^[a-z][a-z0-9_]{0,63}$/;
const REGISTRY_KEYS = ["version", "commands"] as const;
const SPEC_KEYS = [
  "executable",
  "args",
  "maxDurationMs",
  "maxOutputBytes",
] as const;

export function parseCommandRegistryV1(input: unknown): CommandRegistryV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, REGISTRY_KEYS, "$");
  expectVersion(obj.version, "$.version");

  const commandsObj = expectRecord(obj.commands, "$.commands");
  const commands: Record<CommandId, CommandSpecV1> = {};
  for (const key of Object.keys(commandsObj)) {
    const id = asCommandId(
      expectPattern(
        key,
        `$.commands.${key}`,
        ID_RE,
        "invalid_pattern",
        "expected command id matching ^[a-z][a-z0-9_]{0,63}$",
        MaxText.token,
      ),
    );
    commands[id] = parseCommandSpec(commandsObj[key], `$.commands.${key}`);
  }
  return { version: "v1", commands };
}

function parseCommandSpec(input: unknown, path: string): CommandSpecV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, SPEC_KEYS, path);
  const executable = expectPattern(
    obj.executable,
    `${path}.executable`,
    /^[A-Za-z0-9._/+-]{1,256}$/,
    "invalid_pattern",
    "expected executable name/path without whitespace or shell metacharacters",
    MaxText.path,
  );
  const args = expectArray(
    obj.args,
    `${path}.args`,
    MaxItems.commandArgs,
    expectArg,
  );
  return {
    executable,
    args,
    maxDurationMs: expectPositiveInt(
      obj.maxDurationMs,
      `${path}.maxDurationMs`,
    ),
    maxOutputBytes: expectPositiveInt(
      obj.maxOutputBytes,
      `${path}.maxOutputBytes`,
    ),
  };
}

/** One argv element; control characters (including NUL) are rejected. */
function expectArg(value: unknown, path: string): string {
  const text = expectString(value, path, MaxText.arg);
  for (const ch of text) {
    const codePoint = ch.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)) {
      fail(
        path,
        "invalid_pattern",
        "expected argv element without control characters",
      );
    }
  }
  return text;
}
