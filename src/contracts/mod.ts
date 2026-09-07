/**
 * Shared Sentinel v1 contracts: strict record types, fail-closed runtime
 * parsers, deterministic canonical JSON serialization, distinct identity
 * brands and the typed operational ports. Frozen before parallel module work;
 * consumers never invent their own status/digest variants.
 */

// Identity brands.
export * from "./brands.ts";
// Fail-closed validation core.
export * from "./validation.ts";
// Canonical serialization + determinism.
export * from "./canonical.ts";
// Shared fragments.
export * from "./shared.ts";
// Records.
export * from "./repository-config.ts";
export * from "./command-registry.ts";
export * from "./work-record.ts";
export * from "./incident.ts";
export * from "./review-receipt.ts";
export * from "./budget-reservation.ts";
export * from "./replay-result.ts";
export * from "./release.ts";
export * from "./state-snapshots.ts";
// Ports.
export * from "./ports.ts";
