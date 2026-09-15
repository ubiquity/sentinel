# Sentinel: make completed work recoverable

Status: reviewed proposal in implementation, not an installed fix. This supports
the existing MASTER-PLAN.md and canonical goal; it does not replace them or the
authoritative docs/build-status.md ledger. The ledger owns current writer lanes.

## Implementation decision

Treat a model result as delivery-ready only after the trusted host has checked
its publication safety, stored its exact Git objects remotely, and proved that
a fresh workspace can retrieve them. Preserve the existing review, CI, release,
credential, single-writer and shared-budget boundaries.

An ordering-only patch is insufficient. The first implementation must cover
candidate preservation, publication, refresh and every review-admission path
together. It must not become another task-specific recovery script.

## Why current checks did not prove that Sentinel works

The installed runtime completed issue48 attempt3 but recorded an unpublished
candidate as target.head. Base refresh then required that new head to already
be on PR51, preventing the push that could put it there. The candidate was only
demonstrated in the producer's private mirror; its SHA survived, but no
retrievable copy of its code was found after runner teardown.

Existing refresh tests began with the candidate already on the PR. They missed
the transition from a genuinely new correction to publication. Passing1114
tests therefore did not establish this handoff. Exact state CAS and a healthy
Actions job also do not establish candidate durability or issue delivery.

Issue58's autonomous reviewed merge, accepted hosted release and bot closure
remain valid evidence. Issue61's unknown pre-receipt failure remains separate.

## Required invariants

| Boundary | Required proof |
| --- | --- |
| Model completed | Trusted execution and accounting receipt; no durability claim yet. |
| Candidate preserved | Publication checks passed; a create-only, operation-bound remote Git ref contains the exact candidate; a fresh object store can fetch it. |
| Candidate published | Expected-old-head update and actual task-branch/PR head match. |
| Candidate ready for review | Published head is integrated with the observed base; any new integration result is also preserved and published. |
| Review and merge | Every route enters the same review gate; genuine current-head review and required CI authorize the existing merge path. |
| Delivered | Exact accepted runtime release evidence precedes observed issue closure. |
| Failure needs intervention | A permanent missing object or contradictory head has a specific reason and required changed input; time alone does not make it retryable. |

Keep produced-candidate identity distinct from observed published identity.
Do not make target.head mean both at different call sites. Persist and reconcile
operation intent before external effects; a lost response must not cause a
duplicate model start or overwrite an unrelated ref.

Use the existing Git infrastructure for a retained candidate ref per operation.
An example namespace is refs/heads/sentinel-candidates/<task>/<operation-id>.
This is proposed, not created. It is not private storage: validate newly exposed
history, files and publication metadata before sending it there. Do not push an
entire worker mirror. Verify atomic create-only behavior and workflow-trigger
effects in the real trusted adapter; do not add branch protections or permit
force-overwriting existing refs. Defer automatic retention cleanup.

The independent source audit found that some existing review-content limits
run after publication, and replay-fixture sanitization is not a general Git
content scan. Move the necessary publication checks to the preservation
boundary. Do not silently rewrite application code or claim a denylist proves
an issue-specific allowlist or all-history sanitization.

## First implementation and acceptance gate

The immediate next action is one failing regression for the real incident:

1. Create a real temporary Git remote, base B0 and existing reviewed PR head H0.
2. Produce a distinct correction H1, then advance the base to B1 while the
   implementation is running. Derive test PR observations from actual refs.
3. Drive the production receipt, publication, refresh and review consumers.
4. Delete the producer workspace and its private mirror. Resume in another
   process with an empty object store, no alternates and no shared cache.
5. Require the exact correction to resume through publication and base refresh
   without another implementation call, historical charge change, or review
   admission for a stale/unpublished head.

Reuse tests/host/actions-candidates_test.ts, tests/host/local_test.ts and
tests/repair/base-refresh_test.ts seams. Fake only external transports and
model responses; retain actual trusted consumers and real Git/state stores.

Parameterize a small set of crash cuts: before remote preservation; after its
success but before state acknowledgement; after task push with a lost response;
after base integration; and after review/merge/release/closure effects. Assert
that missing unpreserved work is reported honestly, preserved work survives,
ambiguous effects reconcile once, and unrelated heads remain untouched.

The bounded production slice is:

- Check and preserve the candidate at the trusted receipt/import boundary.
- Restore from its retained ref independently of the mutable PR branch.
- Publish a fresh correction before requiring it to be the PR head for refresh.
- Put refresh-before-review enforcement in requestReviewFor, including
  successful-push and ambiguous-push recovery routes.
- Give legacy missing candidates an explicit disposition and stop unchanged
  deterministic retry loops. Do not manufacture a preservation receipt.

Define the narrow shared receipt/state contract and its legacy-data disposition
before assigning a DSH writer. This proposal does not resolve that contract by
overloading an existing field or inventing a migration during coding.

## Keep eligible work moving

Use repair state as the task queue; cron is a wake-up signal. Reconcile due
bookkeeping, then select eligible model work under the existing single writer,
three-PR limit and120 shared starts per rolling hour with no development weekly
cap. A waiting review must release implementation capacity.

Remote reads, candidate restoration, push reconciliation and release observation
are bookkeeping. Implementation, review, retry and continuation remain charged
model starts. A larger allowance does not remove the separate hourly ordinary
run delay. During owner-authorized supervised development, use bounded early
continuation when needed; a permanent production cadence change is a separate
decision. Do not flood the Actions run queue or wait for a successor while
holding the concurrency group that successor needs.

After one authoritative reconciliation confirms the same deterministic failure
on unchanged relevant inputs, stop that task's retry and continue other eligible
work. A shared state/ownership failure still prevents safe new admission.

## Stop, defer and prove

Stop using fixed-state rescue scripts as the normal path. Batch avoidable
evidence-only base changes, but keep base movement in the correctness test.
Defer broad refactoring, extra agents, new queue/databases, unrelated gateway
activation and automated candidate cleanup.

After the regression and crash cuts pass, obtain the required exact-candidate
review and install the real runtime through existing trusted release authority.
Then run one autonomous canary across a fresh runner and a moving base. Require
candidate retrieval, publication, fresh review, CI, autonomous merge, accepted
hosted release and closure. Observe unrelated eligible work progressing while
another task waits. Do not manually complete the canary's delivery gates.

For old candidate51842315, preserve the completed attempt, submitted charge and
missing-candidate evidence. A SHA or reconstructed lookalike is not recovery.
If a bounded search finds no verifiable copy, record delivery failure before
publication; an authorized replacement is a separately charged new attempt.

The full existing captured-regression, two-task, rollback, gateway and observation
acceptance remains open until its own evidence is present. This proposal and its
test plan are not proof that Sentinel is fixed.

## Frozen state contract and release order

The integration owner selected this contract on2026-09-15 after two independent
source audits. The new candidate receipt must not overload target.head or
target.checkpoint. The original model receipt and accounting retain their
execution meaning, including when importing or preserving the candidate fails.

WorkTargetV1 gains one optional group named candidateState. Absence means an
existing record whose durability and publication remain unverified. When present,
both keys are required: preserved and publishedHead. The latter is null or the
last verified actual task-branch Git SHA. It does not advance on model completion.
Preserved is null or an exact descriptor with four required keys: operationKey,
base, head and ref. Base/head are Git SHAs; operationKey binds the producing
implementation reservation or deterministic base-refresh intent; ref is under
refs/heads/sentinel-candidates/ followed by one full lowercase SHA256 digest.
The trusted host derives that digest from canonical JSON containing repository,
taskId and operationKey, so a producing operation has one create-only destination.
It verifies the complete operation/base/head/ref binding on every use. A changed
head under the same operation is a conflict, not a different allowed destination.

The parser accepts exactly the old target shape or that shape with candidateState.
It must leave absent fields absent: GitStateStore checks canonical parsed bytes
against stored bytes. It rejects partial groups, undefined values, extra keys,
invalid SHAs/refs, preserved descriptors unequal to target.head/base, and a
candidate group without a deterministic target branch. Null head requires null
preservation and null publishedHead. No top-level collection or budget change.

The new candidate_preservation intent uses the existing intent object shape:
key is the deterministic producing implementation operationKey (impl:reservationId),
branch is its full preservation ref, expectedHead is the new candidate,
observedBase is its original validated base, requestId is the producing reservation
ID, pr and resultId are null. It requires candidateState with preserved:null,
matching target.head/base and the matching implementation key. Persist this
binding before remote preservation; a lost acknowledgement is recoverable.

Prepared base refresh reuses its existing base_refresh intent and persisted
resultId. Preserve that exact result under the base-refresh operationKey before
task publication. Keep the original preserved descriptor while preparing its
successor; acknowledge the successor only with the corresponding target update.
The retained original ref is never deleted or overwritten. Do not add nested
intents or replace the base-refresh binding with a partially specified operation.

Deploy in two stages because the old runtime rejects new keys. First install a
reader revision that accepts and preserves both precise shapes, creates no new
shape, and parks every new-format task without mutating its record. Parking must
cover incident intake before summary updates, both selection functions, task
execution before dispatch, and post-loop CI approval. Keep complete snapshots
for dependencies and unfinished-PR limits, and continue unrelated eligible work.
The existing supervisor, cooldown and release readers must load mixed snapshots.
Verify this revision as both launcher/source and runtime before enabling writes.
It becomes the exact prior revision for the behavior release and must preserve
and safely park new records if rollback occurs. No live state downgrade or parser
default migration is part of this change.

Then implement preservation/publication/review behavior against that reader
contract. The initial failing regression remains in its isolated lane until
the behavior exists; it is not an ignored test or part of the reader-only release.
These release steps are infrastructure delivery and do not count as autonomous
application canaries.

## Review and source evidence

One owner-authorized GPT Pro request completed on2026-09-15 at17:59:02 UTC:
jobbeef79fa-b45b-4d6d-b6e8-0be7648b3e67, modelgpt-6-pro. It reasoned from supplied
repository evidence; it did not inspect or execute the repository. Its conclusion
was that ordering repair must include durable candidate preservation and all
review-admission routes. Independent Astra audits established the actual
deadlock and the existing validation boundaries.

Private complete prompt, answer and boundary map:
/home/codex/.local/state/sentinel-reporting/2026-09-15/poka-yoke/.
The boundary map was produced after Pro submission and is not attributed to Pro.

Primary documentation independently read on2026-09-15:

- [Git push](https://git-scm.com/docs/git-push): explicit expected-value updates;
  expected absence is a distinct creation condition. This is not a proposal
  to force-overwrite any Sentinel ref.
- [Git namespaces](https://git-scm.com/docs/gitnamespaces): namespaces are not
  read-access isolation.
- [GitHub issue linking](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue): closing keywords
  can occur in PR descriptions and commit messages.
- [Workflow triggering](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow): token/event behavior differs;
  GITHUB_TOKEN-created PR opened/synchronize/reopened events currently create
  approval-required runs. Do not assume all token-created events are suppressed.
