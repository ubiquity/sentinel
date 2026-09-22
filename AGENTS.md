# Sentinel project instructions

Read MASTER-PLAN.md in full before implementation. Its recorded canonical goal
identity and isolated worker lanes are invariants. Preserve unrelated work.

## Design

- Implement the minimal polling design: one production implementation writer,
  plus a separate deterministic Deno release controller with exclusive release
  ownership. Parallel development workers do not imply parallel runtime agents.
- Use Deno and TypeScript. Define shared contracts before parallel implementation.
- During development, cap shared model admission at 120 starts per rolling hour
  with no weekly cap, as directed on 2026-09-15. Preserve durable reservations;
  review requests, retries and continuations count. No quota/model fallback.
- Sentinel runs as a cron-triggered GitHub Actions job.
- Preserve runtime implementation model gpt-5.6-luna with max reasoning. Local
  DSH implementation follows the current global deepseek-harness.md playbook;
  it cannot change the runtime model policy.
- Keep credentials, state writes and promotion authority out of model workers.
- Commit only sanitized minimal regression fixtures; original payloads and raw
  diagnostic evidence remain restricted artifacts.
- The owner authorized local Sentinel self-repair and initial activation on
  2026-09-11. Require reviewed PRs and an external trusted supervisor; model
  workers cannot modify live admission policy, credentials, state or promotion
  authority. See the scope update in MASTER-PLAN.md.

## Development and review

- Owner update, 2026-09-16: no development pull requests or Codex reviews.
  Make the scoped change, test it immediately, then deliver it directly.
  This supersedes development acceptance-review and PR requirements below.
  Autonomous target repairs retain their existing PR, review and merge gates.

- Never add branch protection rules or branch rulesets to this project.
  Do not recreate deleted protection rules.

- Follow the owner's instruction to defer Codex review to integrated acceptance.
  Do not request Codex review for every module, small edit or internal merge.
- Run focused deterministic checks during development. Integrate worker results
  with ancestry-preserving merges on the canonical lane.
- At acceptance, validate the exact integrated candidate, then obtain a Codex
  review. Fix substantive P0/P1 findings and review the changed candidate again;
  do not reuse a review for different bytes or merge on exhausted review budget.
- Runtime target PRs still require completed current-head Codex review with no
  unresolved P0/P1, passing CI and target branch protections before autonomous
  merge. Waiting consumes no agent slot. These runtime reviews consume the
  configured shared model-start budget.
- The old ai.ubq.fi non-gating review policy does not apply to this new project.
- Do not create or publish a GitHub repository or choose its visibility based
  solely on the local planning setup. Record that deployment choice separately.

## Fast local development — owner update, 2026-09-21

This section governs coding-agent development, debugging and target onboarding, and supersedes earlier instructions to wait for hosted acceptance while developing. Autonomous production target PRs retain their existing CI, review and merge gates; this policy does not disable scheduled production operation.

- Never use hosted CI or a live Sentinel run as the edit/test loop. Never wait for CI to discover the next fix when the affected path can be exercised locally. Read existing failure evidence once, reproduce the failing boundary locally, and keep independent local work moving while a previously authorized hosted run is pending.
- Before editing, identify the changed module, its directly affected callers/contracts and the smallest observable failure. Use an existing focused test or add a minimal regression when useful; prove the intended failure before the fix. For a new target, exercise actual selection, target-specific Git objects, token/repository scope, candidate restoration/publication and shared admission/deadline handling with distinct temporary repositories and injected external transports. Keep the working self-target as a regression control.
- After each meaningful change, run file-scoped formatting/lint/type checks and the smallest relevant test file or named case, then the affected module. Use the repository's declared Deno permissions and test setup, narrowed to explicit paths; a wrong invocation is not a product failure. Do not default to `deno task test`, `deno task test:integration` or `deno task test:local` after every edit: they expand the workload.
- Enforce a 300-second deadline on each local validation command, including final acceptance; aim for under one minute per focused case. Use an installed process-group timeout or the runner's supported deadline with bounded teardown, retain timeout/failure output, and verify test children have settled. Register the bounded command through the existing evidence tool. This bounds task-owned tests, never DSH/model sessions, shared services or another owner's processes. If a useful check cannot fit, split or repair that check before launching it; a longer whole-repository sweep requires the user's explicit request for that separate workload. Never silently raise the deadline.
- Observe a running check at intervals of at most 30 seconds; never issue multi-minute `write_stdin` waits or sleep/poll loops. If 60 seconds pass without a completed case or other concrete output, inspect the active case, command and child process immediately. A live PID, elapsed time or changing temporary directory is not useful test evidence. An overrun is an incomplete check to diagnose and narrow, not permission to keep waiting for the suite's eventual verdict or claim a pass.
- Local tests must exercise production code through its real consumers, using fake external APIs/model ports, temporary Git/state and injected clocks. Advance retry, cooldown, polling and observation time in tests; do not sleep through production intervals or shorten production safeguards to speed a test. Keep credentials, paid/model calls, GitHub writes and deployments out of the local harness. A helper-only test does not prove cross-module wiring.
- Validation order is: failing local case → repaired case → affected module → directly affected integration boundary → one named, target-specific local end-to-end scenario on the integrated candidate. That final scenario must exercise the changed lifecycle through real production consumers with fake external services and fit the same 300-second command limit. It is not an exhaustive repository sweep: do not automatically run `deno task test:local`, unfiltered `deno task test`, `test-local.ts`, or a renamed equivalent as "final-local" or "E2E". Those whole-repository workloads need the user's explicit request; final acceptance wording alone is not that request. If the existing connected tests already prove the changed lifecycle on the same candidate, reuse that evidence instead of adding another run. If they miss a boundary, add or run only that missing scenario. Keep hosted/runtime release gates separate and report their pending status honestly. A documentation-only change needs documentation checks, not the runtime harness.
- A regression's before-fix failure must demonstrate the actual defect. Type errors, missing permissions, dirty checkout guards, unavailable dependencies and timeouts are setup failures, not proof of wrong repository routing or other product behavior; correct the invocation and narrow the case without expanding into a full sweep.
- If any stage fails, narrow back to the failing case, diagnose the failure class and check adjacent affected steps before retrying. Do not repeat an unchanged failure or restart the full suite to recover logs. Reuse existing evidence for unchanged inputs; after a fix, rerun affected checks and repeat final integration only when the changed behavior invalidates it. Capture exact command, exit status, elapsed time, candidate revision/dirty diff and saved output reference.

### Hosted end-to-end approval boundary

- Every development-triggered hosted end-to-end or Sentinel runtime/supervisor dispatch, rerun or retry requires explicit approval from the user for that attempt. Default to local, fast, module-scoped checks. A request to implement, fix, finish, test or deliver does not authorize a hosted end-to-end run; earlier broad activation/continuation authority does not override this boundary.
- First finish the locally reviewable candidate and its applicable checks. Then identify the exact workflow, target, candidate SHA, expected duration and the remaining hosted-only assertion for approval. Approval covers one identified attempt; a retry or changed candidate needs fresh approval. Never turn one approval into an automatic fix/dispatch/wait loop.
- Do not bypass this boundary with an Actions API call, `gh workflow run`, `gh run rerun`, a push intended to trigger the same end-to-end run, an alternate workflow, forced schedule/eligibility, or a live-runtime invocation. Existing scheduled operation is not a substitute development test. Read-only inspection of existing CI evidence is allowed; do not cancel unrelated runs or weaken runtime merge gates.
- If an approved hosted run fails, retain its logs, reproduce and fix the defect locally, and return to the local validation sequence. If a failure cannot be reproduced offline, state the exact environmental gap and propose the smallest hosted-only probe for explicit approval. Report local verification and hosted verification separately; pending approval never justifies claiming live acceptance.
- Include this policy in coding-worker assignments and continuations. Re-read the current project rules before any hosted dispatch; an older handoff is not approval. Apply updates to already-running workers at the next supported steering or settled handback boundary, preserving their work.

## Ownership and acceptance

- `docs/build-status.md` is the single authoritative task and acceptance ledger.
  Only the current GPT-6 Astra integration owner may edit it or change task
  scope, status, acceptance, evidence disposition, or write ownership. Luna,
  DSH, runtime agents and other workers return evidence and proposed updates;
  they must not modify the ledger or create a competing authoritative task list.
- A fresh Astra session reads the active task register first, reconciles exact
  Git/process ownership and evidence, then records its verification before
  resuming writes. Worker READY, elapsed time and cached test success do not
  establish integration or acceptance. Read existing evidence before rerunning.
- A repeated unchanged failure or a checkpoint with no useful progress requires
  diagnosis and an updated next action before another assignment on that task.
  Preserve the existing lane and partial work. Record the cause and evidence so
  a fresh Astra can verify it without repeating the same investigation.
- These are agent ownership rules, not an operating-system access restriction.
- Before accepting a major milestone, or resuming a task after repeated failure
  or a checkpoint with no useful progress, obtain a read-only audit from a fresh
  GPT-6 Astra agent without inherited worker conversation history. Give it the
  authoritative task, exact candidate diff and existing evidence references.
  It must verify scope and acceptance independently and report pass, required
  corrections or a concrete blocker. The integration owner records the result;
  the auditor does not become a second writer. Do not request an audit per edit.

- Use the plan's module scopes; shared contracts and cross-module wiring have
  one owner. DSH workers do not commit or push; the primary validates and commits
  their changes under the global DSH playbook.
- Reconcile and explicitly transfer target ownership before live writes. Never
  run this Sentinel against a target already owned by the embedded prototype.
- Exact Deno candidate/prior revision identity, verified promotion, objective
  acceptance and exact rollback are mandatory. Never select a revision by time
  or list order. Observe the target's Cloudflare 403 handling policy.
- Separate local tests, reviewed code, merged code, deployed runtime, and live
  delivery proof. Do not report completion on module tests alone.
- No paid/model calls, GitHub writes or deployment inside the local test harness.
