# Sentinel Decisions

Read before changing Sentinel runtime or delivery. These are scoped user exceptions; they do not broadly override higher authority.

## Task-scoped local execution override - 2026-10-03

For the current Sentinel concurrency task, the owner explicitly selected `gpt-6.1-sol` with `ultra` reasoning and Fast mode (`service_tier=fast`, mapped to request tier `priority`) for remaining local execution and new delegation. This supersedes the local DeepSeek default only for this task. Relay the instruction through supported parent controls, preserve current workers and artifacts, and change settings only at supported safe boundaries. A message or resume alone is not evidence that an existing request changed model or tier; distinguish requested settings from actual readback. Do not directly start turns on native multi-agent children or restart shared services.

This override does not change production Sentinel model routing, credentials, review or CI gates, promotion ownership, or the explicit approval boundary for each development-triggered hosted attempt.

## Owner-directed uncapped issue throughput - 2026-10-02

The owner requested concurrent processing of the GitHub issue backlog, then explicitly directed "lift all the limits for now" at 22:05 UTC after the one-writer, three-PR and 120-start hourly limits were identified. This supersedes the earlier artificial runtime throughput limits: enable isolated concurrent issue implementation, remove hourly and weekly start caps, unfinished-PR and concurrent-review caps, the eight-item review-drain cap, and the ordinary-run hourly delay. Reconsider stored waits caused solely by those retired caps; preserve durable admission and settlement history. The trusted default is `liveStartLimits: { perHour: null, perSevenDays: null }`; a wholly null or invalid policy still does not enable inference.

Use a GitHub Actions matrix across eligible configured targets with all available runner capacity, subject to GitHub and provider limits. Keep unique task/admission identity, credential-free model processes, source freshness, current-head semantic review and CI, and trusted serialized state, merge and promotion ownership. This decision authorizes the concurrency implementation; it is not evidence that the matrix or new policy is deployed. The existing hosted-development approval boundary still applies to this task.

## Owner-directed autonomous recovery - 2026-10-02

At 2026-10-02 14:23 UTC, after the integration owner requested permission to publish the tested queue-recovery workflow using the existing GitHub owner account because the Sentinel App lacks Workflows write, the owner directed: "You can start writing workflow changes now hurry up and fix everything". This authorizes the existing owner account for this narrowly scoped workflow-recovery publication without expanding App permissions or adding credentials. All subsequent ordinary Sentinel code/runtime/review/issue activity retains the existing App identity and trusted acceptance/admission/promotion gates.

The owner directed: "fix the fucking sentinel and don’t stop until it’s guaranteed working autonomously". For this current Sentinel recovery task, the integration owner may complete necessary source delivery, guarded runtime installation, bounded queue intervention, and hosted acceptance without repeated per-attempt approval questions. Keep local deterministic checks as the edit loop, preserve App identity, runtime review/CI/merge/promotion gates, durable charged admission history and one production implementation writer, and never fabricate health or delivery receipts. A new credential permission or an exception to the App publication identity remains an explicit owner decision. Completion requires live autonomous delivery and continued operation, not a scheduled heartbeat or an uncommitted passing candidate.

Delivery identity exception, 2026-10-03 11:18 UTC: the owner answered "Use 0x4007 for this delivery" to publication of the tested runtime and guarded controller using the existing owner account while the local App helper was unavailable. This authorizes necessary tested successors for this recovery delivery without repeated identity approval. Autonomous pull requests, reviews, merges and issue closures retain the Sentinel App identity. Credentials, runtime ownership, exact source CI, semantic acceptance, CAS, promotion and rollback gates remain unchanged.

## Closing keywords in repair pull requests - 2026-09-23

For the foreign-target repair pipeline (`ubiquity/sentinel` and `ubiquity/ai.ubq.fi`), the owner directed that an issue-backed repair pull request must use GitHub's closing syntax: the entire body is exactly `Resolves #N` for the source issue `N`, so the merge links the pull request to the issue and closes it. This retires the earlier "avoid auto-closing keywords before production acceptance" rule recorded in `MASTER-PLAN.md` and `docs/design-rationale.md`, and the publication-time keyword sanitizer is removed with it. A record with no issue reference keeps a non-closing descriptive body. Review, CI, merge, promotion, admission/quota and installation/rollback gates are unchanged.

## Owner-directed completion authority - 2026-09-22

For the current standalone Sentinel foreign-target completion task only, the owner explicitly directed: "just get the job done however you see fit stop asking me questions and finish" after being asked to publish/install runtime83a7cd8 and verify it. This authorizes the integration owner to finish in-scope publication, guarded installation, necessary hosted verification and bounded intervention without repeated per-attempt questions. It is not a general waiver for future development tasks. Keep local fast module/seam checks as the debugging loop, preserve the existing review/merge/promotion checks, durable120-start rolling-hour admission, charged history, runtime model policy and one production implementation writer. Do not fabricate receipts, reset budgets, weaken gates, or broaden credentials. Existing source and runtime ownership remain protected; report genuine external blockers without claiming delivery.

The owner subsequently explicitly authorized concurrent independent GitHub Actions validations and GPT plus DeepSeek workers; preserve one production implementation writer. On 2026-09-22 the owner ordered immediate VPS continuation in `/home/codex/repos/ubiquity/sentinel/.codex-worktrees/multi-target-repair` on `codex/multi-target-repair`, confirmed the Mac turn and descendants settled, and prohibited restarting Mac work or a standalone Codex process/shared service. Preserve Astra/ultra for this session and unrelated VPS root/historical lanes. This is the active task lane, not a replacement for the historical master-plan identity.

## Local development feedback and hosted approval - 2026-09-21

The owner requires coding agents to develop and debug through fast local module checks, then directly affected integration checks, before one final local end-to-end run. Hosted CI and live Sentinel operation must never serve as the edit/test loop. The detailed policy is `AGENTS.md`, sections "Fast local development" and "Hosted end-to-end approval boundary": each development-triggered hosted end-to-end/runtime dispatch or rerun needs explicit user approval for that attempt after local preparation. Prior activation, queue and broad delivery instructions do not grant that approval. Preserve autonomous production target PR CI/review/merge gates and scheduled operation; do not weaken them or claim local evidence proves live delivery.

Correction, 2026-09-22 UTC: the earlier instruction to use `test:local` for final acceptance recreated the waiting problem locally, with one full sweep exceeding an hour. "Final local end-to-end" means one named scenario for the changed target lifecycle, reusing current evidence when it already covers that path; it does not authorize the entire repository harness. Every local validation command gets an enforced 300-second deadline and bounded teardown, observation intervals stay at most 30 seconds, and a minute without concrete test output requires diagnosis. Whole-repository sweeps are separate work requiring the user's explicit request. This changes development validation scope, not production safeguards or runtime release gates.

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

## Multi-target repair identity and state - 2026-09-21

Repair every repository in `sentinel.targets.json` under the one
`ubiquity-sentinel` App. Three findings from live evidence shape the rule:

1. Installation 155687488 is `repository_selection: all`, but every
   `actions/create-github-app-token` step still passed `repositories: sentinel`.
   That narrows the minted token to the listed names, so the same blob, ref and
   pull-request writes that succeed with `repositories: sentinel,ai.ubq.fi` were
   refused with `403 Resource not accessible by integration`. Every mint step
   now lists every committed target. Credentials were never the missing piece.
2. A target needs its OWN private source mirror. The sentinel mirror is seeded
   from this run's checkout and provably cannot resolve another repository's
   base commit (`git checkout --detach <ai.ubq.fi head>` fails with
   `unable to read tree`), so each non-sentinel target clones its own mirror
   from its own authenticated remote and fetches its own configured base branch
   through the same shared cooldown gate. Candidate restoration, preservation,
   the loss prover and the base-refresh adapter are all scoped to the target
   that owns the objects, each target's review checkout is independent, and the
   sentinel self-target keeps its original single mirror and reserved no-App
   installation scope 0.
3. One admission budget (120 starts/hour) and one absolute deadline span every
   target; a target whose own preparation fails is recorded in the
   `sentinel_targets_diagnostic` `failed` list and is never reported as
   addressed. The gateway release receipt stays sentinel-self-only and refuses a
   foreign request explicitly.

The sequential-target restriction above is superseded by the owner-directed uncapped issue throughput decision of 2026-10-02; target identities and shared durable accounting remain mandatory.

## Task-local execution model exception - 2026-10-02 21:25 UTC

After the required local LithosAI DeepSeek Ultra route returned HTTP402 insufficient_quota before tools, the owner explicitly directed: "Use gpt sol 6.1 to finish". For the current Sentinel autonomous-recovery task only, GPT-6.1 Sol may perform remaining local implementation, fixture corrections and focused validation in the already-recorded isolated owned lanes. This supersedes the global local-execution model default solely for this task. It does not change deployed runtime model/provider policy, credentials, shared admission charges, review/CI/merge/promotion/rollback controls, single-writer ownership, personal-script authority or hosted acceptance evidence requirements. Preserve failed calls and completed work; do not retry the exhausted DeepSeek route or broaden this exception into shared configuration.

## Task-scoped throughput cap lift - 2026-10-02 22:05 UTC

The owner's exact direct message in concurrency thread `01a0fe98-b482-7ae0-892a-448044c07eb9` at 2026-10-02T22:05:51.552Z is "lift all the limits for now". The integration owner independently verified the original short user message in its persisted rollout after the coordination transport failed. For the current Sentinel throughput-recovery task, this supersedes the old one-runtime-implementation-writer design and artificial hourly/weekly model-start, WIP and concurrent-review caps. Use available runner capacity within GitHub's real matrix/platform ceilings; no purchased capacity is assumed. Durable starts and ambiguous/submitted history, per-task identity and exclusive leases, credential/state separation, current-head semantic review/CI/merge checks and serialized merge/promotion remain mandatory. This does not authorize manual quota/state rewriting, weakening acceptance, skipping exact candidate or rollback proof, changing runtime provider/model policy, or treating parallel development as live throughput proof. The source policy cutover must be tested and integrated before activation; current deployed policy is not claimed changed until it is installed.

## Task-local GPT-6.1 Sol Ultra and Fast service - 2026-10-03 01:12 UTC

The owner explicitly directed: "Use gpt sol 6.1 ultra reasoning to finish. Use gpt-6.1-sol with ultra reasoning for remaining execution and any new delegation because we want to preserve our DeepSeek tokens and spend our GPT tokens. This is an explicit task-scoped override of the normal DeepSeek delegation default. Relay this instruction to your active workers through their supported control interface and apply it at safe supported boundaries while preserving their work." The subsequent owner instruction also requires Fast mode (`service_tier=fast`, mapping to priority service) at subsequent supported execution/delegation boundaries. Remaining local Sentinel workers use exact `gpt-6.1-sol`/`ultra`, with Fast requested where supported. The native spawn interface exposes model and reasoning effort, not a separate service-tier field. Its priority catalog entry alone does not prove a child tier: independent live readback on 2026-10-03 at 02:01 UTC confirmed root priority but native child tiers were null, so child Fast remains unverified through the exposed controls. Do not claim an already-running request was retroactively changed. Settle its work first and hand off preserved files/receipts to an explicitly configured successor if the control interface cannot reconfigure it. No global configuration, production Sentinel model/provider policy, credentials, admission history or review/CI/merge/promotion safeguards are changed by this local exception; no DeepSeek call is made for the remaining local work.

Readback clarification, 2026-10-03 04:57 UTC: the model catalog and parent Fast setting do NOT establish a native child's effective or served service tier. Supported metadata previously read the user root as gpt-6.1-sol/ultra/priority and native children as gpt-6.1-sol/ultra with serviceTier null and canAcceptDirectInput false. Native spawn exposes no tier field; preserve requested Fast but report child Fast unsupported/unverified through those controls, never bypass the child guard or claim retroactive retiering. Keep requested settings, effective metadata and served telemetry separate. Exact Sol/ultra selection remains task-authorized; settled source/proofs remain preserved. The current harness revision cdd9b862 was fully read/adopted; no global settings or production Sentinel route changed.
