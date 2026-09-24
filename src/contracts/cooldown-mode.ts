/**
 * Durable-cooldown enforcement mode.
 *
 * `enforce` is the production default: a recorded hold blocks every
 * authenticated request, and a gate that cannot prove the absence of a hold
 * refuses for a bounded window instead of gating the request open.
 *
 * `off` is the explicit development switch: the gates become pass-throughs and
 * neither read nor write a hold, so development can never be frozen by
 * cooldown bookkeeping. The mode is injected into a gate, never read from the
 * environment inside one, and an absent or empty setting always enforces.
 */

export type CooldownModeV1 = "enforce" | "off";

/** The one environment name the mode is injected under. */
export const COOLDOWN_MODE_ENV = "SENTINEL_COOLDOWN_MODE";

/** Production default: an absent or empty setting enforces. */
export const DEFAULT_COOLDOWN_MODE: CooldownModeV1 = "enforce";

/**
 * Strict parse of one injected value. Absent or empty keeps the production
 * default, a recognised value is returned unchanged, and every other value is
 * rejected so a typo can never silently disable the protection.
 */
export function parseCooldownModeV1(value: unknown): CooldownModeV1 {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_COOLDOWN_MODE;
  }
  if (value === "enforce" || value === "off") return value;
  throw new TypeError("cooldown mode must be enforce or off");
}
