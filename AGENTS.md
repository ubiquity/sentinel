# Sentinel project instructions

Read [MASTER-PLAN.md](MASTER-PLAN.md) and [docs/DECISIONS.md](docs/DECISIONS.md) before changing behavior. The recorded canonical goal and module lane identities are invariants. Preserve unrelated, dirty and user-owned work. Global instructions and their routed procedures still apply.

## Architecture and authority

- Use Deno and TypeScript. Define shared contracts before independent implementation; shared contracts and cross-module wiring have one owner.
- Use isolated concurrent issue workers, one trusted state/integration coordinator and a separate deterministic release controller with exclusive promotion ownership.
- Artificial hourly/weekly model-start, unfinished-PR, review-concurrency and review-drain caps are lifted. Preserve durable reservations/settlement for implementation, review, retry and continuation starts. Provider/platform limits and configured session/deadline safeguards remain.
- Sentinel's protected supervisor is dispatched autonomously every five minutes (`supervisor-dispatch.yml`; owner directive 2026-10-07, commit `5aac94da8`, "Make it fully autonomous"); `observe.yml` and `repair.yml` remain manual through the installed `sentinel` CLI (`ops/sentinel-cli.ts`). Keep `sentinel-release` disabled as part of development.
- Preserve runtime implementation policy `gpt-5.6-luna` with max reasoning. Supported trusted route aliases/configuration are documented in DECISIONS.md; local worker selection cannot change production policy or claim a live route.
- Keep credentials, authoritative state writes, live admission changes and promotion authority out of model workers. Use the existing trusted supervisor and exact execution/pointer proofs.
- Commit only sanitized minimal regression fixtures. Restricted originals, raw diagnostics and credentials remain outside public Git and model checkouts.
- Never add Sentinel branch protection rules or branch rulesets, or recreate deleted rules.

## Development and runtime review

Development changes require no development PR or Codex review. Make the scoped change, immediately test it and deliver directly. This does not waive autonomous runtime target PR review, CI or merge gates.

Never post `@codex review` or invoke the hosted Codex GitHub app. The internal structured reviewer (`codex-auto-review` through the runtime review service) is the only runtime target review path. Runtime code changes require a completed current-head receipt with no unresolved P0/P1, passing current CI and applicable target branch protections before autonomous merge. Missing/stale/unavailable evidence cannot pass. Non-runtime-only changes do not request Codex review.

Do not edit the vendored upstream rubric constant in `src/github/codex-review-rubric.ts`. The attached harness schema overrides its output-format section; retain its upstream pin/hash and Sentinel read-only boundary. See [the alignment note](docs/codex-review-rubric-alignment-2026-10-08.md).

## Fast local development

- Use local reproduction and checks as the edit/test loop; hosted CI and live Sentinel runs are separate acceptance surfaces. Read existing failure evidence once and keep independent local work moving.
- Before editing, identify the changed module, affected callers/contracts and smallest observable failure. Prove the actual defect before the fix when a regression is useful; permission, type, dependency, dirty-checkout and timeout errors are setup failures.
- After a meaningful edit, run applicable file-scoped static checks and the smallest relevant named test, then its affected module/consumer boundary. Preserve declared Deno permissions. Do not default to `deno task test`, `test:integration`, `test:local` or an equivalent whole-repository sweep.
- Enforce a 300-second deadline on every task-owned local validation command, including final acceptance, with bounded process-group teardown. Register the bounded command through the existing evidence tool and retain command, status, elapsed time, exact candidate/diff and output reference. These bounds do not authorize terminating model sessions, shared services or other owners' processes.
- Observe running checks at intervals of at most 30 seconds. After 60 seconds without a completed case or concrete output, inspect the active case/command/children and narrow or repair the check. A live PID or elapsed time is not progress; never repeat an unchanged failure.
- Exercise production code through real consumers with fake external APIs/model ports, temporary Git/state and injected clocks. Advance retry/cooldown/observation time in tests. No paid/model calls, GitHub writes, credentials or deployment belong in the local harness.
- Validation order is failing local case, repaired case, affected module, directly affected integration boundary, then one named target-specific local lifecycle scenario on the same integrated candidate. Reuse connected evidence when it already covers that lifecycle; only add the missing boundary. Whole-repository sweeps need the user's explicit request for that workload. Documentation-only changes need documentation checks.
- Before publication, check cheap current file-size/static constraints on the exact candidate and its current-base merge input wherever CI tests that merge. Reuse unchanged-input evidence; this is not a new whole-suite gate or policy ceiling.

### Hosted approval boundary

Every development-triggered hosted end-to-end or runtime/supervisor dispatch, retry or rerun requires explicit user approval for that identified attempt. A request to implement, fix, finish, test or deliver, and old activation/continuation permissions, do not grant this approval.

First complete the locally reviewable candidate and checks. For approval, identify the exact workflow, target, SHA, expected duration and remaining hosted-only assertion. One approval covers one attempt; retries and changed candidates need fresh approval. Do not bypass this boundary through API/CLI calls, triggering pushes, alternate workflows, forced eligibility or live invocation. Read-only existing CI evidence may be inspected.

If an approved attempt fails, retain its logs, reproduce/fix locally and repeat only affected validation. If reproduction needs the hosted environment, identify the exact gap and smallest hosted-only probe for approval. Keep local and hosted verification separate; pending approval is not live acceptance. Include this boundary in worker assignments and continuations, and reread current rules before dispatch.

## Ownership and acceptance

`docs/build-status.md` is the single authoritative task and acceptance ledger. Only the current GPT-6 Astra integration owner may edit it or change scope, status, acceptance, evidence disposition or write ownership. Other workers return evidence and proposed updates; they do not create another authoritative task list.

A fresh integration owner reads the active register first and reconciles exact Git/process ownership, reservations, current refs and existing evidence before writes. READY, elapsed time and cached success do not establish integration or acceptance. Integrate, reject or assign a concrete owner/next action to ready work promptly; preserve original goals and accounting.

Before a major milestone or resuming after repeated failure/no useful progress, obtain a read-only audit from a fresh GPT-6 Astra agent without inherited worker history. Supply the authoritative task, exact candidate diff and evidence references. The owner records its independent pass/corrections/blocker; the auditor does not become another writer. Do not request an audit per edit or a development Codex review.

Use recorded module scopes and explicit isolated ownership. DSH workers do not commit or push; the primary validates, commits and integrates with accepted ancestry preserved. Freeze writers for final validation and acceptance. The canonical lane and shipped branch must contain accepted worker tips.

Reconcile and explicitly transfer target ownership before live writes. Never run Sentinel against a target still owned by the embedded prototype. Exact candidate/prior revision identity, verified promotion, objective acceptance and exact rollback are mandatory. Never select revisions by time or list order; preserve the target's Cloudflare 403 policy and current VPS/Deno receipt distinction.

Separate local checks, reviewed code, merged code, installed runtime and live delivery proof. Health/bootstrap/workflow success alone is not issue delivery. Report genuine unresolved boundaries and one concrete next action, with concise checkpoints rather than unchanged polling or full historical dumps.
