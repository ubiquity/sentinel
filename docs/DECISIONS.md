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

## Model route: gateway primary, DeepSeek-direct fallback - 2026-09-20

Keep the UOS gateway (`https://ai.ubq.fi/v1`, `gpt-5.6-luna`, `max` reasoning) as the primary model route. The owner authorized a DeepSeek-direct fallback on 2026-09-20 after the gateway became unreachable (HTTP 000/522), which stopped all model work even though issue-driven repair does not read incident payloads. Selection is explicit and once-per-run in `src/host/model-route.ts`: an owner override (`SENTINEL_MODEL_BASE_URL` + optional `SENTINEL_MODEL_ID`) wins when valid, then the fallback when `SENTINEL_MODEL_FALLBACK=deepseek` and `SENTINEL_DEEPSEEK_API_KEY` is non-empty, else the gateway. An invalid or incomplete value never fabricates a route. The resolved model id is the id the runtime actually submits and records, and the receipt verifier requires the requested model to equal both the port's configured model and the thread acknowledgement, so a receipt can never keep one model id while another was requested. Max reasoning stays frozen on every route. The DeepSeek key lives in the `sentinel-supervisor` environment secret as `SENTINEL_DEEPSEEK_API_KEY` and is read by name only; it is never logged. The fallback selector is the repository variable `SENTINEL_MODEL_FALLBACK`. Verified live: DeepSeek serves the Responses API at `api.deepseek.com/v1`, accepts `deepseek-flash`, executes Codex tool calls, and rejects `gpt-5.6-luna`, which is why the fallback requests its own id rather than reusing the gateway's.

## gpt-reserve model id and the Codex provider selection - 2026-09-20

Request the gateway model `gpt-reserve` with max reasoning, replacing the `gpt-5.6-luna` request. `gpt-reserve` is luna served under its own Codex model id with a genuinely separate upstream quota window; the live capacity snapshot shows it under `additional_rate_limits` with `limit_name: gpt-reserve` and a reset time distinct from the account's primary window, so exhausting it never fences the standard luna bucket. The gateway passes the id upstream verbatim and owns the `reserve` quota class for it (`ai.ubq.fi` decision recorded in that repository's `docs/DECISIONS.md`, commit `922c3339`).

The same investigation found the earlier root cause of "no model works": the gateway's provider selection omitted `codex`, so every request was routed to exhausted paid providers while both Codex subscriptions sat healthy at 0% used. The selection was restored to `["codex","surplus","openlux","deepseek","cerebras"]` on 2026-09-20; the prior value was `["surplus","openlux","deepseek","cerebras"]` and is the reversal target if that tier must be switched off again. Keep `codex` selected: it is the only tier that serves the reserve id, and the paid tiers report a negative balance and refuse with `403 insufficient_quota`.

Verified live after both changes: `gpt-5.6-luna` and `gpt-reserve` each return HTTP 200 with real output through `https://ai.ubq.fi/v1/responses`, and the installed Sentinel runtime revision `cbfa39c` (generation 27) settled healthy with `startupReady: true` while requesting `gpt-reserve`.
