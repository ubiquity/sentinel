# Sentinel memory + self-healing plan

Owner request, 2026-10-09: incorporate a version of OpenClaw's memory management into Sentinel so the runtime self-heals and stops repeating mistakes, with full awareness that the primary runtime is GitHub Actions matrix runs (ephemeral, isolated, concurrent).

This is the authoritative plan for the memory/self-healing goal. Read AGENTS.md and this document before work.

## Goal

Make Sentinel remember its own failures across ephemeral runs and act on that memory:

1. Record machine-readable failure/attempt memory durably at trusted settlement points: what was attempted, where it failed, which stage was reached, what the fingerprint of the attempt inputs was.
2. Refuse to repeat an unchanged (equivalent) failing attempt: planner admission and the hosted retry pass must deny an attempt whose inputs are unchanged from a prior failed attempt, and instead either require changed evidence or record an explicit, precise escalation.
3. Retrieve memory where it changes behavior: planner admission, model prompt construction (bounded "already tried" context for the implementer), maintenance retry grants, and progress/escalation reporting.
4. Capture must be deterministic-first and trusted: model workers never write state; any model-authored attempt notes travel only inside artifacts and are sanitized/bounded by the trusted consumer.
5. Bound everything: record sizes, per-record entry caps, state growth, prompt section size.

## Prior art already decided (reuse; do not re-derive)

The 2026-10-06 GPT Pro prior-art report (`Ranked prior-art report for Sentinel`) concluded, and this plan adopts:

- Keep the Git state store; persist per-blocker/attempt memory in it (rank 4 change: "Persist failed approaches and retry budgets; reject equivalent retries before invoking the model or executor").
- Reserve before acting; reject equivalent failures before execution (a new run id, model name, prompt paraphrase or unrelated commit must NOT reset a failed approach); strategy switching must be observable (changed causal hypothesis, implementation, or evidence).
- Use the stage actually reached as evidence; do not collapse verification failures into generic exceptions.
- Persist circuit-breaker-style state through the existing Git writes; a library object is not durable until committed.
- Structured reason codes over substring matching.
- Bounded recovery, then terminal quarantine/escalation; unrelated work continues.

## Research input

GPT Pro job `9f061de3-37c4-4983-ab73-2ede700cd4cb` (submitted 2026-10-09 08:57 UTC, background, retrieval owner running) is producing the OpenClaw-translation design this plan will fold in before the contract is frozen: translation table, data model + storage, matrix-specific capture pipeline, retrieval/decision logic, self-healing actions, crash analysis, implementation plan and pitfalls.

OpenClaw mechanisms to translate (read from the local checkout at `/home/codex/repos/0x4007/openclaw` when needed):
- Plain markdown files as source of truth: append-only daily log + curated long-term `MEMORY.md`; read today+yesterday at session start.
- Automatic pre-compaction memory flush: a silent agentic turn that writes durable notes before context is compacted; one flush per compaction cycle.
- Mode-scoped memory loading (curated memory only in the main/private session).
- Memory search over the memory files; session pruning/compaction summaries.
- Retry policy per request with typed retryable errors; auth-profile rotation and model failover with cooldowns.

## Target architecture (supplied facts)

Runtime is the `sentinel-supervisor` GitHub Actions workflow: `maintenance -> prepare -> matrix_plan -> matrix_cell x N -> repair -> finalize`. Cells are ephemeral and isolated, have no state-write capability, and upload a result artifact (result.json + git bundle). Durable state lives on `refs/heads/sentinel-state/repair` and `.../release`: manifest + per-kind collections, one canonical JSON file per record, strict expected-head CAS writes, exactly one trusted writer per branch. Existing repair collections: incidents, evidence, work, reservations, reviews, replays, releaseRequests, githubCooldowns.

Motivating repeated-failure evidence: `matrix_plan` runs ~14 minutes and dies with the generic `hosted runtime result is unavailable` (runs 37901684612, 37902881934 on 2026-10-09); five-minute maintenance timeouts and `startupReady:false` pre-inference failures in earlier generations; the hosted retry pass can grant up to 200 retries per task without requiring changed evidence; the only durable human learning is `docs/build-status.md`, which is not machine-consumed.

## Design (v0; contract frozen only after the research lands)

- New record kind + collection on the repair state branch: one bounded machine-readable record per attempt family (repository + task + base + operation), each carrying bounded entries keyed by an attempt fingerprint: fingerprint digest, stage reached, structured failure class, closed detail constant, count, first/last timestamps, run/cell references. Written only by trusted writers; sanitized and bounded by construction.
- Fingerprint derivation: canonical tuple over the identity-bearing attempt inputs (target, task, base revision, candidate revision when any, model route/model id, prompt/template version, operation purpose, attempt intent key). Unrelated changes (new run id, wall-clock, attempt number alone) never change the fingerprint.
- Capture: extend the trusted settlement paths (`settleAndBlock`/`settleFailedImplementation`/receipt failure paths and the matrix cell ingest) to append attempt memory in the same state commit as the corresponding work-record/blocker change, so memory and outcome move atomically.
- Decision: a pure equivalence policy consulted by (a) runtime admission (planner/serial step) and (b) `planHostedRetries`: deny an equivalent attempt when a prior attempt with the same fingerprint already failed, unless policy admits it (classified-transient allowance with cooldown; changed evidence such as a new base tip, changed route, changed template version). Denial produces a precise blocker/escalation, never a silent re-loop.
- Retrieval: bounded prompt section for the implementer listing prior attempts on the same work item (stage, class, counts) with an explicit instruction to change approach; planner annotation; maintenance refusal reason in the run report.
- Bounds: per-record entry cap, per-prompt section byte cap, no raw payloads/secrets, digest references only. Legacy state round-trips: absence of memory is an explicit absence, never a default.

## Slices

1. Lane + plan (this document). Lane identity recorded below.
2. Contract + store: record schema/parser + state-store collection + snapshot field + round-trip tests (legacy tree without the collection stays readable).
3. Pure policy: fingerprint derivation, equivalence decision, fingerprinted attempt entry update, with named unit cases (equivalent denied; changed evidence admitted; transient allowance bounded; unrelated changes do not reset; malformed inputs fail closed).
4. Capture wiring: trusted settlement appends memory in the same commit as the blocker; matrix ingest failure path included.
5. Decision wiring: hosted retry pass refuses equivalent retries with a precise reason; runtime admission gate consults memory before starting an equivalent attempt.
6. Retrieval: bounded prompt section via the model port composition; planner log/diagnostic annotation.
7. Named local end-to-end scenario: failed attempt -> memory persisted -> next process refuses the equivalent attempt -> changed evidence admits; plus a cell-death capture scenario.
8. Documentation: DECISIONS.md entry + ledger handoff of evidence (not ledger edits by non-Astra owners).

## Lane identity

Recorded per `agents/git-coordination.md`; derived after this file existed.

| Field | Value |
| --- | --- |
| Plan path P | `/home/codex/repos/ubiquity/sentinel/docs/sentinel-memory-plan.md` |
| goal_slug | `sentinel-memory-plan` |
| gid10 | `503a34141c` |
| goal lane / worktree name | `sentinel-memory-plan-g503a34141c` |
| worktree path | `/home/codex/repos/ubiquity/sentinel/.codex-worktrees/sentinel-memory-plan-g503a34141c` |
| branch | `codex/sentinel-memory-plan-g503a34141c` |
| Repository root | `/home/codex/repos/ubiquity/sentinel` |
| Base ref | local `development` (docs commit carrying this plan) |
| Base SHA | recorded in the lane-creation ledger entry at the plan commit |
| Lane state / owner | created; primary (this goal) owns integration |

## Research fold-in — GPT Pro job `9f061de3-37c4-4983-ab73-2ede700cd4cb` (2026-10-09 09:23 UTC)

Verdict of the OpenClaw translation study: keep Git as the authoritative store; add a small trusted memory reducer that records attempts and evidence, rejects disallowed repetitions, and selects from a CLOSED set of safe recovery actions; generate the model's memory view from that state and never let model-written notes become operational authority. The most important durability move is not retrieval: persist an operation intent BEFORE entering a potentially failing planner/runtime operation, and reconcile unfinished operations BEFORE invoking that operation again (this is what actually stops the reported ~14-minute `matrix_plan` loop).

Adopted decisions for this goal:

1. Four identities (do not collapse into one hash): execution ID (target, operation, admission, run/attempt, cell), blocker family ID (target/lane, work scope, failing operation, semantic fault site, normalized reason family), failure signature (family + verified phase + normalized leaf error + causal basis + normalizer version), attempt fingerprint (family + structured intervention + relevant input basis + trusted evidence basis + policy version). Domain-separated hashes over canonical JSON; keep the defining tuple in the record.
2. Causal novelty only: run IDs, attempt numbers, timestamps, model labels, prompt paraphrase, unrelated commits and plan digests must NOT reopen a blocker. Relevant dependency/route/base/intervention changes may, within remaining limits. No hashing of raw sensitive text.
3. Record kinds (target shape): `memory-blockers`, `memory-attempts`, `memory-journals`, `memory-lessons`, `memory-circuits`, all bounded (~2-8 KiB/record), statuses/enums as in the study. Slice 1 here implements a single merged family record (`attempt_memory` collection) as the compatible first step; the store can split kinds later without losing the identity discipline.
4. Capture: durable intent before invocation; stage ring/watermark in cells; preserve the leaf cause through wrappers; `if: always()` sidecar upload; trusted ingest dedupes duplicates, resolves late results, and records `UNKNOWN` leaf status when evidence is genuinely absent (it must say the leaf cause is unknown, never guess).
5. Decisions: an admission returns `ADMIT | ANNOTATE | WAIT | REQUIRE_CHANGE | DENY | ESCALATE`; only ADMIT creates a reservation. Deny unchanged replays after a deterministic failure; allow bounded, classified transient retries under an explicit infra allowance with cooldowns; half-open probes consume allowance; cooldown alone never resets counts.
6. Maintenance: replace bulk refills with single-use grants tied to an intended attempt (grantId, blockerId, intendedAttemptId, reasonCode, evidenceBasisDigest, maximumUses: 1, expiry). Expiration does not replenish allowance.
7. Bounded prompt view: at most 8 relevant entries / 8 KiB, ordered active blocker -> failed approaches -> authorized intervention -> verified lesson; enforcement reads ALL applicable blockers regardless of prompt truncation; give an explicit expected observation, never "try something else".
8. Closed self-healing registry: wait cooldown, re-fetch artifact (3 total attempts), restore preserved candidate, refresh base/rebase, route failover after verified route-specific failure, retry pre-inference startup (consume infra allowance; never label it a tested code strategy), one changed diagnostic execution for opaque failures, escalate. Never automate budget/receipt relaxation, model policy, credentials, evidence synthesis, or promotion.
9. Escalation artifact: bounded `sentinel-blocker.json` (<=16 KiB) + rendered report (<=8 KiB) via the existing incident mechanism and workflow summary; identity, execution, evidence (leaf error or explicit UNKNOWN), attempts, accounting, safety, reopening predicate, one owner action, smallest reproduction.
10. Crash protocol: durable intent -> bounded action -> authoritative observation -> durable settlement; reconcile lost CAS responses by nonce/operation identity; treat reservation expiry as NOT proof of death; bind cells to run_attempt so a stale/rerun plan fails binding instead of re-executing.
11. Phases: (0) compatible readers/contracts; (1) planner-operation guard vertical slice — durable intent, stage/leaf capture, next-run reconciliation, exact-repeat denial, escalation report; gate = local fixture where a dying planner causes the next fresh process to refuse the unchanged invocation; (2) cell settlement + bounded recovery (sidecars, duplicate/late artifacts, circuits, infra allowances, action registry); (3) model continuity (checkpoint notes, deterministic lessons, failed-attempt prompt context, stuck predicates — OpenHands-style, adapted); (4) optional local lexical retrieval only if exact lookup demonstrably misses useful advisory context. No embeddings, vector service, LLM consolidation job, or extra reviewer initially.
12. Pitfalls mitigation: applicability + supersession for stale memory; causal projections for false equivalence; validated intervention for false novelty; claimed-vs-verified authority for model-written notes; skip-before-admission + fair selection against starvation; target-scoped filtering against leakage; positive allowlists and bounded references against secrets; fixed caps + completion-space reservation against bloat; defining-tuple comparison against hash collisions; exact plan/request bindings against obsolete verdicts.

Mapping to the current implementation slice (this lane):

- Slice 1 implements the family-level attempt memory (`attempt_memory`), deterministic closed classification, settlement-time capture, maintenance-grant refusal with explicit denial reporting, and append-only store guards. It is the Phase-1 core restricted to the maintenance grant path.
- Provisional behavior to tighten in Phase 2: a runtime revision change currently counts as changed evidence (a new generation is usually a deployed fix). The study's stricter rule ("unrelated SHA must not reset learning") needs the validated causal-change witness first.
- Provisional policy numbers in code (`DEFAULT_ATTEMPT_EQUIVALENCE_POLICY_V1`): semantic no-progress tolerates 1 identical repeat then refuses; unknown tolerates 0 then refuses; transient infrastructure tolerates 3 identical repeats then refuses, with a 6-hour decay window. The study's tighter targets (0 unchanged replays; 3 distinct strategies; 2 infra admissions) require the structured-intervention/strategy-slot model, which is the Phase-2 upgrade; adopting the tighter numbers now would block the runtime's existing multi-attempt ceiling without the machinery to distinguish strategies.
- Overlap note: the active `codex/supervisor-rung67-20261009` lane is implementing historical-matrix uncertainty maintenance for the same planner loop. This lane must not duplicate that work; the planner-operation guard (Phase 1) is the follow-up to record and assign deliberately, not to race.

## Progress checkpoint (update in this lane only)

- 2026-10-09 09:03 UTC: lane `sentinel-memory-plan-g503a34141c` created from `eab05752da35f060790efb62573a59f67740a68e` (the docs commit carrying this plan).
- Research complete at 09:23 UTC: GPT Pro job `9f061de3-37c4-4983-ab73-2ede700cd4cb` (answer retained at /tmp/gpt-pro-sentinel-memory-answer.txt); study folded into this plan above.
- Slice 1 implemented on the lane (uncommitted at first checkpoint; committed after verification):
  - Contracts: `src/contracts/attempt-memory.ts` (AttemptMemoryRecordV1, strict parser, domain-separated canonical id/fingerprint derivation, bounded merge with count-carrying fold) + `MaxItems.attemptEntries = 16` in validation.
  - State: `attemptMemory` collection in `state-snapshots.ts`, `state/mod.ts` (collection map, record files, read assembly, append-only transition guards), `transitions.ts`/`budget/mod.ts`/`loop.ts` seed+draft paths, `ops/issue48-recovery.ts`, `ops/issue48-review-quota-recovery.ts`, `src/host/actions.ts` seed.
  - Policy: `src/repair/attempt-policy.ts` (closed detail classification, per-class tolerated counts with transient decay, latest-entry refusal check, settlement mutation factory).
  - Capture: `settleFailedImplementation`, `handleModelReceipt` incomplete path, `handleImplementationUncertainty` persist the memory entry in the same state commit as the blocker; matrix interrupted-output detail reuses the shared constant.
  - Decision: `planHostedRetries` refuses an equivalent work-returning grant (base-advance exempt), reports `retry:<id>:denied:<reason>` through the maintenance actions, and is covered by two new tests.
  - Tests: new `tests/contracts/attempt-memory_test.ts` (6), `tests/repair/attempt-policy_test.ts` (4), state round-trip/transition-guard test, 2 retry-memory tests in `tests/host/hosted-autonomy_test.ts`.
- Verification evidence (2026-10-09): `deno task check` green; contracts+state+budget suites 223 passed/0 failed (2m6s); focused memory suites 18 passed/0 failed; all 17 previously-failing `tests/repair/loop_test.ts` cases green after the seed fix (batches: 8 passed 2m42s, 6 passed 3m14s, plus generated/cache-only 17s); `hosted-autonomy_test.ts` full run 69 ok/0 failed before the 300s bound, remainder running in a second bounded command; `deno fmt`/`deno lint` clean on the changed files.
- Tail-test status (final for this session): `tests/host/hosted-autonomy_test.ts` is 75/77 confirmed green on candidate `a862571e8`, 0 failures observed. The 69-test main run plus three bounded historical batches retired every heavy "historical quarantine" test except two — `historical release witness: refusal and partial CAS retry preserve exact charged custody` (was running when its window expired) and `historical newer current: unfinished foreign unavailable or drifting current cannot write` (never started). Both are pre-existing tests touched only by the mechanical fixture insertion; treat them as pending-from-bounded-window, and let repository CI confirm them at integration.
- 2026-10-09 10:48 UTC — INTEGRATED: the lane was merged into canonical `development` as `ceda0e5c0` (ancestry-preserving merge of `codex/sentinel-memory-plan-g503a34141c` at `4925ecb41`) and pushed to `origin/development`; the integrated candidate's `deno task check` is green and the merged tree is byte-identical to the verified lane tree. Still deployment-gated: making the capability live requires (a) a runtime revision install carrying `src/**` and (b) promotion of `ops/hosted-autonomy.ts` to the protected launcher ref — both separate, approval-gated steps outside this objective's lane proof. The two heavyweight legacy quarantine tests remain bound-infeasible locally and execute at the next repository test-local/CI run.
- Integration status: MERGED into development as `ceda0e5c0`. The concurrent `codex/supervisor-rung67-20261009` lane changes the same shared files (`loop.ts`, `matrix.ts`, `ops/hosted-autonomy.ts`, `state`), so integration must be a deliberate rebase-and-merge by one writer after that lane settles.
- 2026-10-09 10:07 UTC — second slice committed on the lane: retrieval into planner admission and model prompt, plus the named end-to-end scenario.
  - Planner admission: `planMatrixWave` consults durable attempt memory before any grant; an equivalent attempt at the same base and runtime revision is skipped with nothing charged, and `MatrixPlanReportV1.memoryRefused` makes the refusal observable. Base moves, runtime revisions and the transient decay window re-open admission.
  - Model prompt: `ModelRunRequestV1.priorAttempts` (bounded verified facts, optional; strict parser updated) is filled from memory for the current approach generation and rendered by the model port as an "ALREADY TRIED — VERIFIED FACTS" section with an explicit expected-observation instruction. Evidence, never permission.
  - Named end-to-end scenario (`tests/host/memory-loop-breaker_e2e_test.ts`): four REAL admission/settlement rounds on a disposable Git state store (RollingStartBudget + prepareImplementationStart + settleFailedImplementation) record four equivalent transient outcomes; a fresh store instance then refuses the unchanged fifth attempt and reports `equivalent_attempt_refused:`; the refusal charges nothing and leaves the head unchanged; an unrelated blocked record is still granted its retry (fairness); memory stays bound to the old base so a genuine base move re-opens.
  - Verification: `deno task check` green; 18/18 focused tests (matrix runtime full suite, attempt policy, runtime prompt cases, the e2e) in 58s; fmt/lint clean.
- 2026-10-09 10:22 UTC — third slice committed on the lane: stage diagnostics at settlement + the stored lesson digest.
  - Stage diagnostics: `settleFailedImplementation` accepts an optional trusted classification (stage + failure class); the matrix ingester classifies each non-completed cell result from structured facts — `not_started`/pre-start binding refusals are pre-inference infrastructure (stage reservation, transient), `model run failed (...)` is stage model, `candidate bundle ...` is stage candidate. The policy's closed detail table gained the same trusted producer families (with the stored detail kept verbatim), so a provider outage can no longer be misclassified as an unknown one-shot failure at settlement.
  - Lesson digest (the curated-memory analog): new `memory_lessons` collection, one deterministic record per repository, recomputed by every trusted transition from authoritative attempt memory, with a builder version and a source-set digest; entries carry task/base/count/stage/class and an explicit `refused` flag when the equivalence policy currently refuses an unchanged replay. It is a bounded VIEW (16 entries), never an authority; source records stay complete.
  - Tests: memory-lessons suite (determinism, source-digest tracking, refusal flag, bounds); matrix-runtime stage assertions on a settled interrupted run; the e2e now also asserts the stored lesson record flags the exhausted family; state round-trip writes/reads memory + lessons through the real store. Verification: 52 passed/0 failed (core batch) and 360 passed/0 failed (contracts+records fixtures updated for the new required collection key); fmt/lint clean.
- 2026-10-09 10:46 UTC — verification sweep for slices 1–3 on candidate `9990c4bd6` (plus slice-1 candidate `a862571e8` where noted):
  - `tests/repair/loop_test.ts`: 96/96 green across bounded windows (21 in the first window before an external SIGTERM, then windows of 25/26/25 by filter, plus named-case follow-ups), 0 failures. One window was SIGTERM'd mid-run by the host (a Muse supervisor workload also runs here); the split re-runs completed green.
  - Memory suites: memory-lessons (3), attempt policy (6), matrix runtime (8), the named e2e (1) and the state suite all green; contracts+budget+github 360/0 (the repair-snapshot fixtures gained the required `lessons` key); hosted retry-pass memory cases green against the final candidate.
  - `tests/host/hosted-autonomy_test.ts`: 75/77 green against `a862571e8`; the two heaviest "historical quarantine" tests (`historical release witness: refusal and partial CAS retry…`, `historical newer current: unfinished foreign unavailable or drifting current cannot write`) individually exceed the 300-second local command bound (>4m45s for the single test) and are recorded as CI-covered at integration rather than run outside the bound.
- Next: (1) rebase-and-merge this lane once the rung67 lane settles (shared files: loop.ts, matrix.ts, model-port.ts, ops/hosted-autonomy.ts); (2) Phase-1 planner-operation intent durability + next-run reconciliation (coordinate, do not duplicate rung67); (3) circuits/journals and the escalation artifact per the folded study; (4) serial-path admission defence-in-depth if a re-entry path without the maintenance pass is later proven.

## Constraints

- No new secrets/env vars; runtime model policy unchanged; review/budget/promotion gates unchanged.
- No paid/model/network calls in the local harness; fake external transports only.
- One writer per surface; cells never write state; sanitized minimal records only.
- Local validation follows AGENTS.md "Fast local development": focused files first, 300-second bounded commands, one named end-to-end scenario, no whole-repository sweeps.
- Hosted dispatch requires explicit user approval per attempt; this plan does not request one.

## Live deployment checkpoint — 2026-10-09 12:45 UTC (awaiting owner approval)

The memory/loop-breaker is staged for the LIVE hosted runtime as generation 68 under the protected installer:

- Pinned runtime revision: `33a962978036d85e21ea42440bf14ead258ccf54` (live supervisor lineage merged with the durable-memory lane, all fixtures/custody/lint reconciliations included). Its `test-local` check is `completed/success` (API-verified the same way the installer verifies it).
- Launcher lane tip: `8bf6a0833` (`codex/memory-live-20261009`) pins generation 68 = that revision, with the standard rung: healthy generation 67 installs 68; a failed 68 restores generation 67 once at generation 69 (terminal).
- Fast-forward gates verified: `origin/sentinel-supervisor` (`36458206a`) and `origin/development` (`5a84c15dc`) are both ancestors of the lane tip.
- The publish+dispatch one-shot (push lane tip to `sentinel-supervisor` and `development`, then `sentinel run supervisor`) is blocked only on explicit owner approval; the platform's safety review rejects protected-ref publication without it. Once approved: installer verifies the pinned revision, installs generation 68, bootstrap-verifies, and memory becomes live for settlements, planner admission, prompts and the (re-enabled) maintenance retry guard.

## LIVE — generation 68 deployed and healthy (2026-10-09 18:36 UTC)

Owner approved the deployment ("Go"). Executed:

- Published `9154ca03c` (lane tip) to `sentinel-supervisor` and `development`; the pinned revision is `335727744517fab37fa9939da49366c9b315207b` (CI `test-local` green).
- Dispatched `sentinel run supervisor` (run `37969475526`): `prepare` installed generation 68 via the owner-development installer (`owner_development_install status=installed`, prior gen 67 `ee5e6518a` → candidate gen 68 `335727744`); the bootstrap execution completed SUCCESS and its healthy proof is recorded (`lastHealthyProof: healthy, revision 335727744, generation 68, runId 37969475526`).
- The next scheduled ordinary run (`37973386031`) is already executing at generation 68 on the protected ref, i.e. the live matrix runtime now carries durable attempt memory (settlement capture, planner-admission refusal of unchanged replays, verified prior-attempt facts in the implementer prompt, deterministic lesson digest) and the maintenance-side refusal guard for when that pass is re-enabled.
- First live learning records appear in `sentinel-state/repair` (`attemptMemory/`, `lessons/`) as implementation attempts settle; the runner script `/tmp/check-memory-live.sh` summarizes them.
