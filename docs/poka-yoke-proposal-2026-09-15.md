# Sentinel: make completed work recoverable

Status: recovery code integrated and CI accepted; the minimal reviewer adapter
is implemented and ready for integration. The recovery fix is not installed. This supports
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

## Frozen legacy-loss bridge

The first legacy bridge covers only self-repository scope-0 issue records with
an original, unprepared base_refresh intent and no candidateState. New-format
preservation records and ambiguous pre-receipt implementation intents are
excluded. In particular, Issue61 is not an instance of this recovery.

Add one optional trusted GitHubPort capability, proveLegacyBaseRefreshLoss.
Its transient proof binds taskId, repository, StateReadResultV1.head (not the
snapshot's prior stateHead), shape legacy_base_refresh, lostBase B0, lostHead H1,
predecessorHead H0, branch, PR, original intentKey and historical reviewId.
It writes no state or remote ref, starts no model and creates no review.

Require the current scoped issue to remain open and eligible, recorded work
dependencies to be done, and exactly one submitted implementation/retry
reservation for this task's current attempt at B0. Read the exact task branch
and owned open PR at H0, with the configured base branch. The PR's current base
SHA need not equal historical B0. Require a completed historical H0 correction
review bound to the same repository, PR, B0 and trusted reviewer, with nonempty
unresolved severities. Fetch the exact branch into a new trusted object store,
verify H0 and B0 ancestry, and prove H1 absent there. The existing exact local
candidate loader must also return not_found; present or unknown is not loss.
There is no legacy preservation ref to infer or require absent.

The normal loop performs a bounded deterministic pass before ranking, leaving
generic blocked selection unchanged. Track discovery/restoration separately
per task in that run. A successful discovery first commits missing_evidence
while retaining H1/B0, original intent, checkpoint, counters and all historical
records. Continue through a fresh state read and independently prove the same
loss and predecessor before restoration. Only then, if attempts remain, commit
ordinary work at H0/B0 with null checkpoint/intent/wait/blocker. Preserve the
branch, PR, source, counters, reservations, reviews and evidence. Normal model
admission then separately charges the next attempt; H0's correction review
prevents treating it as a deliverable candidate.

Both commits require the exact proof state head even after the ordinary
cooldown synchronization step. Any drift defers this task. Null/unavailable
proofs cause no restore or model start; an active task with an unavailable proof
is also deferred for that run so its old refresh cannot immediately repeat.
Other eligible tasks continue. The committed loss snapshot remains in state
Git ancestry. No new persistent discriminator or manual state rewrite is needed.

This narrow proof establishes recoverable scoped legacy loss. It does not
claim global remote-object absence or classify cases without a verifiable H0.

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

## Minimal delivery revision — 2026-09-16

This section answers the owner's new request to identify the minimum fixes. It
does not authorize a new acceptance round or change the runtime. The canonical
plan, worktree and branch remain those recorded in MASTER-PLAN.md. The current
candidate is 1a0d2a90a54fed3887f5f2067d6e62dc5c690c8e on PR67; reader PR70 is
864d7a0cbb595616b4e90293338f496788b8321a. Both have successful current-head CI.
Current runtime20aae115 remains generation5. The ledger owns current acceptance.

### Decision proposed

Keep the accepted preservation/recovery implementation. Fix the review adapter
that prevents its delivery. Retain Codex0.154.0, turn/start, outputSchema, review
journal, authenticated GitHub publication and existing release authorization.
Give that same reviewer an isolated, exact Git checkout instead of embedding
the full diff and every changed file in one prompt. Use existing Git helpers
and Codex reading tools. No SDK migration, native-review conversion, custom
retrieval protocol, chunk-review service or additional implementation writers.

Three source areas need changes:

| Area | Minimum behavior |
| --- | --- |
| src/github/review-snapshot.ts | Bind a complete changed-path manifest to exact base/head, merge base and Git object identities. Stop duplicating all diff/file bytes into the prompt. Keep all old/new contents available; use bounded or streamed reads for needed content and location validation. Handle the oversized old ledger as well as the aggregate diff. Preserve publication-safety checks and finite resource bounds. |
| src/host/local.ts review setup | Populate the existing reviewCheckout using prepareSourceRepository and trusted Git execution; verify exact base/head and clean detached HEAD. Keep independent objects, trusted configuration, no alternates/shared writable Git metadata, and the existing sentinel-review permission profile. Do not reuse the implementation client's write permissions. |
| src/github/codex-reviewer.ts | Allow supported repository-reading tools and their correlated events. Keep schema-constrained final output, exact invocation/model/effort/terminal evidence and all charging. Validate findings against the immutable candidate. Tool output, malformed results, interrupted/context-exhausted work and wrong identities cannot establish a clean verdict. |

Make only required type/fixture adaptations at these existing interfaces. Leave
reviewAuthorizes, review normalization, exact merge identity and release
authority intact. Reuse the recorded reader lane for a bounded bootstrap edit
after rechecking its ownership; integrate accepted work into the same canonical
lane by ancestry. No new goal lane is needed.

### Verified compatibility, not an upgrade assumption

Local CLI and Actions both use0.154.0. Generated installed-version schemas show
turn/start supports outputSchema. Tagged native review source supplies no final
schema and falls back to plain text on failed structured parsing; switching to
native review/start would add result-normalization work.

One non-model Linux probe reused the actual ensureReviewClient configuration
and CodexSubprocessSession. Exact Git content reads passed. Reads of a dummy
credential outside the checkout, a symlink escape, checkout writes and network
access failed. The session settled, with zero model starts and zero loopback
connections. Evidence be1b5c63-37e7-4e27-adee-29211e8c66a4 in the existing
459acb17ad9ea6b3117a31ea7e3934ee42910852ebdd735c5b0a8110d8083e59 namespace;
complete private copy minimal-review-permissions-v2-evidence.json. This proves
the tested local Linux command boundary, not a completed model review or hosted
rollout. Keep named profiles; legacy read-only alone is not equivalent.

### Minimum delivery sequence

Owner update2026-09-16 05:51-05:53 supersedes the development PR and review
steps below: no more development PRs or Codex reviews. The owner explicitly
keeps autonomous repair PRs/reviews. Directly deliver the tested source, install
the state reader as a safe rollback, then install the aggregate recovery runtime
and verify real Actions behavior. Preserve exact source/state identity and
record owner installation honestly, without a fabricated autonomous receipt.
The following numbered sequence records the earlier proposal only.

1. Implement only the adapter patch and measure a reader-plus-adapter bootstrap
   against the CURRENT trusted review snapshot limits. Keep the oversized ledger
   unchanged in this small deployment candidate. If it fits, use one bootstrap;
   if it does not, keep PR70 as the first stage and use a separate adapter-only
   deployment stage. Do not let an unaccepted reviewer authorize itself.
2. Request one bounded policy decision using that concrete result: replace
   additional paired local/authenticated rounds with two named authenticated
   calls (combined bootstrap, aggregate), or three if the bootstrap must be
   staged (reader, adapter, aggregate). Preserve every previous round and charge.
   This is a proposed allowance, not approval or an allowance reset. A finding
   or changed head cannot silently renew it. The older request is unanswered.
3. Obtain authentic current-head acceptance for the actual bootstrap, including
   PR70's corrected incident/repository match. Install both supervisor and
   runtime readers before emitting new-format state. Record the installed reader
   as the exact rollback revision. Verify the adapter through that trusted route.
4. Integrate the actual new development base into canonical ancestry, finalize
   the checkpoint once, freeze the candidate, run required CI for changed bytes,
   and obtain one authentic aggregate review. Merge/install through the existing
   operator and verify actual runtime revision. Do not reuse receipts for a
   different head or push evidence-only changes during the frozen review.
5. Let ordinary Actions execution recover Issue48 and deliver its runtime fix.
   Preserve Issue61's distinct ambiguous start. Observe real publication, review,
   CI, merge, hosted release and closure, with eligible progress past the blocked
   task. Preserve120/hour, no weekly cap, WIP3 and one runtime writer. Existing
   Issue58 evidence remains valid; overall acceptance still needs its own proof.

Use one focused adapter regression fixture for the actual oversized old blob
and diff, complete manifest, Git finding-location checks, supported tool events
and invalid completion cases. Reuse the accepted reader/recovery evidence.
Required hosted CI and real delivery remain necessary; do not duplicate the
full local suite merely to report another test total. The permission preflight
above is already executed and must not be repeated just to recover output.

### Gateway follows the working Sentinel path

The current ai.ubq.fi checkout is8bf9daad and its instructions identify VPS
deployment; Deno Deploy hosting is retired. Authenticated incident discovery,
the durable metadata index and encrypted replay export already exist. Keep
them. The48-hour raw-capture expiry still requires actual retained evidence.

Reconcile target owner/base, existing positive App and observer/replay access,
and exclusive VPS deployment/rollback authority. Use existing deploy:vps and
exact health/inference identity; do not recreate an endpoint or use a historical
Deno receipt. Verify the target's required inference origin explicitly: its
AGENTS still names Mac-to-VPS, while the VPS-origin exception was scoped to the
separate serial-routing goal. Update obsolete target assumptions in MASTER-PLAN
when the applicable handover decisions are settled. Preserve the full captured-
regression, two-delivery, continued-selection and observation objective.

### Research evidence

One newly authorized Pro request completed as
c7284228-d564-4eb1-b228-bed27239e699. Complete answer: private pro-answer-v2.md;
verified source/version findings: minimal-fixes-verification-v2.md, both under
the existing private poka-yoke evidence root. The earlier Pro job is separate
and its recovery recommendations are already integrated.

Primary sources independently opened on2026-09-16:

- https://learn.chatgpt.com/docs/app-server — turn/start, native review and
  installed-schema generation.
- https://learn.chatgpt.com/docs/permissions — named filesystem/network profiles
  and their incompatibility with legacy sandbox overrides.
- https://learn.chatgpt.com/docs/codex-sdk — SDK/app-server roles; no migration
  requirement for this existing integration.
- https://raw.githubusercontent.com/openai/codex/rust-v0.154.0/codex-rs/core/src/tasks/review.rs
  — actual native model selection and result parsing at the installed version.
