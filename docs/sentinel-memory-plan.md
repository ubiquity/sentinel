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

## Constraints

- No new secrets/env vars; runtime model policy unchanged; review/budget/promotion gates unchanged.
- No paid/model/network calls in the local harness; fake external transports only.
- One writer per surface; cells never write state; sanitized minimal records only.
- Local validation follows AGENTS.md "Fast local development": focused files first, 300-second bounded commands, one named end-to-end scenario, no whole-repository sweeps.
- Hosted dispatch requires explicit user approval per attempt; this plan does not request one.
