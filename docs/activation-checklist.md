# Sentinel activation checklist

Status: the implementation candidate is accepted by the local receipt, while
the published branch currently has a failing CI run; the m06 target integration
is merged and deployed by the existing target workflow, but standalone
activation is blocked pending the owner decisions below. This checklist is
subordinate to
[MASTER-PLAN.md](../MASTER-PLAN.md) and records the boundary between local
proof and external activation.

## Current verified state

- Canonical lane: `/Users/nv/repos/ubiquity/sentinel/.codex-worktrees/master-plan-gfa795549e5`
  on `codex/master-plan-gfa795549e5`.
- Canonical tracked HEAD: `2f46e1889166c2f9c4a2a92b312cd6e28acb81a1`; the
  last implementation candidate is `dde125febf4ef31f31764804f01f2934a4a15d00`.
- Local receipt: `deno task test:local` passed 683 tests across 68 steps at the
  implementation candidate, with formatting, lint and type checks passing.
  Later tracked commits are documentation and harness type-check-list changes;
  the uncommitted observer slice listed below is not covered by this receipt.
- Observer candidate receipt: the task-owned run
  `cc48556d9d6816f2605c36c352452867e2de5be694f7aa26c8a9330e9268c576/857ecd94-e002-46e8-9a23-8e90b4771dab`
  executed `deno task test:local` at tracked revision
  `2f46e1889166c2f9c4a2a92b312cd6e28acb81a1` with the uncommitted observer
  files present. It failed after 686 passing tests across 68 steps in 19m46s;
  `tests/repair/loop-guard-runtime_test.ts` ended with a pending promise.
  This candidate result is not source acceptance and does not change the
  accepted implementation receipt above.
- Published CI receipt: run `34298852376` (`sentinel-ci`) at exact head
  `2f46e1889166c2f9c4a2a92b312cd6e28acb81a1` failed its `test-local` job after
  682 passing tests. `tests/replay/runtime_test.ts:167` expected 128 bytes but
  received 1 byte in the output-cap test. The remote deterministic CI gate is
  unresolved; the failure is separate from the observer candidate run.
- Target producer/consumer receipt: m06 target lane
  `a702d4ddb6a8bcbf549653cc75596b3d74715102` passed the fresh cross-repository
  probe recorded in `docs/build-status.md`.
- Target repository: `ubiquity/ai.ubq.fi` is public. PR #258 merged at
  `2026-09-09T01:05:39Z` from exact target base
  `0a1336945116cb47e2f1c62147d5d8514dd4994b` and m06 head
  `a702d4ddb6a8bcbf549653cc75596b3d74715102` to target `development` merge
  SHA `7b93b579eecf5392730453f1407a66a552fd7c48`.
- Existing target Deno Deploy run `34297770624` (attempt 1) succeeded at that
  merge SHA and uploaded an exact-build receipt for project `ai-ubq-fi`,
  revision `h73heqdd4js7`. A read-only probe at
  `2026-09-09T01:30:12Z` returned HTTP 200 from both the managed and custom
  health routes, with body and headers matching that SHA and revision.
- The target's embedded `provider-sentinel.yml` workflow is absent. Its
  existing `deno-deploy.yml` workflow still owns deployment and promotion;
  standalone release ownership has not been handed over.
- Scheduled workflows remain fail-closed. They call the direct tasks, which
  reject execution without an injected trusted host. No standalone external
  capability, model, release, target write or activation is active; the target
  deployment and Sentinel repository publication are recorded as external
  evidence above.
- An uncommitted observation slice is present in the canonical worktree:
  `src/observe-main.ts`, `tests/integration/observe-host_test.ts`, and task
  wiring in `deno.json`/`test-local.ts`. Its recorded full-harness check
  failed, so it has no passing acceptance receipt and is preserved outside the
  source candidate; it introduces new protected environment names and a
  24-hour local default retention that are not owner decisions.
- The public repository `ubiquity/sentinel` now exists. Its canonical branch is
  published at `2f46e1889166c2f9c4a2a92b312cd6e28acb81a1`, while remote
  `development` remains at `9da7f77b0082bd9c0453204215cf65323b2884a6` with no
  aggregate Sentinel PR or merge.
- A local untracked `sentinel-observe` workflow is present with the observer
  slice. GitHub reports only `sentinel-ci` for this repository, so the observer
  workflow is not active or published. It proposes authenticated read-only
  `ai.ubq.fi` evidence intake and one-day encrypted-artifact upload, pending
  review and owner approval.

## Owner decisions required before activation

| Decision | Required value or evidence | Current state |
| --- | --- | --- |
| Sentinel publication | Repository name, visibility and publication authority | Public `ubiquity/sentinel` exists and the canonical branch is pushed; remote `development` is still `9da7f77…` with no aggregate PR or merge |
| GitHub access | Existing GitHub App installation and target-admin scope, with a trusted host source | Unresolved; do not create a new secret or environment variable |
| Deno access | Existing Deno Deploy project and promotion-token scope | Target workflow access is evidenced by run `34297770624`; standalone trusted-host scope remains unresolved; do not copy a token into a worktree or model session |
| Model admission | Global rolling-hour and rolling-seven-day start caps, session bounds and receipt policy | Unresolved; runtime policy remains gpt-5.6-luna with max reasoning |
| Evidence retention | Owner-approved retention duration, storage bound and key capability | The uncommitted observer candidate proposes a one-day encrypted upload and protected 32-byte `SENTINEL_REPLAY_KEY_B64`; no observer run is active, and durable retention remains unresolved because the target's current 48-hour capture TTL is insufficient for weekly waits |
| Stability policy | Metrics, denominator, baseline/window, minimum samples and thresholds | Unresolved; the local controller requires 30-minute acceptance with 30-second samples |
| Target ownership | Drain and handover of the embedded Sentinel writer and Deno promotion writer | Embedded workflow is removed and capture/export/build seams are owner-approved; existing Deno promotion writer and stale PR ownership still require explicit handover; do not run two writers against the target |
| Review and build receipts | Machine-verifiable completed review output and exact build receipt contract | Exact build receipt exists for run `34297770624`; PR #258 still has overall `CHANGES_REQUESTED` from CodeRabbit and its Codex result is `COMMENTED`, so a clean current-head acceptance receipt remains unresolved |
| Isolated release environment | Disposable target and rollback endpoint for the pre-live promotion drill | Unresolved |

## Activation sequence after decisions

1. Reconcile the target owner, current leases, remote heads and existing
   promotion workflow. Record target base `0a133694…`, merge `7b93b579…`, the
   removed embedded workflow, stale PRs #251/#233, and the explicit Deno
   promotion handover.
2. Supply the already-approved capabilities to one trusted host composition and
   replace the inert workflow invocation only after the capability checks pass.
3. Publish the integrated Sentinel candidate, obtain a clean current-head
   review, and bind the merged m06 regression and build receipt to exact
   commits.
4. Run the isolated Deno promotion, continuous acceptance and exact rollback
   drill. Preserve the prior revision identity and prove restoration.
5. Enable target repairs, starting with read-only discovery and retained
   evidence. Record the first and second distinct eligible deliveries in order.
6. Start the six-hour observation window only after the live receipts are
   verified, then record continued eligible selection and any rollback result.

Until those values and receipts are supplied, keep the direct workflow tasks
fail-closed. Do not guess limits, retention, thresholds, credentials, revision
selection or ownership, and do not treat local fixtures or injected transports
as live delivery proof. The uncommitted observer candidate is inert until it is
reviewed and explicitly published; it cannot start repair or release work.
