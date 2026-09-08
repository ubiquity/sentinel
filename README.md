# Sentinel

Standalone, budgeted repository repair and deterministic Deno release control.

The implementation is being built against the plan in
[MASTER-PLAN.md](MASTER-PLAN.md). Start with that document and [the lifecycle
tree](docs/lifecycle.txt); the current requirement-by-requirement result is in
[the implementation audit](docs/implementation-audit-2026-09-07.md), and
[the build ledger](docs/build-status.md) records exact commits and evidence.

The canonical local lane has the contracts, state and budget foundation, the
GitHub, gateway, replay, repair and release modules, and explicit trusted-host
composition seams. Local checks are credential-free. The scheduled workflows
remain fail-closed until an owner supplies and verifies the external host
capabilities, review/build receipts, target handover and release evidence
required by the plan.

No service is installed, no workflow is enabled, and no target repository is
claimed by this repository yet.
