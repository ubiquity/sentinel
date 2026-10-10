# Sentinel decisions

These are current owner decisions for Sentinel. [AGENTS.md](../AGENTS.md) governs execution, [MASTER-PLAN.md](../MASTER-PLAN.md) defines scope and invariants, and [build-status.md](build-status.md) records current ownership and acceptance. Superseded choices, task-specific exceptions and consumed permissions remain in Git history; they grant no fresh hosted approval.

## Runtime and dispatch

Sentinel runs in GitHub Actions. Per the owner directive of 2026-10-07 (commit `5aac94da8`, "Make it fully autonomous"), `supervisor-dispatch.yml` runs every five minutes and dispatches the exact protected `sentinel-supervisor` ref; `observe.yml` and `repair.yml` stay manual-only, and `sentinel-release` remains disabled. The installed trusted-host CLI stays available for explicit dispatch: `sentinel status`, `sentinel run observe`, `sentinel run supervisor`, and `sentinel receipts <run-id>`. The supervisor uses the exact protected `sentinel-supervisor` ref and authenticated execution receipts; neither time nor list order selects a runtime.

Every development-triggered hosted end-to-end/runtime/supervisor dispatch, retry or rerun needs explicit user approval for that identified attempt after local preparation; earlier activation/recovery permissions do not authorize this task's next attempt. The scheduled autonomous dispatcher and the runtime's own retries are runtime behavior, not development-triggered attempts.

## Concurrent issue processing

Use isolated concurrent issue workers across configured targets, one trusted state/integration coordinator and exclusive serialized merge/promotion ownership. Artificial hourly/weekly model-start, unfinished-PR, concurrent-review, review-drain and ordinary hourly-delay caps are lifted. GitHub/provider capacity and configured session/deadline safeguards still apply.

The trusted start-limit policy is `liveStartLimits: { perHour: null, perSevenDays: null }`; a wholly null or invalid policy does not enable inference. Preserve unique task/admission identity, durable reservations and ambiguous/submitted history, source freshness, exact-head semantic review/CI and credential/state separation. No manual quota or state rewriting is authorized.

Matrix planning reserves the existing five-minute operation margin for native job handoff. Stop reading further candidates when a full configured session and completion margin no longer fit. Preserve the shared execution start/deadline and cell-side refusal; planner throughput is not permission to shorten safeguards.

## Runtime model policy and trusted route configuration

Preserve the runtime implementation policy `gpt-5.6-luna` with max reasoning. Local coding-agent routing or a task-scoped worker model does not change production routing.

The trusted route configuration in [src/host/model-route.ts](../src/host/model-route.ts) also supports the gateway alias `gpt-reserve`, explicit `SENTINEL_MODEL_BASE_URL`/`SENTINEL_MODEL_ID` configuration and the previously owner-authorized DeepSeek-direct route selected by `SENTINEL_MODEL_FALLBACK=deepseek` with the existing scoped key. Those interfaces are retained; this consolidation neither selects a route nor asserts which route is live. Reconcile the approved policy and actual installed configuration before a future route change. Invalid/incomplete configuration refuses, and receipts bind the submitted model/provider to actual thread/turn/routing evidence. Max reasoning remains required.

## Review and development delivery

Development changes require no development PR or Codex review: make the scoped change, immediately run the applicable local checks and deliver directly. Autonomous runtime target repairs retain their PR, completed current-head review, CI and merge gates. Review scope excludes changes limited to tests, fixtures, boot scripts, development tooling, documentation or other non-runtime files.

Never post `@codex review` or otherwise invoke the hosted Codex GitHub app. Runtime target PRs use only the internal structured reviewer through gateway `codex-auto-review`. Silence, a reaction or absence of comments does not establish a completed review. No unresolved P0/P1 may pass the gate; changed candidate bytes need matching evidence.

The reviewer vendors `openai/codex` tag `rust-v0.162.0`, `codex-rs/prompts/templates/review/rubric.md`, SHA-256 `ec60e7f36a1d1c2679ce095c0205ecc56f7dd8fb57707a13ef362072390f219f`. Do not edit the vendored constant in [src/github/codex-review-rubric.ts](../src/github/codex-review-rubric.ts). Sentinel's read-only boundary and attached harness schema override the rubric's output-format section. A re-sync needs a new upstream pin/hash and current-candidate validation; [the alignment note](codex-review-rubric-alignment-2026-10-08.md) gives verification details.

Never add Sentinel branch protection rules or rulesets, or recreate deleted rules. Applicable target protections still govern autonomous target merge.

## GitHub identity and target scope

Repository-visible autonomous Sentinel activity uses the existing `ubiquity-sentinel` App, App ID `4682172`, bot login `ubiquity-sentinel[bot]`: candidate pushes, PR creation/merge, review publication, issue closure and CI approval. Existing durable state refs use the native Actions token. App private keys and installation tokens remain trusted-host capabilities; workers receive neither.

`sentinel.targets.json` is the only target source. Minted installation-token scope must include every committed target; App installation selection alone does not widen a token narrowed by `repositories`. Each target uses its own default branch, authenticated mirror, review checkout and Git objects. Self-scope installation ID `0` is the explicit reserved local scope; foreign targets use their own verified App installation. Target preparation failures must be reported as failed rather than addressed.

Eligibility is default-on for open issues, with opt-out only through the standalone first-line `<!-- sentinel:skip -->` body comment or `sentinel:skip` label. Re-read source before admission; gaining either opt-out revokes eligibility before a start is charged. No author, assignment, estimate, template or file-hint admission gate is added.

Issue-backed repair PR bodies are exactly `Resolves #N`; a record without an issue reference keeps a descriptive non-closing body. A failed closure is retried as closure only. Source merge/closure does not substitute for runtime/deployment acceptance receipts.

## Failure accounting and diagnostics

An authenticated terminal interruption whose only failed bound is output size and whose candidate/bundle are both absent may enter the existing failed-implementation consumer. Preserve the original over-limit metrics, all identity/carrier/request/model/duration checks and original charge. Settlement is AMBIGUOUS/BLOCKED with the original intent; it grants no import, publication, refund, fabricated result or weakened output bound. Other invalid, successful or candidate-bearing over-limit receipts remain rejected.

Numeric GitHub pagination aliases are accepted only after authenticating the same repository ID/name and retaining host/path/query/page guards. Native-carrier reads stay scoped to their exact run; custody and per-request dispositions must survive runtime upgrades. Generation or age alone cannot retire unresolved preservation authority.

Gateway unavailable diagnostics retain numeric HTTP status without response bodies, URLs, authentication headers or credentials. Error kind and fail-closed observation remain unchanged; the status alone does not establish a producer root cause.

## Durable memory and self-healing

Sentinel records machine-readable attempt memory and a deterministic lesson digest in the existing Git repair state; trusted writers own every write and model workers never write state. Bounded records carry the attempt fingerprint, the stage reached, a closed failure class, counts and the runtime revision. Unchanged replays of a recorded failure are refused with a precise reason, and the implementer prompt carries verified prior attempts, cross-task repository lessons and regression facts.

The system is version-controlled and regression-aware: a recorded success stores the exact runtime revision that produced it, and a failure mode that previously succeeded at an older revision is reported as a regression (worked before, broken now) in the lesson digest and the implementer prompt, which must prefer restoring the older working behavior over re-implementing. Rollback authority stays with the owner-development install chain: a healthy proof moves generations, a failed candidate restores the recorded proven predecessor once, and no model, worker or recovery pass may pin, roll back or promote a runtime revision.

Bounded self-upkeep passes defer instead of failing the run: exhausting a recovery pass's budget, absent custody or an unavailable producer is reported with an explicit bounded reason, writes nothing and lets prepare, matrix_plan and delivery continue. Only integrity faults (tampered, conflicting or changed custody) fail closed.

A release request the trusted controller cancelled or marked failed is terminal delivery evidence: the affected delivery record is parked blocked with the recorded failure reason instead of waiting for release acceptance that can no longer exist.

## Evidence, target release and local development

Use fast module checks and directly affected production-consumer boundaries with fake external transports, temporary Git/state and injected clocks. Enforce a 300-second deadline on each local validation command. One named changed-lifecycle scenario is final local acceptance; whole-repository sweeps require a separate explicit request. [AGENTS.md](../AGENTS.md) defines observation, teardown and evidence rules.

Preserve candidate durability, exact reviewed heads, independent state/promotion ownership, healthy prior identity and exact rollback. Gateway deployment follows its current trusted VPS contract; Deno target receipts cannot establish VPS delivery. Finite encrypted evidence retention, objective telemetry and uninterrupted acceptance coverage remain activation requirements in [activation-checklist.md](activation-checklist.md).

## Historical retry disposition (consumed)

The sixteen historical retry admissions stuck by the missing-artifact matrix wave 37354374590 are consumed. All sixteen bound retry reservations settled `ambiguous` on 2026-10-09, the records were re-admitted, and issue 398 and issue 541 were delivered by the runtime and closed (PRs 955 and 958); the remaining entries carry their own fresh intents or blockers. [ops/historical-retry-disposition.ts](../ops/historical-retry-disposition.ts) reports `already_applied` and writes nothing once every bound reservation is settled `ambiguous`, regardless of later record movement, and the one-shot maintenance step was removed from [supervisor.yml](../.github/workflows/supervisor.yml).
