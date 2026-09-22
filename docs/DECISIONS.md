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

## Repair job and App-token expiry bounds - 2026-09-22

Bound the protected repair job at 55 minutes and the launcher child deadline at 50 minutes so checkout, setup, preparation and the child all finish inside the one-hour lifetime of the minted scoped App installation token. Keep the App identity and its private key separate; use the token exactly as minted, with no renewal configuration and no second credential. The child's own run budget ends five minutes before the launcher bound, so a started session settles and drains inside the launcher deadline instead of being killed mid-flight with a durable implementation intent. Promotion of the production supervisor ref remains a separate operation outside these bounds. The fixed candidate code and its focused tests are local only and are not deployed.
