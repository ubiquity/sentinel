# Sentinel project instructions

Read MASTER-PLAN.md in full before implementation. Its recorded canonical goal
identity and isolated worker lanes are invariants. Preserve unrelated work.

## Design

- Implement the minimal polling design: one production implementation writer,
  plus a separate deterministic Deno release controller with exclusive release
  ownership. Parallel development workers do not imply parallel runtime agents.
- Use Deno and TypeScript. Define shared contracts before parallel implementation.
- Keep model admission behind durable rolling-hour and rolling-seven-day limits;
  review requests, retries and continuations count. No quota/model fallback.
- Preserve runtime implementation model gpt-5.6-luna with max reasoning. Local
  DSH implementation follows the current global deepseek-harness.md playbook;
  it cannot change the runtime model policy.
- Keep credentials, state writes and promotion authority out of model workers.
- Commit only sanitized minimal regression fixtures; original payloads and raw
  diagnostic evidence remain restricted artifacts.
- Do not implement recursive controller modification or autonomous bootstrap
  activation in the first version.

## Development and review

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

## Ownership and acceptance

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
