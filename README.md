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

The public repository is [ubiquity/sentinel](https://github.com/ubiquity/sentinel).
The scheduled `sentinel-observe` workflow is a read-only evidence intake for
`https://ai.ubq.fi`: it requires protected `SENTINEL_GATEWAY_AUTH_JSON` and
`SENTINEL_REPLAY_KEY_B64` secrets, stores only the gateway's encrypted capture
bytes plus non-plaintext manifests, and uploads that bounded ciphertext store
for one day. It never receives contents-write, model, state, replay-execution
or deployment capability. The repair and release workflows remain fail-closed
until their separate activation gates are complete.

The replay key is exactly 32 bytes encoded as hexadecimal or standard/base64url
text. The gateway-auth secret is a JSON object of header names and values, for
example `{"authorization":"Bearer <protected value>"}`. Do not place either
value in the repository, an issue, a pull request, an artifact name, or logs.
