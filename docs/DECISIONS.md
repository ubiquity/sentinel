# Sentinel Decisions

Read before changing Sentinel runtime or delivery. These are scoped user exceptions; they do not broadly override higher authority.

## Runtime and self-repair - 2026-09-14

Keep Sentinel a cron-triggered GitHub Actions job using the existing hosted supervisor, runtime model admission, and protected authority boundaries. The immediate repair target is ubiquity/sentinel, not ai.ubq.fi; gateway release choices do not block self-repair. Keep gateway acceptance separate from hosted self-repair claims. Preserve runtime receipts, admission contracts, and the historical max-reasoning requirement.

## Development location - 2026-09-14

The Mac is not authoritative and access to it is not required. Push all work to Git, fetch published refs, and use /home/codex/repos/ubiquity/sentinel on the VPS. Preserve codex/master-plan-gfa795549e5 in its matching isolated worktree.

## Development quota - 2026-09-15

Allow 120 model starts per rolling hour, without a rolling-seven-day cap, including supervised Actions runs. This replaces development's earlier 60/hour and 168/seven-day limits. Charge implementation, review, retry, and continuation starts to the shared budget; preserve historical reservations and exclusive runtime ownership. Install quota through reviewed source and verify hosted runtime, never by rewriting state to simulate capacity.

Treat the old runtime model label as superseded naming under the global model policy, not authorization to alter deployed runtime policy beyond these limits.

## Supervised early runs - 2026-09-14

During Codex development, a bounded trusted release-store operation may make the next run eligible early. The unchanged supervisor restores the hourly deadline on admission. This does not permit model/quota bypasses.

## Queue - 2026-09-15

Keep eligible work and fresh Actions dispatches moving when a stale run does not own their execution path. A stuck entry is not a global stop. Scope ownership restrictions to the operation needing them; retain Actions concurrency and shared admission limits.

## Branch protection - 2026-09-14

Never add branch protection/rulesets. Supervisor source ruleset 23197450 is recorded deleted; do not recreate it or restore the proposed temporary exception.

## Development delivery exception - 2026-09-16

No Codex development reviews or PRs: make changes, immediately test, and deliver verified changes directly. This replaces development PRs, three-round reviews, and extra-review allowances. Do not request another development review/PR. Autonomous repairs retain their PRs/reviews and runtime receipt/admission contracts.

For remaining delivery, use the global OSS-first, simplest-sufficient, and meaningful-test defaults; this exception does not waive them.

## Single GitHub App identity - 2026-09-20

Use the existing `ubiquity-sentinel` GitHub App (App id 4682172, bot login `ubiquity-sentinel[bot]`) for everything: the owner deleted the dedicated `sentinel-supervisor-ubiq-260913` App and requires one visible identity for all Sentinel activity. Every repository-visible Sentinel code change (candidate branch pushes, pull creation and merge, review publication, issue closure, CI approval) authenticates with that App's installation token; `SENTINEL_SUPERVISOR_TOKEN` carries it and its private key stays in the `sentinel-supervisor` environment secret. Durable state refs (`sentinel-state/repair`, `sentinel-state/release`) keep the native Actions token so their writer identity and ruleset bypass stay unchanged. The launcher and the maintenance pass accept exactly `github-actions[bot]` and `ubiquity-sentinel[bot]` while installed runtime revisions transition; that dual acceptance is a scoped transition rule to be narrowed to the App login once an App-authenticated child settles healthy. The App needs repository permissions contents/pull-requests/issues write plus checks/statuses read, and its installation must remain selected across every repository in `sentinel.targets.json`; the permission grant is owner-performed in the App settings UI because GitHub exposes no API to change an app's permissions.
