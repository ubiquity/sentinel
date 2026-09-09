/**
 * m04-repair: pure selection, bounded repair-loop transitions and the runtime
 * ImplementationPort over frozen ports plus RollingStartBudget.
 *
 * The module owns deterministic identities, the plan priority selection, the
 * bounded per-record lifecycle (work → review → delivery → done/blocked), the
 * durable model admission (RollingStartBudget) and the bounded Codex
 * app-server transport. It contains no GitHub/Deno/HTTP transport, no storage
 * alternative and no model policy: everything is injected through the frozen
 * ports.
 */

export * from "./keys.ts";
export * from "./selection.ts";
export * from "./transitions.ts";
export * from "./loop.ts";
export * from "./codex-transport.ts";
export * from "./model-port.ts";
export * from "./github-cooldown.ts";
