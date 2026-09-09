# Sentinel activation checklist

Status: offline implementation accepted; activation is blocked pending the
owner decisions below. This checklist is subordinate to
[MASTER-PLAN.md](../MASTER-PLAN.md) and records the boundary between local
proof and external activation.

## Current verified state

- Canonical lane: `/Users/nv/repos/ubiquity/sentinel/.codex-worktrees/master-plan-gfa795549e5`
  on `codex/master-plan-gfa795549e5`.
- Source candidate: `dde125febf4ef31f31764804f01f2934a4a15d00`.
- Local receipt: `deno task test:local` passed 683 tests across 68 steps at the
  source candidate, with formatting, lint and type checks passing.
- Target producer/consumer receipt: m06 target lane
  `a702d4ddb6a8bcbf549653cc75596b3d74715102` passed the fresh cross-repository
  probe recorded in `docs/build-status.md`.
- Scheduled workflows remain fail-closed. They call the direct tasks, which
  reject execution without an injected trusted host. No external capability,
  model, GitHub, deployment or target write is active.

## Owner decisions required before activation

| Decision | Required value or evidence | Current state |
| --- | --- | --- |
| Sentinel publication | Repository name, visibility and publication authority | Unresolved; no remote exists |
| GitHub access | Existing GitHub App installation and target-admin scope, with a trusted host source | Unresolved; do not create a new secret or environment variable |
| Deno access | Existing Deno Deploy project and promotion-token scope | Unresolved; do not copy a token into a worktree or model session |
| Model admission | Global rolling-hour and rolling-seven-day start caps, session bounds and receipt policy | Unresolved; runtime policy remains gpt-5.6-luna with max reasoning |
| Evidence retention | Owner-approved retention duration, storage bound and key capability | Unresolved; the target's current 48-hour capture TTL is insufficient for weekly waits |
| Stability policy | Metrics, denominator, baseline/window, minimum samples and thresholds | Unresolved; the local controller requires 30-minute acceptance with 30-second samples |
| Target ownership | Drain and handover of the embedded Sentinel writer and Deno promotion writer | Unresolved; do not run two writers against the target |
| Review and build receipts | Machine-verifiable completed review output and exact build receipt contract | Unresolved; silence, reactions and list order are not proof |
| Isolated release environment | Disposable target and rollback endpoint for the pre-live promotion drill | Unresolved |

## Activation sequence after decisions

1. Reconcile the target owner, current leases, remote heads and existing
   promotion workflow. Record the exact approved target base and handover.
2. Supply the already-approved capabilities to one trusted host composition and
   replace the inert workflow invocation only after the capability checks pass.
3. Publish the integrated Sentinel candidate, obtain a current-head review, and
   bind the target m06 regression and build receipt to exact commits.
4. Run the isolated Deno promotion, continuous acceptance and exact rollback
   drill. Preserve the prior revision identity and prove restoration.
5. Enable target repairs, starting with read-only discovery and retained
   evidence. Record the first and second distinct eligible deliveries in order.
6. Start the six-hour observation window only after the live receipts are
   verified, then record continued eligible selection and any rollback result.

Until those values and receipts are supplied, keep the direct workflow tasks
fail-closed. Do not guess limits, retention, thresholds, credentials, revision
selection or ownership, and do not treat local fixtures or injected transports
as live delivery proof.
