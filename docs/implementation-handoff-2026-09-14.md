# Sentinel implementation continuation handoff

Prepared on 2026-09-14 by the planning facilitator for a new implementation
session. This is a continuation of the existing Sentinel goal, not a new
architecture or a new Git lane. Read `AGENTS.md`, `MASTER-PLAN.md`, and the active
register in `docs/build-status.md` before using this document.

This document specifies the next work and its acceptance conditions. The master
plan retains the project requirements and `docs/build-status.md` remains the
only authoritative progress, ownership, and acceptance ledger. Do not maintain
a second live task register here. Historical Mac and Deno deployment statements
must be reconciled against the later VPS and hosted Actions decisions.

## Canonical goal identity

| Field | Exact value |
| --- | --- |
| Canonical master plan | `/home/codex/repos/ubiquity/sentinel/.codex-worktrees/master-plan-gfa795549e5/MASTER-PLAN.md` |
| Continuation handoff | `/home/codex/repos/ubiquity/sentinel/.codex-worktrees/master-plan-gfa795549e5/docs/implementation-handoff-2026-09-14.md` |
| Preserved original goal ID | `/Users/nv/repos/ubiquity/sentinel/MASTER-PLAN.md` |
| Goal slug / suffix | `master-plan` / `gfa795549e5` |
| Repository root | `/home/codex/repos/ubiquity/sentinel` |
| Canonical worktree name | `master-plan-gfa795549e5` |
| Canonical worktree | `/home/codex/repos/ubiquity/sentinel/.codex-worktrees/master-plan-gfa795549e5` |
| Canonical branch | `codex/master-plan-gfa795549e5` |
| Lane state | Existing; incoming Astra integration owner takes over after reconciliation |
| Implementation base observed for this handoff | `development`, `bd8065d28bd5a822988a8085e6c75674ee88a575` |
| Original initialization base | `ec4bd82df4adfdb962e10332607ee4fbf539cdeb` (historical; do not reset to it) |

Preserve this identity under the existing-goal exception in
`~/.codex/agents/git-coordination.md`. Do not derive a new lane from this
continuation document. Planning documentation may follow the recorded source
base; inspect that delta before starting implementation. No coding worker was
launched by this planning session.

Goal: Use canonical worktree name master-plan-gfa795549e5 at /home/codex/repos/ubiquity/sentinel/.codex-worktrees/master-plan-gfa795549e5 on branch codex/master-plan-gfa795549e5, read AGENTS.md and /home/codex/repos/ubiquity/sentinel/.codex-worktrees/master-plan-gfa795549e5/MASTER-PLAN.md in full and follow /home/codex/repos/ubiquity/sentinel/.codex-worktrees/master-plan-gfa795549e5/docs/implementation-handoff-2026-09-14.md as Astra orchestrator to complete the bounded reporting fix and evidence reconciliation with supervised DeepSeek coding, preserve the working hosted runtime and all admission and ownership rules, and establish the remaining autonomous delivery and observation evidence only within the recorded target authority.

## Outcome and scope

The next session must first fix the confirmed bounded-reporting defect without
damaging the already working hosted release path. It must reconcile stale
backlog and blocked execution evidence before deciding whether more source
changes are needed. It must distinguish this operator maintenance from runtime
autonomous throughput.

The owner ended the previous hands-on implementation window at 06:25 UTC. The
07:28 request authorizes Pro-assisted planning and this handoff, not renewed
implementation or gateway activation in this session. The user intends to give
the next implementation session this goal. Sending that execution goal is the
future session's authorization to implement its stated scope; do not ask the
owner to approve it again. Obey any time limit supplied to that session.

Do not redesign closure cadence, quotas, scheduling, runtime models, protected
paths, or release authority. Do not introduce a general recovery framework,
queue, dashboard, new host, environment variable, secret, or CLI flag. Do not
create artificial eligible issues merely to obtain a second delivery.

## Verified starting evidence

At 07:29–07:33 UTC, both clean VPS checkouts were at `bd8065d`; PR #45's
documentation merge CI `34813379853` had passed. Published worker work is
integrated. Fetch all heads explicitly: the normal fetch configuration tracks
only development.

```sh
git fetch origin '+refs/heads/*:refs/remotes/origin/*' --tags
```

| Object | Verified identity / result |
| --- | --- |
| Fixed supervisor | `2a24c4d9cb16ffcd7fec0ea75364be9fa0adf9d7`, branch `sentinel-supervisor` |
| Active runtime | `989af8a52179702a5fd063337d09b2b376e739f1`, generation 2 |
| Autonomous PR | #30, refreshed head `f9df73e53a4c322391c2628b7e372389fa33d4bb` |
| Review | `5194066280`, exact head, Luna/max request/runtime evidence, clean |
| Candidate CI | `34807909081`, 1071 tests / 84 steps / zero failures / nine ignored |
| Autonomous merge | `989af8a`, by `github-actions[bot]`, 05:59:47 UTC |
| Hosted acceptance | Candidate run `34811959137`, healthy exact prior/candidate proofs, release phase `accepted` |
| Issue #18 closure | CLOSED at 07:10:03 UTC; persisted work is `done`, no intent or wait |
| Later healthy ordinary execution | `34816399505:1:repair`, runtime `989af8a`, launcher `2a24c4d`, base `bd8065d`, settled |
| Next ordinary eligibility observed | 2026-09-14 08:07:55.647 UTC; re-read at resume, not a guaranteed launch time |
| Release ref snapshot | `e2a1ec3bc100fec389835214b886ee7fd84d580a` |
| Repair ref snapshot | `c9be3e3360d75523009d109d4d8591d519ffa264` |
| Model history | Six reservation blobs preserved; issue #21's original reservation remains ambiguous |

This proves one hosted Sentinel issue delivery including closure. It does not
prove the original two-task captured-regression requirement, review-wait overlap,
continued eligible selection, gateway release acceptance, or six observed hours.
Do not retrofit those claims onto this receipt.

Restricted evidence directory:
`/home/codex/.local/state/sentinel-handoff/2026-09-14/`.
It contains `work18.json`, `work21.json`, `runtime.json`, `release.json`,
`reservations.json`, the issue inventory, original run metadata/artifact listing,
`issue21-original-34669576394.log`, and `issue18-closure-34816399505.log`.
Use `sha256.json` to check the saved evidence. Raw logs stay outside Git and
model prompts. Earlier evidence references remain in the central ledger.

State paths inside the appropriate fetched refs:

- Repair work #18: `work/95c3ba59d3063641aed1193873cda9f6cf1840b09956aa8d811b5736ff642721.json`.
- Repair work #21: `work/5a52ef5ee0a4714a579914272672dbe6e2e7adfc09ca1f4325f0f28cedf44c77.json`.
- Hosted release: `hostedReleases/7ba18da69fde1f29b100bac9e976cbf6dbeee37abc6dc24ceea70bf1992b3dab.json`.
- Runtime pointer: `hostedRuntimes/d99cd071db17022f3c9a0ee984e5c3547d1363cdd99386212acf9f4e5aae4560.json`.

## Work order and ownership

Use one bounded coding writer at a time in the existing isolated canonical
lane after all prior writers are settled. These are sequential work packages,
not independently writable modules. Shared producer/consumer contracts stay
with the Astra integration owner; do not spawn parallel writers on them.
Read the current DSH playbook before any assignment. Development policy is the
owner-approved latest DeepSeek V4.1 Flash/max; the existing decisions log and
master plan identify `deepseek-flash`. Resolve an actual conflict with a newer
playbook before launch; do not silently change the product's Luna/max policy.

DSH may edit only assigned source/tests and returns uncommitted work and checks
NOT RUN. Astra owns evidence execution, docs, Git, live state and acceptance.
Each assignment must give the exact worktree/branch/base, immutable inputs,
owned files, forbidden surfaces, supported feedback method and settlement
checkpoint. Expected first useful diff: about ten minutes; focused handback:
about thirty minutes for the reporting slice. Diagnose a repeated failure
before another assignment; never rerun unchanged work to recover output.

### 1. Reconcile before writing

Verify the canonical path, branch, HEAD, status, processes and PRs; fetch all
heads and tags. Read the active ledger first. Re-read the exact runtime pointer
and both state refs. Record the current snapshot in the ledger. Do not switch
to the root checkout or reset source to the active runtime revision.

Confirm issue #18 remains closed/done with the accepted request identity. This
needs no source change: the earlier closure wait resolved on the next ordinary
pass. Do not add a new reconciliation purpose or advance `nextOrdinaryAt`.

Check every open issue against source and existing receipts before assigning
it. In the 07:32 inventory only #21 had the exact runtime opt-in marker, and it
was blocked. All other open issues were outside marker admission. An idle pass
with no eligible work is not proof of a broken selector.

### 2. Resolve issue #21's execution disposition without requeueing it

Original request/reservation:
`67b1fd764869341a37ee4df359c37697f353b95d1816f2933c08152ad25bb7b6`,
attempt 1, base `8b413a24399ff1e6886261d1a4fec47975178980`.
Its work intent started at 2026-09-12 03:09:51.319 UTC and remains saved.
Reservation outcome is `ambiguous`, proof ref null. The source run
`34669576394` finished with a generic “2 records: 0 terminal, 2 blocked” result;
its artifact listing is empty. No published candidate/PR or trusted receipt was
found. This is not evidence of no submission, and the original error cause is
not recoverable from that run log alone.

`src/repair/loop.ts` settles a failed `runModel` result as ambiguous and blocks
the item. `src/repair/selection.ts` excludes blocked work. Current
`LocalCheckoutModelPort` logs a bounded static error and saves minimal private
model results, but a newer diagnostic path cannot retroactively prove the old
run. Do not spend another model start merely to diagnose this history.

The issue explicitly assigns the host/workflow fix to Astra. Its files are in
`createLocalRepositoryConfig().protectedPaths`. Preferred disposition: retain
the blocked execution unchanged and implement the defect as trusted operator
maintenance under step 3. Do not remove protected paths or reuse this issue as
the second autonomous delivery. Record operator delivery separately from the
original runtime attempt.

If a supported existing reconciliation interface can safely attach a newly
found exact trusted receipt, verify its task/request/base/head identity and
settlement before use. Otherwise keep the historical execution blocked. Do not
add a state reset, mark it `done` without its required delivery evidence, erase
its intent, change its reservation, or invent `confirmed_not_submitted` proof.
A new retry or terminal operator-state disposition requires a concrete reviewed
transition and authority; prepare that proposal only if it is actually needed.
Closing a manually fixed GitHub issue does not itself settle the runtime record.
Do not rerun the old GitHub workflow as a substitute for this transition: a
GitHub rerun retains the original event SHA/ref and original triggering actor's
privileges; it does not establish Sentinel request-level idempotency.

### 3. Implement the bounded reporting projection

Confirmed defect: `writeLocalStatus` in `src/host/local.ts` maps all work and
lifetime reservations into the report. `.github/workflows/local-status.yml`
rejects detail lists over 200 entries or an input string over 50,000 characters,
and derives counts and RED/GREEN from the supplied lists. Simply slicing those
lists would conceal totals and could conceal blocked work.

This is the retained local status path. `runActionsRepairHost` produces the
separate `ActionsRepairHostResultV1`, and `hosted-runtime.ts` validates its exact
keys, execution identity and outcome. Do not change that terminal contract or
turn a diagnostic report into release proof. The hosted runner currently does
not call `writeLocalStatus`; do not invent a new dispatch path or require the
Mac to exercise this defect.

Owned implementation surface: the existing status producer in
`src/host/local.ts`, the renderer in `.github/workflows/local-status.yml`, a
focused producer/workflow test under `tests/host/`, and a small new private
status helper only if needed for these two production consumers. Add it to the
existing harness if normal discovery does not include it. Do not move unrelated
host code or change frozen repair/release state contracts.

Requirements for the single producer/consumer cutover:

1. Compute aggregates from the complete parsed snapshot before choosing detail.
   Include total work, every known next-step count, unknown-step count, blocked
   total, total/open/settled reservations, charged usage in each rolling window,
   limits, omitted work/reservation detail counts and an explicit summary marker.
   Use a single `finishedAt` observation time for all window calculations.
2. Preserve exact budget semantics: intervals `(now - window, now]`; reserved,
   submitted and ambiguous charge; only confirmed-not-submitted is uncharged.
   Reuse `isCharged`, `HOUR_WINDOW_MS`, `SEVEN_DAY_WINDOW_MS` and
   `earliestRetryAt` from `src/budget/mod.ts` where applicable. Return a nullable
   next eligible time consistent with both caps. Future or invalid timestamps
   must not produce a falsely permissive report.
3. Keep each detail list at most 200 entries and bound the complete serialized
   status, not just each field. Retain a conservative 50,000-character bound;
   also bound UTF-8 bytes and the actual escaped dispatch envelope if a live
   wrapper is identified. Reduce optional detail deterministically until it
   fits. Never truncate serialized JSON or drop aggregates/identity to fit.
4. Select blocked detail first, then nonterminal work, then terminal history,
   with stable ID tie-breaks. Bound displayed issue IDs too. If blocked work
   exceeds the detail capacity, show total blocked and omitted-blocked counts;
   a report must remain RED even if a particular blocked item is omitted.
5. The renderer validates aggregate integers, sums, detail/omitted relationships,
   times, version, model and limits before rendering. RED is driven by complete
   blocked/error/unknown state, not the truncated list. Missing/unreadable state
   remains unavailable/RED, never a healthy empty report. Summary truncation
   alone is not a failure when complete valid aggregates remain available.
6. Make one explicit version/shape cutover for the report producer and renderer;
   do not retain an unbounded legacy fallback. Keep the hosted terminal-result
   schema unchanged. Identify any actually active local dispatch wrapper from
   repository/installed evidence before touching it. Do not create a wrapper or
   access the Mac merely because issue #21 names an old trusted wrapper.
7. Remove the incorrect Mac-only claim from the report's descriptive text using
   neutral local-execution wording. Do not label local evidence as hosted proof.
   Keep the report workflow read-only, credential-free, and network/model-free.
8. No deletion or mutation of durable reservations/work history. No raw issue
   body, model output, credential, provider request, or private artifact in the
   projection. Preserve atomic private-file writing and valid single-line JSON
   logging. A bounded projection failure returns truthful unavailable status.

The 50,000-character and 200-item limits are local repository limits, not
claimed GitHub limits. GitHub's documented dispatch limit is separate; see
the verified source notes below.

### 4. Reconcile stale issues instead of repeating completed implementation

Issue #40: `HostedSupervisorCooldownGate` and `HostedRepairCooldownGate` in
`src/host/hosted-cooldown.ts` now read both role snapshots, apply the stricter
hold, persist only their own role's observation and fail closed on bad state or
CAS uncertainty. Source commit `3aee5ae` is integrated. Existing focused
real-Git evidence is `459acb17ad9ea6b3117a31ea7e3934ee42910852ebdd735c5b0a8110d8083e59/2626bbb7-d718-439d-b5bf-9a03894e025a`.
Inspect that evidence and the later integrated CI, plus all authenticated
supervisor request constructors. Close or update the issue only with a precise
mapping to its restart/rate-limit/conflict acceptance. Do not reimplement it.
The planning facilitator retrieved the saved receipt at 07:38 UTC: nine tests
passed, including restart, cross-role holds, unknown persistence and state
preservation. This was a read of prior evidence, not a fresh execution.

Issue #32: the obsolete scan-based `readActionsRelease` path was removed by the
persisted hosted receipt cutover (`b066585`); exact execution evidence is now
bound through the supervisor. Inspect ancestry, current consumer, missing/
malformed proof tests and the accepted live release. Classify the old defect as
superseded only if no consumer still uses the obsolete path. Do not restore a
run-list scan as its “fix.” Existing consumer evidence:
`459acb17ad9ea6b3117a31ea7e3934ee42910852ebdd735c5b0a8110d8083e59/5118668f-9a04-47c5-b289-dbe2fff6a1e2`.
The saved receipt was readable at 07:38 UTC: 55 tests passed, including exact
accepted/rollback binding and missing/malformed/foreign receipt rejection. This
was prior-evidence retrieval, not a new test run.

Issues #5 and #8–#14 contain both historical and target-specific requirements.
Current hosted proof may satisfy a portion; it cannot close gateway obligations.
Reconcile issue text, ledger evidence and current target scope before updating
them. Use `~/.codex/agents/github-issues.md` for actual issue edits/closure.

### 5. Deliver operator maintenance

After focused verification, freeze the combined candidate, run the integrated
acceptance check and bounded Codex review, fix substantive findings, then commit,
push and deliver through the canonical PR with required CI. Do not review every
small edit. Obtain the required fresh read-only Astra audit at the major
acceptance checkpoint, with the exact diff and evidence rather than worker chat.

Keep development source, fixed supervisor launcher and active runtime identities
distinct. Merging reporting documentation/code does not automatically replace
the active runtime. Install only changes needed on an actual executing surface
through the existing reviewed supervisor procedure. Never move the pointer by
branch tip or manufacture a hosted release request for a manual maintenance PR.
Record whether the fixed report is source-tested, workflow-tested, or actually
used by an identified installed producer.

### 6. Remaining live acceptance, without manufactured throughput

There is presently no second eligible unblocked Sentinel issue. Reconcile any
new real backlog at resume. If none exists, record `no eligible work` as the
throughput boundary. Do not enable governance tasks, strip protection, fabricate
an incident or hand-code a target fix to make an acceptance counter advance.

The original #15 requires a captured offending request, permanent sanitized
fail-before/pass-after regression, two distinct deliveries in eligible order,
overlap of a review wait with useful second-task work under one writer, and
continued selection. One completed issue #18 receipt does not establish that
whole sequence. A later second issue alone also cannot retroactively prove
review-wait overlap that was not observed.

Gateway acceptance remains a separate target phase. Before gateway work,
reconcile its current VPS hosting, repository instructions, existing runtime
and promotion owner, isolated release target, retention/storage/key settings,
and stability thresholds. The ledger records a prior move away from Deno
hosting; do not execute obsolete Deno deployment instructions or quietly
replace their acceptance contract with VPS behavior. Prepare the exact current
target contract and any remaining owner decisions before activation. No new
target ownership, secret interface or stability threshold is approved here.

Require the actual isolated promotion/interruption/exact-rollback drill and
refusal to roll back a newer unrelated revision before target handover. Retain
the required continuous acceptance samples; missing telemetry restarts or
invalidates coverage. Hosted Sentinel verification does not substitute for
gateway release identity or rollback evidence.

For #16 record a real observation start/end, samples, actions and gaps after
activation/receipt verification. Six wall-clock hours since deployment are not
six observed hours. Scheduled Actions can be delayed or dropped. Do not backfill
unobserved stability or consume a model start for status polling. Report the
minimum remaining elapsed observation time and any owner/provider blocker.

## Validation matrix

No tests are run by this planning session. Reuse existing evidence before fresh
execution. Astra registers and executes focused tests through
`/home/codex/.codex/agents/assets/test-evidence/evidence.ts`; read
`~/.codex/agents/test-evidence.md` first. Return the full host-local evidence
reference, source revision, command, exit status and execution/cache distinction.

| Surface | Required cases | Acceptance evidence |
| --- | --- | --- |
| Actual status producer | 0, 199, 200, 201 and a finite 10,000-reservation history; full aggregates and bounded detail | Production producer invoked with real parsed temporary state; no model/network |
| Budget projection | Every outcome; exact hour/week boundaries; refunds; both caps; 0/1/2 hourly and 167/168/169 weekly use; future/invalid time | Matches existing budget semantics without clipping over-limit truth; no state mutation |
| Blocked visibility | More than 200 blocked work items; blocked item outside chosen detail; unknown steps | Correct total/omission counts and RED output |
| Size | Max-length IDs, Unicode and JSON escaping; 49,999/50,000/50,001 characters in the actual consumer's unit | Valid bounded JSON and envelope; no string truncation |
| Actual renderer | Run the workflow's embedded Deno code with a finite event file and summary path | Accurate summary and exit code; invalid/stale/missing data stays RED |
| Production composition | Producer output passed unchanged to real renderer, including large history | Not just helper-to-helper agreement or source text checks |
| Hosted compatibility | Exact `ActionsRepairHostResultV1` and wrapper scanner behavior unchanged | Focused hosted-runtime and hosted-workflow regressions if touched/relevant |
| State preservation | Complete reservation/work snapshot identity before/after reporting | Byte/blob identity unchanged, all ambiguous charges retained |
| Integrated candidate | Existing `deno task test:local`, exact-head Codex review, required CI | One final integrated candidate, bounded review; no live model/GitHub calls in harness |
| Operational evidence | Exact producer actually in use, if present; autonomous receipts separate | No Mac-dependent proof, no green-workflow substitution for delivery |

Keep expected outputs independent of the implementation. Before starting a full
suite estimate runtime from existing receipts; do not launch repeated expensive
runs to retrieve output. If a historical evidence reference expired, state that
and run only a justified replacement after the candidate is ready.

## GPT Pro contribution and verified platform sources

The owner authorized one new submission at 07:28 UTC. Authentication passed.
Job `29dc3c4f-5143-4469-9ae7-192c5c689de5` was submitted once at 07:30:54 UTC
using `gpt-6-pro` and completed at 07:40:18 UTC. The result was retrieved and
read in full. One of one authorized submissions was used. Two unrelated old
jobs belong to another account and were preserved. No further submission is
authorized by this handoff. The full answer and submitted prompt are saved as
`pro-answer.md` and `pro-prompt.txt` in the restricted evidence directory.

Accepted recommendations: operator-owned reporting scope; no automatic retry
of the ambiguous attempt; full-state aggregates distinct from bounded detail;
boundary/size/blocked-state tests; stale-issue reconciliation; separate source,
hosted and gateway acceptance; no fabricated throughput or observation coverage.

Corrections made after checking the recommendation against repository evidence:

- Pro had only supplied snippets and could not inspect the repository. Current
  source shows that the hosted runner does not call `writeLocalStatus`. There
  is no active hosted report consumer to invent or patch for this defect. Test
  the retained report interface honestly and verify any installed producer
  before claiming deployment acceptance.
- Pro suggested an additive legacy-compatible schema. This conflicts with the
  owner's hard-cutover rule. Use a single coordinated producer/renderer shape
  change; keep the separate hosted terminal protocol unchanged. If a real old
  local producer is found active, stage its cutover through its existing owner;
  reject incompatible payloads rather than misreporting counts.
- Pro's generic instruction to obtain renewed authority applies to this
  planning session. The next user-issued implementation goal authorizes its
  stated work; do not insert another approval question for ordinary edits.
- Development Codex review and runtime target review have distinct policies.
  Only the product's runtime starts use its shared 1/hour, 168/seven-day state;
  do not mutate those reservations for the operator's development review.
- The ordinary run started at 07:07 and closed issue18 during that run at
  07:10. It is not a separate post-closure observation interval. The saved
  closure and settled execution together establish closure, not six-hour health.
- Pro's sandbox download link is not a local handoff artifact. This checked
  repository document and the preserved existing identity are the actual handoff.

Primary documentation checked on 2026-09-14:

- [GitHub scheduled events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule): schedules may be delayed during high load and queued jobs may be dropped; scheduled workflows run on the default branch. Thus an eligibility timestamp is not a promised run time.
- [GitHub workflow dispatch](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch): current documentation states a 65,535-character inputs payload maximum. The report's stricter 50,000-character bound remains a local choice. Do not confuse `repository_dispatch` client-payload rules with workflow-dispatch inputs.
- [GitHub reruns](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs): reruns use the original SHA/ref and original triggering actor's privileges; this is not Sentinel retry authorization or duplicate-effect exclusion.

Saved sources: restricted evidence directory `github-events.html` and
`github-reruns.html`. These facts support the plan; they are not evidence of
live Sentinel behavior. Other Pro citations are retained in its answer but are
not used as independently verified claims here.

## Required final handback from the implementation session

Report separately: reporting defect fixed and tested; operator maintenance
merged/installed; issue #21 historical execution disposition; stale issues
reconciled; autonomous issue receipts; gateway-specific remaining decisions;
six-hour observation coverage and gaps. Include exact SHAs, review/CI/run IDs,
evidence references, remaining owners/actions, and final clean/dirty Git state.

Never report the complete master goal as achieved while the second delivery,
captured regression, overlap, target rollback or required observation remains
unproved. A precise blocked boundary is a valid handback; a fabricated receipt,
hidden state reset or unrelated redesign is not.
