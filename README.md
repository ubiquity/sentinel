# Sentinel

Sentinel repairs eligible GitHub issues and captured incidents with isolated concurrent workers, durable candidate/accounting state, current-head structured review and trusted integration/release controllers. The implementation uses Deno and TypeScript; runtime workers cannot access credential, state or promotion authority.

Start with [the current master plan](MASTER-PLAN.md), [project instructions](AGENTS.md) and [owner decisions](docs/DECISIONS.md). [The build ledger](docs/build-status.md) is the sole source of current task ownership and acceptance; [the active memory plan](docs/sentinel-memory-plan.md) covers durable attempt memory and self-healing. Historical plans and receipts remain available in Git history.

The public repository is [ubiquity/sentinel](https://github.com/ubiquity/sentinel). Hosted runs are manually dispatched from the trusted host with the installed `sentinel` CLI:

```sh
sentinel status
sentinel run observe
sentinel run supervisor
sentinel receipts <run-id>
```

Development-triggered hosted attempts need explicit approval per attempt after local preparation. See the [hosted approval boundary](AGENTS.md#hosted-approval-boundary); a documentation or source change alone does not establish runtime installation or autonomous delivery.

[Shared contracts](docs/contracts.md) define records, ports, producer/consumer wire shapes and evidence custody. [The activation checklist](docs/activation-checklist.md) preserves target ownership, current VPS release boundaries and required live proofs. [Reviewer alignment](docs/codex-review-rubric-alignment-2026-10-08.md) identifies the vendored upstream rubric and strict harness schema. [Source adaptation pins](docs/third-party-reuse.md) and [license notices](THIRD_PARTY_NOTICES.md) cover reused components.

The read-only observer for `https://ai.ubq.fi` uses protected `SENTINEL_GATEWAY_AUTH_JSON` and `SENTINEL_REPLAY_KEY_B64` capabilities. It stores bounded encrypted captures and non-plaintext manifests, with one-day artifact retention; it receives no repair, model, state-write, replay-execution or deployment capability. The replay key is exactly 32 bytes represented as hexadecimal or standard/base64url text. The gateway-auth secret is a JSON object of header names/values. Keep both values out of Git, issues, PRs, artifact names and logs.

Local validation exercises real production consumers with fake external services and no paid/model calls or deployments. Use focused named checks with the 300-second bounds in AGENTS.md; whole-repository sweeps require a separate explicit request.
