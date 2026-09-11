# Sentinel master implementation plan

Owner planning session: 2026-09-06 America/New_York; created across 2026-09-07 00:00 UTC. Status: ready for implementation planning handoff, no implementation started. This file is the authoritative plan for the new standalone Sentinel goal. Read AGENTS.md and this entire document before work. `docs/lifecycle.txt` is the readable runtime tree; `docs/design-rationale.md` preserves the detailed design decisions and is subordinate to this master plan.

## 1. Outcome and scope

Owner scope update, 2026-09-11: the immediate authorized outcome is to make
Sentinel repair its own GitHub backlog, launch it locally, and monitor real
autonomous work. This supersedes the first-version exclusions on self-repair
and initial activation for this local Sentinel target. Use reviewed PRs and a
trusted supervisor outside the model checkout; model workers cannot change live
admission policy, credentials, state or promotion authority. Use gpt-5.6-luna
with max reasoning, at most one model start per rolling hour (168 per rolling
seven days), shared by implementation, review, retry and continuation starts.
Run hourly with one exclusive writer; deterministic bookkeeping can continue
without a model start. A local runtime release requires exact source identity,
supervised restart and rollback; do not fabricate Deno deployment receipts for
Sentinel. Existing gateway release work remains distinct. Canonical lane and
Astra-owned task register stay unchanged.

For the authorized local Sentinel host, use the existing owner's GitHub login
through trusted code restricted to ubiquity/sentinel. Record the actual login;
do not represent it as GitHub App authentication. Reserve installationId 0
for this explicit no-App local credential scope; positive IDs retain their
App meaning. The github adapter permits that scope, gateway configuration
still requires a positive App installation, and every scope must match a
configured repository. Preserve shared durable cooldown and model admission
for scope 0. Local Git state may use a private persistent bare repository with
the same repair/release refs and expected-head writes. Model workers receive
neither GitHub credentials nor that state repository.

Build a standalone Deno/TypeScript Sentinel at `/Users/nv/repos/ubiquity/sentinel` that polls configured repositories and incident adapters, captures sufficient failure evidence, produces permanent sanitized regression tests and bounded application fixes, waits for Codex review without holding an agent, merges accepted exact-head work, and directly promotes/monitors/rolls back exact Deno revisions through a separate deterministic release controller.

Initial target: `ubiquity/ai.ubq.fi`. No webhook ingress, event bus, queue database, runtime matrix, agent fleet, generalized plugin framework, dashboard, autonomous self-modification, or automated bootstrap activation. One production implementation writer globally; at most three unfinished target PRs. A separate deterministic release writer exclusively owns Deno promotion and its release state. Multiple isolated development workers are permitted; this is not permission for multiple runtime code writers.

Delivery success: two distinct previously undelivered eligible tasks advance autonomously in priority order through accepted PRs and verified production delivery, at least one driven by a captured offending request and permanent regression fixture; subsequent eligible selection is observed. The first task's review wait must overlap useful progress on the second without parallel code writers. Demonstrate interruption recovery and exact rollback in an isolated release environment before live target activation. Do not manufacture success by hand-implementing the application issues. Existing #136 is excluded.

### Local self-update contract, 2026-09-11

A fixed trusted supervisor outside mutable runtime checkouts owns a private
active-runtime pointer and local release receipts; it never replaces itself.
It accepts only an exact local scope-0 production ReleaseRequestV1 with a
matching completed review and a merged revision in development ancestry. It
stages that exact clean revision, saves the prior healthy runtime and intent
before switching, and verifies a fresh real child run at the exact candidate
SHA before acceptance. Model admission remains in the existing repair host.
A candidate failure permits only restoration of the recorded prior revision,
followed by a fresh prior run; missing settlement or identity proof stays
pending. Never overwrite an unrelated newer active pointer. Persist local
receipts atomically under the private state root with exclusive supervisor
ownership. The repair loop receives only an optional readonly local receipt
capability; it validates exact request identity before closure. Local scope
cannot consume Deno release receipts. Gateway release behavior is unchanged.
Astra bootstraps the reviewed supervisor and initial pointer; runtime agents
cannot modify supervisor or receipt authority files, credentials or state.
Local coding tasks opt in with the exact standalone first-line HTML comment
`<!-- sentinel:repair -->` in the issue body; source is re-read before admission.
Do not use labels for admission: ubiquity-os[bot] removes the default labels.


## 2. Canonical goal identity

| Identity | Value |
| --- | --- |
| Canonical plan / goal ID | `/Users/nv/repos/ubiquity/sentinel/MASTER-PLAN.md` |
| Goal slug / hash suffix | `master-plan` / `gfa795549e5` |
| Repository root | `/Users/nv/repos/ubiquity/sentinel` |
| Canonical worktree name | `master-plan-gfa795549e5` |
| Canonical worktree path | `/Users/nv/repos/ubiquity/sentinel/.codex-worktrees/master-plan-gfa795549e5` |
| Canonical branch | `codex/master-plan-gfa795549e5` |
| Base ref / exact initialization SHA | local `development` / `ec4bd82df4adfdb962e10332607ee4fbf539cdeb` |
| Lane status / owner | planned, not created; next primary orchestrator creates and owns it |


Local initialization base is a documentation-only commit. After creating the canonical lane from that exact base, fast-forward it to the root's verified planning-only `development` tip before implementation; verify the intervening commits modify only these planning documents. Record that exact documentation tip in `docs/build-status.md` before assigning work. This admits the final plan commit without a circular self-referential SHA. Do not follow a moving root tip blindly if implementation or another writer has appeared.

No GitHub remote was created. `gh repo view ubiquity/sentinel` did not resolve under the available account at setup; that does not prove global nonexistence. Local root was absent and was initialized on `development`. Remote name/visibility and hosted credentials are not selected by this plan. Build locally without them; resolve publication identity before creating the remote, then preserve the recorded lane.

This is a new goal, not the embedded prototype's goal. Do not repurpose its branch, merge PR251 here, or change its pending work. The old ai.ubq.fi lane remains `/Users/nv/repos/ubiquity/ai.ubq.fi/.codex-worktrees/issue-throughput-handoff-2026-09-06-g5a02cbbad3`; reconcile its owner and pending changes before any target-side module or runtime cutover.

## 3. Review policy: concentrate Codex at acceptance

During module development use focused deterministic tests and primary-agent diff inspection. Do not spend Codex reviews on module commits, internal ancestry merges, scaffolding, or every small adjustment. The first Codex review covers the complete integrated, locally accepted candidate. Batch relevant fixes; a materially changed candidate needs a fresh acceptance review, not a recycled clean verdict. At most three review rounds per acceptance cycle; unresolved substantive P0/P1 after that means blocked, never automatic merge. Review failure/no verdict is unavailable, not passed.

Development reviews and the product's runtime review policy are distinct. Runtime target PRs still require a verified completed current-head Codex review with no unresolved P0/P1 plus passing deterministic CI and branch protections. They wait asynchronously and consume configured model-start allowance. P2/P3 become future work unless target policy requires more. The earlier embedded prototype's all-severity non-gating policy is not adopted.

At final delivery, use one aggregate PR for Sentinel and at most one required gateway-integration PR, each reviewed after integrated acceptance preparation. Their CI can run throughout; no per-module public PR/review loop. Target rules still apply to the gateway PR; the owner's latest instruction defers optional repeated Codex requests, not deterministic validation or exact-head acceptance. Do not alter unrelated repository policies to save review quota.

## 4. Architecture and runtime order

Repair workflow: scheduled at 7,22,37,52 minutes past the hour; manual runs use the same path. One fixed non-cancelling concurrency group. No incident/PR/review/push triggers. The loop reads saved progress, reconciles incomplete external operations, polls authoritative sources, selects an eligible action, checks model admission if needed, executes it, saves progress, and repeats only while meaningful work and sufficient time remain. Pending reviews are skipped. No sleeping agent or busy polling. A failed source read cannot become a successful empty result.

Priority: finish outstanding delivery bookkeeping first; then active production incidents by impact/severity and oldest first_seen; P0/P1 corrections; other reproducible unresolved 5xx groups; other existing Sentinel PR repairs; then issues/nonblocking review backlog by highest recognized numeric priority and oldest creation time. Stable repository/source tie-break, missing priority last, highest duplicate recognized label wins. Known severe security/data-loss work uses incident urgency regardless of source. Preserve protected paths, dependencies, source integrity and contributor ownership. No author/assignment/estimate/template/file-hint admission gates. Never create duplicate tasks for repeated identical incidents.

Release workflow: separate five-minute scheduled serialized job reads durable requests, reconciles current Deno state, identifies an exact built candidate, verifies it, records the healthy prior revision, promotes, monitors, and accepts or restores that exact prior revision. It uses no model and no model budget. Both workflows poll; no event-delivery protocol. The repair writer cannot promote or mutate release-state records. The release writer cannot edit application code or repair-budget records.

Repair job ceiling: 120 minutes, with no new model work after 90 minutes and a reserved validation/publication margin; obey tighter supported invocation bounds. Never start work whose declared maximum plus margin does not fit. Checkpoints must be durable before termination, not only in finally handlers. GitHub's six-hour hosted-job limit is a ceiling, not a target or availability guarantee.

## 5. Shared contracts: freeze before parallel work

Foundation owner writes strict TypeScript types, runtime parsers, canonical serialization and contract fixtures in `src/contracts/`. No worker invents its own status/digest variant or changes these files. Proposed names below become the version-one contract; minimize fields while preserving the listed semantics.

| Contract | Required content and behavior |
| --- | --- |
| RepositoryConfigV1 | Repository identity, installation reference, base branch, exact adapter kind, configured validation/replay commands, protected paths, build/acceptance identifiers; secret references only. Global hourly/seven-day start limits are required before enabling inference. No model-generated shell commands. |
| WorkRecordV1 | Stable source identity/revision, kind, severity/priority/age, related incident/issue, controller SHA, target base/checkpoint/head/PR, next step (`work`, `review`, `delivery`, `blocked`, `done`), bounded attempts/next retry/blocker, evidence references, incomplete operation intent. Waiting is a reason on a next step, not a second conflicting lifecycle. |
| IncidentSummaryV1 / IncidentEvidenceV1 | Stable incident fingerprint, first/last seen/count/severity, failing revision, bounded error context, authenticated artifact refs/hashes/expiry and replay metadata; provenance and missing-coverage status. Sensitive content is never in public work records. |
| ReviewReceiptV1 | Expected reviewer identity, PR/head, observed base, request/result IDs, completed/pending/unavailable outcome, full original findings and fingerprints, unresolved severity; exact head binding. No completion inferred from silence/reaction. |
| BudgetReservationV1 | Unique task/head/attempt identity, timestamp, purpose, submitted/ambiguous/confirmed-not-submitted outcome. Durable admission precedes model start. Shared across repos/manual runs; hour and seven-day rolling checks. |
| ReplayResultV1 | Exact original/candidate SHAs, sanitized fixture/test digest, command identity, expected behavior, before failure and after pass, output hashes and limitations. Failure must be for the intended reason. |
| ReleaseRequestV1 | Stable request ID, target/environment, accepted merged SHA and PR/review reference; no model-supplied arbitrary revision choice. |
| ReleaseRecordV1 | Request identity, exact candidate/prior SHA and revision, current phase/intent, actual observed identity, baseline/samples/threshold result, acceptance/rollback/error receipts. Interrupted monitoring is never fabricated continuous coverage. |

Ports: `GitHubPort` for authenticated reads/exact-head writes and review normalization; `IncidentAdapter` for `listUnresolvedIncidents` and `readIncident`; `ReplayPort` for isolated deterministic validation; `ImplementationPort` for a bounded model session with secret-free checkout; `DenoReleasePort` for exact revision discovery/identity/promotion/metrics; `StateStore` for expected-head record writes; `Clock` for testable time. Tests inject transports, not alternate product logic. Production adapters implement these ports directly.

Evidence authenticates different objects with distinct digests: source snapshot, fixture, encrypted artifact and Git commit are not interchangeable. Original historical identities never get rewritten to match a resumed run.

### State and budget implementation

Use dedicated Git branches `sentinel-state/repair` and `sentinel-state/release` in the new repository. The primary source branch is `development`. Each state branch has one trusted workflow writer and JSON records; ordinary non-force pushes with expected remote head. On ref mismatch, reread and fail/resolve explicitly; never force-overwrite. Coding agents get no state-writing credentials. Local tests use real temporary Git repositories and injected remote APIs. Production state branches are created only at activation, not during this planning setup.

Save intent before push/PR/review/merge/promotion, then reconcile the exact remote object after an ambiguous response before repeating. Deterministic task/branch identities prevent duplicate PRs. A saved candidate survives restart. Missing evidence is a blocker, not permission to regenerate or reset terminal work. Keep compact completed records to avoid restarting unchanged tasks; defer pruning.

One shared model-start budget record lives on repair state. Charge each independently initiated agent session, continuation, retry and Codex review request. Save a reservation before invocation; persistence failure prevents invocation. Ambiguous submissions remain charged unless proven never submitted. Caps do not reset on process restart or midnight; use rolling timestamps. These are local start caps, not exact token/provider allowance. A single session can contain unobserved requests; preserve supported duration/token/turn bounds, report authoritative quota failure and leave manual-use headroom. No incident exception, automatic provider substitution or uncapped review path. No numeric owner budget is guessed: offline build works with fixtures, live inference remains disabled until configured.

## 6. Gateway evidence and regression requirements

Current source snapshot at setup: ai.ubq.fi root `development` at `aafb7ee0598699bb7fb8a72ea133693ed64462da`, with pre-existing untracked `.DS_Store` and `docs/provider-sentinel-redesign-2026-09-04.md`; preserve both. Do not treat this snapshot as a live lease.

Reusable code was confirmed in `src/sentinel_replay_capture.ts`, `src/sentinel_replay_admin.ts`, `src/sentinel_incident_outbox.ts`, `src/sentinel_incident_admin.ts`, `src/admin_error_log.ts` and `src/handler.ts`. Existing routes include authenticated `GET /admin/errors`, super-admin `GET /admin/sentinel/replay-captures`, and incident claim/ack/defer POSTs. Replay export accepts interval/cursor/incident ID and currently requires page limit one. Respect and exhaust pagination rather than assuming a larger page is supported.

Important gap: both incident and replay capture TTL constants are 48 hours. Weekly budget waits can outlive them. The target integration must provide durable unresolved incident discovery and retain or export evidence before expiry; do not claim the current rotating store already meets this contract. Proposed narrow addition: authenticated `GET /admin/sentinel/incidents` exposing a paginated unresolved index with stable IDs and explicit coverage/expiry metadata, using the existing authorization pattern. Reuse existing replay export for artifacts. Do not weaken admin authentication or expose plaintext payloads in a new public API. If a suitable existing endpoint is found during reconciliation, use it instead of duplicating it.

Capture sensitive originals in restricted encrypted storage; the deterministic ingestion phase must secure active evidence before model budget is available. Define a finite owner-approved retention/storage bound before production, and block with `evidence_expired` rather than inventing a fixture if capture was lost. No new key/secret/env surface is approved; reuse the existing mechanism where access scope permits and request a concrete missing credential interface only after producing the exact need. Do not copy an application key into a handoff or model environment.

The permanent test is a minimal sanitized request/upstream fixture committed to the target with the fix and wired into its normal CI. It fails on the recorded original revision for the intended reason and passes on the candidate. Cover relevant status/schema/SSE termination behavior; replay upstream responses locally rather than spending paid inference to reproduce. A proper 4xx for invalid input can be correct. Irreducible private data must not be committed; report when an equivalent safe regression cannot be established. The agent cannot rewrite expected results to disguise failure.

## 7. Review, merge and release safety

GitHub App authentication supplies short-lived scoped target access to the trusted host. No webhook subscription. Models get isolated checkouts and bounded evidence, not App private keys, state credentials, or Deno tokens. Restore current Codex/runtime authentication through the existing approved mechanism; verify actual model/effort receipts, never a CLI label alone. Owner clarification, 2026-09-09 21:38 UTC: accepted evidence is trusted submitted provider/model/effort configuration bound to the exact invocation/thread/turn, with all applicable runtime routing events and terminal result; label this request/runtime evidence, not backend provider attestation. Preserve Luna/max, no fallback and fail closed when correlation or required evidence is missing.

Codex clean-verdict integration is an explicit uncertainty: obtain representative actual completed-clean and finding-bearing results with exact head identity. Validate them against the expected reviewer; missing machine-verifiable completion means unavailable. Do not build a permissive parser around eyes reactions or absence of comments. Use one pending request per head; corrections require new head validation and review. Do not reset review-round limits on each new commit. Human-authorized finding disputes must be recorded; the coding agent cannot clear its own merge gate.

Trusted merge code rechecks current CI/protection/head and performs expected-head merge. Base movement requires current integrated validation; changed candidate content requires a fresh reviewed head. Target releases are serialized, and human-owned PRs are untouched unless delegated. Avoid auto-closing issue keywords before production acceptance. Retry a failed issue closure as closure only.

Target CI builds the exact accepted merged SHA. The new release controller must be the exclusive stable promotion writer; the target's current automatic promotion path must be disabled/reassigned during the authorized handover, not left racing. Preserve target `deno-deploy.yml` build/receipt capability. No code in the repair agent chooses a revision by timestamp or list order.

Release: attest actual healthy prior SHA/revision before promotion; identify exactly one succeeded candidate from the exact build transaction; verify immutable candidate identity; persist promotion intent; call the existing Deno promotion API and require 204; verify stable managed body/headers and custom domain. For the gateway retain identified Cloudflare 403 as warning only after managed identity passes, and fail any HTTP 200 identity mismatch. Keep 30 continuous minutes of acceptance with 30-second samples. Roll back only an objectively failed controlled candidate to its recorded prior revision and prove restoration; reviews alone do not trigger rollback.

Stability policy requires declared metrics, denominators, baseline/window, minimum samples and owner-approved thresholds. Include health identity, relevant 5xx and timeout/stream failures; distinguish upstream-wide faults and low sample counts. Do not claim missing telemetry is stable or choose universal thresholds from intuition. A lost monitor restarts continuous coverage; Actions schedule/runner availability is not a rapid-rollback guarantee. Use independently supervised hosting if a hard recovery SLA is required. This remains an explicit deployment choice, not hidden extra infrastructure.

## 8. Development waves and ownership

Development uses DSH writers under the installed global playbook, not an assumed unlimited nested-subagent capability. Primary owns architecture, integration, Git commits/pushes and acceptance. Verify `deepseek-official/deepseek-v4-flash-vision-exp` at max in the actual request header with `NODE_ENV=production`; follow current `~/.codex/agents/deepseek-harness.md` rather than copying the old ai.ubq.fi TUI invocation into this new repo. For m06-gateway, its target AGENTS may require a different supported TUI launch path; obey those more-specific target instructions while preserving the same model/max invariant. No arbitrary process kill, restart, model substitution or secret transfer. One DSH writer per isolated worktree.

No Codex implementation subagent substitution under that playbook. Independent DSH processes in recorded worktrees are sufficient; nested DSH subagents are not a prerequisite. Start at most three write-capable development workers at once, expanding only after ownership and provider capacity are established. This bounds integration load without assuming a Harness hard cap. Read-only inspections need no branch.

### Wave A — shared foundation, one owner

Primary owns foundation acceptance and uses one bounded DSH writer in the canonical lane before parallel writers start. Owned: `src/contracts/**`, `src/state/**`, `src/budget/**`, `tests/contracts/**`, `tests/state/**`, `tests/budget/**`, `tests/fixtures/contracts/**`, root Deno/toolchain files, `docs/contracts.md`, `docs/build-status.md`. Write strict contracts, state/budget implementation, hermetic test harness and a fake-port loop skeleton. Register production entrypoint boundaries without writing parallel modules. No paid/model/network calls in tests. Save exact foundation commit F in build status. Do not launch Wave B before F is validated and committed. Workers branch from this exact integrated F.

### Wave B — bounded independent modules

#### m01-github

- Ownership: `src/github/**; tests/github/**`.
- Repository: `/Users/nv/repos/ubiquity/sentinel`.
- Module hash suffix: `a86bd3790da`.
- Worker worktree name: `master-plan-m01-github-a86bd3790da`.
- Exact worktree path: `/Users/nv/repos/ubiquity/sentinel/.codex-worktrees/master-plan-m01-github-a86bd3790da`.
- Exact branch: `codex/master-plan-m01-github-a86bd3790da`.
- Lane state: planned; primary creates after dependencies/ownership pass.
- Dependency/base: Exact validated foundation commit F from Wave A; primary records the full SHA before launch, no moving ref.
- Prohibited: shared contracts/state/budget, root manifests/lockfiles, other modules and production activation; target module additionally preserves old Sentinel control/policy/workflow ownership except its explicitly assigned build receipt seam.

#### m02-evidence

- Ownership: `src/adapters/gateway/**; tests/adapters/gateway/**`.
- Repository: `/Users/nv/repos/ubiquity/sentinel`.
- Module hash suffix: `afb9652dea8`.
- Worker worktree name: `master-plan-m02-evidence-afb9652dea8`.
- Exact worktree path: `/Users/nv/repos/ubiquity/sentinel/.codex-worktrees/master-plan-m02-evidence-afb9652dea8`.
- Exact branch: `codex/master-plan-m02-evidence-afb9652dea8`.
- Lane state: planned; primary creates after dependencies/ownership pass.
- Dependency/base: Exact validated foundation commit F from Wave A; primary records the full SHA before launch, no moving ref.
- Prohibited: shared contracts/state/budget, root manifests/lockfiles, other modules and production activation; target module additionally preserves old Sentinel control/policy/workflow ownership except its explicitly assigned build receipt seam.

#### m03-replay

- Ownership: `src/replay/**; tests/replay/**`.
- Repository: `/Users/nv/repos/ubiquity/sentinel`.
- Module hash suffix: `ac17fc34d9a`.
- Worker worktree name: `master-plan-m03-replay-ac17fc34d9a`.
- Exact worktree path: `/Users/nv/repos/ubiquity/sentinel/.codex-worktrees/master-plan-m03-replay-ac17fc34d9a`.
- Exact branch: `codex/master-plan-m03-replay-ac17fc34d9a`.
- Lane state: planned; primary creates after dependencies/ownership pass.
- Dependency/base: Exact validated foundation commit F from Wave A; primary records the full SHA before launch, no moving ref.
- Prohibited: shared contracts/state/budget, root manifests/lockfiles, other modules and production activation; target module additionally preserves old Sentinel control/policy/workflow ownership except its explicitly assigned build receipt seam.

#### m04-repair

- Ownership: `src/repair/**; tests/repair/**`.
- Repository: `/Users/nv/repos/ubiquity/sentinel`.
- Module hash suffix: `ac50ee9a0a3`.
- Worker worktree name: `master-plan-m04-repair-ac50ee9a0a3`.
- Exact worktree path: `/Users/nv/repos/ubiquity/sentinel/.codex-worktrees/master-plan-m04-repair-ac50ee9a0a3`.
- Exact branch: `codex/master-plan-m04-repair-ac50ee9a0a3`.
- Lane state: planned; primary creates after dependencies/ownership pass.
- Dependency/base: Exact validated foundation commit F from Wave A; primary records the full SHA before launch, no moving ref.
- Prohibited: shared contracts/state/budget, root manifests/lockfiles, other modules and production activation; target module additionally preserves old Sentinel control/policy/workflow ownership except its explicitly assigned build receipt seam.

#### m05-release

- Ownership: `src/release/**; tests/release/**`.
- Repository: `/Users/nv/repos/ubiquity/sentinel`.
- Module hash suffix: `a2ebf3089f9`.
- Worker worktree name: `master-plan-m05-release-a2ebf3089f9`.
- Exact worktree path: `/Users/nv/repos/ubiquity/sentinel/.codex-worktrees/master-plan-m05-release-a2ebf3089f9`.
- Exact branch: `codex/master-plan-m05-release-a2ebf3089f9`.
- Lane state: planned; primary creates after dependencies/ownership pass.
- Dependency/base: Exact validated foundation commit F from Wave A; primary records the full SHA before launch, no moving ref.
- Prohibited: shared contracts/state/budget, root manifests/lockfiles, other modules and production activation; target module additionally preserves old Sentinel control/policy/workflow ownership except its explicitly assigned build receipt seam.

#### m06-gateway

- Ownership: `src/sentinel_incident_admin.ts; src/sentinel_incident_outbox.ts; src/sentinel_replay_capture.ts; src/sentinel_replay_admin.ts; src/handler.ts exact route wiring; affected tests; .github/workflows/deno-deploy.yml build/receipt seam only`.
- Repository: `/Users/nv/repos/ubiquity/ai.ubq.fi`.
- Module hash suffix: `ad0aef5cd31`.
- Worker worktree name: `master-plan-m06-gateway-ad0aef5cd31`.
- Exact worktree path: `/Users/nv/repos/ubiquity/ai.ubq.fi/.codex-worktrees/master-plan-m06-gateway-ad0aef5cd31`.
- Exact branch: `codex/master-plan-m06-gateway-ad0aef5cd31`.
- Lane state: planned; primary creates after dependencies/ownership pass.
- Dependency/base: Target snapshot `aafb7ee0598699bb7fb8a72ea133693ed64462da`; reconcile old owner/PRs first, record the exact approved target base T before lane creation; requires frozen foundation F contract and target ownership.
- Prohibited: shared contracts/state/budget, root manifests/lockfiles, other modules and production activation; target module additionally preserves old Sentinel control/policy/workflow ownership except its explicitly assigned build receipt seam.


Each worker's assignment must repeat the exact plan path, module ID, worktree/branch/base F (or reconciled target base), owned files, prohibited shared surfaces, required behavior/tests, runtime expectation and failure response. Workers are not alone; preserve others' edits. No commit/push by DSH. Primary verifies changed paths, terminal result and focused tests, commits the worker result in its own lane, and integrates using ancestry-preserving merges. A worker handback is only ready, not project-complete.

Module behavior and acceptance:

- **m01-github:** Implement GitHubPort, installation-token handling, source reads, exact-head PR publication/merge and strict review normalization. Simulate pending/clean/P1/stale/malformed review, duplicate publication and ambiguous request. No permissive clean inference; no real comments/reviews during module tests. No policy/storage schema edits.
- **m02-evidence:** Implement gateway adapter, pagination, normalized incident identity, bounded restricted artifact retrieval/integrity and expiry reporting. Use frozen gateway HTTP fixtures; ensure incomplete coverage is surfaced and duplicate incidents link to one task. Read-only adapter; no remote claim/ack side effects hidden in listing. Coordinate producer schema through foundation owner.
- **m03-replay:** Implement isolated checkout/replay runner, sanitized fixture validation/provenance, before/after result and target test invocation through configured commands. Prove fail-before/pass-after with a local toy server and recorded upstream fixture, no model or network. Reject sensitive fixture material and wrong revision; preserve useful checkpoints. Agent-written regression must use actual target CI, not a standalone unused script.
- **m04-repair:** Implement pure selection/loop transitions against frozen ports, capped WIP, retry/wait handling and model admission integration. Runtime ImplementationPort uses pinned Luna/max with supported bounded sessions; tests fake it. Confirm no model calls at budget cap, unchanged wait exits, publication survives restart, terminal identities stay terminal, and review wait allows another eligible task. No GitHub/Deno transport or workflow edits.
- **m05-release:** Implement DenoReleasePort and deterministic release state machine, candidate/prior identity, promotion/monitoring/rollback and recovery against scripted transport. Prove ambiguous promotion reconciliation, lost-monitor behavior, exact rollback, unrelated-newer-revision protection and missing telemetry failure. No real promotion or model calls. This module exclusively owns release implementation; shared storage port stays foundation-owned.
- **m06-gateway:** In the target repository, reuse existing capture/export and add only the unresolved-discovery/retention and build-receipt seams needed by the frozen contract. Tests exercise actual authenticated handler and capture persistence, not a constructed output object. Keep OpenAI-compatible gateway behavior and current model/policy rules unchanged. Prepare but do not activate build-only/promotion-ownership cutover until authorized. No changes to old Sentinel runtime controls to bypass its ownership. This module may be postponed while its target owner is active; Sentinel modules continue against contract fixtures.

### Wave C — integrate real paths, one writer

Primary owns `src/main.ts`, `src/release-main.ts`, `.github/workflows/**`, repository config/example docs, end-to-end tests, permission/env wiring, and all cross-module seams. Integrate accepted worker commits, exercise the actual port adapters and entrypoints, then connect the gateway producer/consumer. Interfaces already exist; this wave fixes wiring defects rather than inventing incompatible interfaces after the fact. Any necessary contract change goes through the foundation owner with affected consumers retested before continuing. Do not add a second general abstraction layer.

Use one dedicated bounded DSH integration assignment in the canonical lane after parallel writers are quiescent. Other agents can perform read-only audits without spawning Codex review calls. If integration exposes a module defect, assign a bounded correction in its recorded lane, rebase its starting ownership to the current integrated SHA with explicit recorded ancestry, and reintegrate; do not silently switch lanes.

## 9. Validation and acceptance sequence

Define one canonical Deno task `test:local` during foundation: focused repository suites, actual producer/consumer replays, formatting, lint and type/build checks, with credential-free child environments and no external calls. Run focused affected tests while coding; run the integrated harness when combined behavior is ready. The name is a planned existing-task interface for this new repo, not a new CLI flag/environment variable. The target gateway still uses its existing `deno task sentinel:test-local` for Sentinel-touching PRs.

Local acceptance before Codex review:

1. Run the complete lifecycle via actual production entrypoints with fake external transports and real temporary Git repositories: incident discovery → artifacts → before-failure replay → implementation result → after-pass regression → PR request → pending review → next-run review ingestion → exact-head merge → release request → promotion/acceptance → closure.
2. While the first PR waits, advance a second work item using the same single writer. No duplicate review request or extra budget charge on observation.
3. Inject crashes after candidate push, PR creation, review submission, merge and promotion; next-run recovery preserves successful work and reconciles effects. Inject real CAS/ref conflicts and old-running-job ownership rather than assuming expiry means exit.
4. Verify both rolling budgets across repositories/restarts, including retries/continuations/reviews, clock-window boundaries and ambiguous submissions. Deterministic work still runs at cap.
5. Prove wrong head/review identity, P0/P1 findings, no verdict, missing telemetry, stale source, dependency blockers, invalid artifact and protected changes fail closed at their actual consumers. Blocked work does not prevent eligible unrelated work.
6. Prove exact rollback and no rollback of a newer unrelated release; continuous acceptance cannot survive an unobserved gap as if sampled.
7. Verify gateway retention beyond the current 48-hour expiry boundary with controlled clocks; private capture never enters public logs/Git/model credentials.

Then freeze the integrated head, run one Codex acceptance review, address substantive findings in a batch, rerun affected/integrated checks as justified, and obtain a new exact-head review where changed. Publish one aggregate PR and satisfy deterministic branch gates. Preserve every accepted worker tip as an ancestor. No P0/P1 bypass on exhausted review quota; report that specific acceptance blocker while keeping the implementation intact.

Live proof after publication identity, credentials, budgets, thresholds and target handover are settled: first use read-only discovery with a retained captured incident; then one isolated real Deno release/rollback test; then enable target repairs. Record exact source/fixture/before-after results, PR/head/review IDs, merge SHA, Deno revision, acceptance/rollback receipts and issue closure. Start a six-hour observation window after activation and receipt verification, not while waiting for setup approval. Require two distinct new deliveries in eligible order plus continued selection. If outside-provider quota or retention prevents it, report the exact blocked boundary; do not redefine local tests as live completion.

## 10. Live activation boundaries and unresolved owner choices

These do not block offline module implementation:

- GitHub repository name/visibility and publication authority; local plan setup does not create a remote.
- Existing GitHub App installation/token access, target admin artifact access and Deno token scope. Inspect existing trusted sources without printing values. No new secret/env/flag without explicit owner choice.
- Hourly/seven-day model-start caps and session policy; no guessed live allowance.
- Evidence-retention/storage bound and stability thresholds/minimum samples. Existing 48-hour TTL is inadequate for arbitrary weekly waits.
- Exact old Sentinel writer/drain and promotion ownership handover. Inventory current jobs/leases before intervention; do not reuse stale cancellation authority. Keep old candidates/terminal decisions and contributor work.
- Confirmed clean-review output contract and target release build/promotion behavior. An unverified integration cannot be enabled simply because tests use fixtures.

Complete a concrete activation checklist with exact current targets and settings before asking for those choices. No paid probes, live model submissions, GitHub communications, cancellation, workflow disable or production promotion is performed by this planning session. Later implementation instructions and the user's explicit activation choices govern execution; this plan does not manufacture permission.

## 11. Lessons from the embedded prototype

Treat these as regression inputs, not reasons to copy its architecture:

- #207 produced candidate `4a21c96d46e6f98c3c04125cafce34e255e710e3`; convergence failed on model-supplied decision digest. Digests/identity are trusted code duties. A transport error did not negate the later successful cell.
- #208 produced candidate `6dc35d06e757107b91eb58232bd15e5f671d79b4`; final integration rejected/blocked it with unknown semantic reason. Never guess the missing cause or regenerate merely because aggregate state has no candidate pointer.
- Successful artifacts were skipped by a recovery path built only for retry reports. Test actual success-publication → failed-downstream → resume consumers.
- Recovery observations were counted as new failures; controller faults exhausted source circuits. Charge operations once, preserve stage and typed cause; observation is not an attempt.
- Health-green and workflow-green were mistaken for throughput. Require issue-level delivery receipts.
- Continuous code runs blocked controller updates because everything shared a Git base. Standalone controller SHA and target application SHA are separate identities.
- Global history was treated as per-item history; record pruning orphaned metadata; protected directory hashing and allowed-path validators disagreed. Keep strict small state with no early pruning, and test real Git/protected-directory boundaries.
- Local helper-only tests missed production wiring defects. Freeze interfaces first and test actual entrypoints before spending review quota.

Do not reset old #137's unchanged terminal state or count old #136 as a new success. Existing prototype source at setup is not proof that all its live failures remain unchanged; reconcile any reuse at implementation time.

## 12. Handoff, status and completion

`docs/build-status.md` is the single progress ledger: foundation SHA, exact module bases/tips, ownership/process receipt, checks, integration disposition, review identity, PR/release references, live proof and blockers. Update after each accepted result, not after every tool call. Assignments target first edit/compile in roughly ten minutes and a focused result within thirty for a small bounded task; diagnose missing progress rather than launch an unbounded mega-prompt. Read the full DSH playbook before launch and follow its supported intervention/credential rules.

Primary commits validated worker output and merges with ancestry preserved; workers never commit/push under the DSH playbook. Before final completion fetch each repository's remote base: prove accepted Sentinel worker tips ancestors of the Sentinel canonical tip and remote `development`, and accepted gateway worker tips ancestors of the gateway's own canonical/remote `development`; never try to merge unrelated repository histories. Leave each local root matching its own branch when ownership permits. Preserve dirty or unfinished work with named owner and next action. Never claim complete while accepted changes remain only in worker lanes.

Planning completion is distinct: a committed local documentation repository and this verified handoff, with no runtime implementation, worktrees, remote, model runs or deployments. The next session starts by reading the goal sentence below and doing canonical identity/ownership checks.

## Copyable goal sentence

Goal: Use canonical worktree name master-plan-gfa795549e5 at /Users/nv/repos/ubiquity/sentinel/.codex-worktrees/master-plan-gfa795549e5 on branch codex/master-plan-gfa795549e5, read AGENTS.md and /Users/nv/repos/ubiquity/sentinel/MASTER-PLAN.md in full, then orchestrate the standalone Sentinel build through the recorded foundation and isolated DSH module lanes, integrate and validate on the canonical lane, defer Codex review until integrated acceptance, and prove captured-request regression repair plus reviewed delivery and exact Deno rollback within the plan’s activation boundaries.
