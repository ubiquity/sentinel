# Sentinel implementation continuation handoff — 2026-09-16

Prepared 2026-09-16T23:10Z by the primary local agent after the owner retired
the previous GPT-6 Astra integration owner for not completing this job and
transferred ownership. This continues the existing goal; it is not a new
architecture and not a new Git lane.

Read `AGENTS.md`, `MASTER-PLAN.md` and the active register in
`docs/build-status.md` before acting. `docs/build-status.md` remains the only
authoritative progress, ownership and acceptance ledger — do not maintain a
second task register. This document records where the work actually stands and
what the next agent must know that is not written down anywhere else.

## State at handoff (all verified, not inferred)

| Fact | Value |
| --- | --- |
| `development` (default branch) | `26c0a89` |
| `sentinel-supervisor` lane | `2a31d27` (development merged in, fast-forward) |
| Live gateway revision | `07ee77b9aa241f516b44ced5340e814e08a8825a` (VPS, via `/health`) |
| `sentinel-observe` | Green, scheduled, `blockedIncidents: 0` |
| `sentinel-supervisor` | Green, healthy, idle — "no eligible hosted supervisor work" |
| `sentinel-ci` | Green on every pushed commit |
| `sentinel-release` | `disabled_manually` by the owner (failures predate 09-11 15:19; not current) |
| Open PRs | 51 (issue 48 candidate), 74, 75 (stale duplicates) |

Repair-state work items (`origin/sentinel-state/repair`):

| Work item | nextStep | attempts / reviewRounds | wait |
| --- | --- | --- | --- |
| `issue-ubiquity-sentinel-48` | `review` | 4 / 2 | `review_pending` until ~23:11Z |
| `issue-ubiquity-sentinel-58` | `done` | 1 / 1 | — |
| `issue-ubiquity-sentinel-18` | `done` | 3 / 2 | — |
| `issue-ubiquity-sentinel-61` | `blocked` | 2 / 1 | none recorded |
| `issue-ubiquity-sentinel-21` | `blocked` | 1 / 0 | none recorded |

Release state (`origin/sentinel-state/release`): four `hostedReleases`, all
`phase: "accepted"`. One `hostedRuntime` record.

## What was fixed in this session, and how it was proved

The scheduled observer had failed **200 of 200 runs**, every run since
2026-09-09T12:33:58Z, reporting only `{"status":"blocked","reason":"invalid"}`.

Root cause: one incident whose replay export exceeded the contract
artifact-count bound made `readIncident` return `invalid`, and
`src/observe-main.ts` aborted the entire pass on the first such incident,
discarding every other incident's evidence. Two defects sat behind it:

1. The entrypoint discarded the typed `detail`, so 200 failures carried no
   diagnosable information at all. (`da08c9f`)
2. A per-incident `invalid` aborted the whole pass instead of being counted.
   (`b56294b`)
3. The replay walk counted **source-expired** captures against
   `GATEWAY_MAX_ARTIFACTS_PER_EVIDENCE = 16`, because the expiry filter runs
   inside the `visit` callback *after* the bound check — so captures that could
   never be retained consumed the bound of the array they would never join.
   (`fdb0d92`)

Live result, stable across three scheduled runs:

```json
{"status":"read_only","target":"ai.ubq.fi","pages":1,"incidents":6,
 "evidenceRecords":1,"blockedIncidents":0,"blockedDetail":null,
 "retainedCiphertexts":0,"retainedCiphertextBytes":0}
```

Each fix was reproduced by a test that fails before it and passes after: the
observe regression test fails with the byte-identical production error, and the
bound tests pin both the corrected behaviour and the preserved fail-closed
refusal at 17 genuinely retainable captures.

## What is next, in priority order

1. **Issue 48 is the live work item and it is waiting on review.** `nextStep:
   review`, attempts 4, reviewRounds 2, PR 51 open at candidate head
   `2789ba07e3f87944b465f7a44632578a88a7e89a`, preserved at
   `refs/heads/sentinel-candidates/d183b25a463356e3e368a59143f83367823ed3c12977959c4d52776195dbe348`,
   target base `2d834946`. Start here. Determine whether its bounded
   `review_pending` wait actually advances.

2. **Resolve the review-gate contradiction, which is the real blocker to
   autonomous self-repair.** `reviewAuthorizes` in
   `src/host/actions-supervisor.ts` requires a completed review receipt bound to
   the exact PR/head/base, with `resultId`, `completedAt`,
   `observedReviewer === expectedReviewer`, `findingsUncounted === 0` and no
   unresolved P0/P1 — for **every** self-repo release request. The owner's
   2026-09-16 instruction removes development pull requests and Codex reviews.
   Consequence: self-repair work can reach `review` but can never produce an
   eligible release request, so the supervisor will idle forever and T11 (two
   autonomous deliveries) cannot complete. This is a policy decision, not a
   code bug — do not silently weaken the gate. Get an explicit owner decision,
   then record it in the ledger.

3. **Diagnose the two blocked work items.** Issues 61 and 21 are `blocked` with
   no recorded blocker reason, and 61 already has 2 attempts and 1 review round.
   The ledger's own rule applies: a repeated unchanged failure or a checkpoint
   with no useful progress requires diagnosis and a recorded next action before
   another assignment on that task.

4. **The observer now runs but retains nothing.** `retainedCiphertexts: 0` and
   five of six incidents return `null` evidence (source-lost before ingestion).
   If autonomous repair depends on replayable evidence, its input is currently
   empty. Investigate whether the gateway still holds captures for the digests
   the index advertises in the 48h window, before assuming the observer is
   "working".

5. **Stale PRs 74 and 75 need an explicit decision.** They are duplicates:
   both carry the same two commits. `9246767` ("start verification execution
   when active revision lacks health proof") is already integrated — it lives
   in the promoted `sentinel-supervisor` lane. The only un-integrated work is
   `f18ac8e` ("distinguish expired credentials from other auth failures"),
   which relabels an `auth_failed` block as `auth_expired` and declares an
   unused `observe_auth_expired` code. It touches the exact hunk that `da08c9f`
   replaced, so it will not apply cleanly, and the landed change (reporting
   `reason` **and** `detail`) already supersedes its diagnostic value. Either
   re-apply just the `auth_expired` distinction or close both PRs.

6. **External decisions still open, do not infer them.** T10 gateway VPS
   ownership transfer is unresolved; T07 gateway retention/stability/release
   authority is pending; `sentinel-release` is deliberately disabled; T12's
   six-hour observation window has not been run.

## Operating knowledge that is easy to get wrong

**Delivering to `development`.** Ruleset `23197426` requires the `test-local`
status check on *that exact commit*, so a direct push of a new commit is
rejected. The working route, used for every commit in this session: push a
`codex/*` branch, wait for `ci.yml`'s `test-local` to pass on that SHA, then
push the same SHA to `development`, then delete the branch. Budget ~15 minutes
per change. `ci.yml` triggers on push to `master`, `development`, `codex/**`
and on pull requests.

**Lanes and rulesets.** Only two rulesets exist: `23197426` on
`development` (required `test-local`, strict) and `23197448` on
`sentinel-state/release` (creation/update/deletion/non-fast-forward, App-only —
never write it directly). `sentinel-supervisor` has **no** ruleset; it holds the
launcher only, tracks development closely, and is promoted by merging
development in and fast-forwarding. Never add or recreate branch protection.
`supervisor.yml` jobs are gated on `github.ref == 'refs/heads/sentinel-supervisor'`
and are dispatched by `supervisor-dispatch.yml` (every 5 min) and `repair.yml`
(hourly). **`repair.yml` is only a dispatcher — it holds no repair logic**, so a
green `sentinel-repair` run proves nothing about repair throughput.

**Supervisor idleness is not a failure.** `STATIC_IDLE_NONE` ("no eligible
hosted supervisor work") is reached when there is no active release, no
unrecorded review-authorized release request, and the hourly ordinary
execution is not yet due (`ordinaryDue` requires a healthy proof matching the
active revision *and* generation, plus `now >= runtime.nextOrdinaryAt`). All
four release requests are already `accepted`, which is exactly why it idles.

**Logging contracts.** `prepare`/`finalize` print one JSON line; only `run` and
`revision` are written to `GITHUB_OUTPUT`, and nothing parses the JSON. The
observer's result object is the run-log contract: `blockedIncidents` and
`blockedDetail` are how per-incident refusals become visible — do not
reintroduce a bare `reason`-only failure line.

**Local environment traps.**
- `tests/github/push_test.ts` "bounded output and hanging descendants settle"
  fails on macOS for environmental reasons; it passes on the Linux CI runner.
  Do not "fix" it locally.
- `deno task test` takes over an hour and spawns nested Deno processes that can
  outlive a killed run, leaving `sentinel-repair-test-*` and
  `sentinel-composed-lifecycle-*` scratch directories in the repo root. Clean
  them up. Prefer CI's `test:local` as the authoritative gate.
- `deno fmt` covers `src/`, `tests/`, `test-local.ts`, `docs/contracts.md` and
  `deno.json` — **not** `docs/build-status.md`.
- There are three pre-existing stashes (2026-09-08 and 09-11 preserved drafts).
  Check `git stash list` before popping; a blind `git stash pop` once restored a
  2026-09-11 draft and conflicted four unrelated files in this session.

**The ai.ubq.fi gateway.** The VPS is authoritative; a local checkout is only a
development copy and can be stale by dozens of commits — `git fetch` before
reading anything from it. It deploys from its `development` branch, is fronted
by Caddy (`reverse_proxy 127.0.0.1:8001`), and exposes a public `/health`
returning `release.git_sha`. Local uncommitted edits exist there; note that the
`src/inference_deadline.ts` edit duplicates what is already upstream and
deployed (`1_800_000`).

**Credentials.** The observer credential exists only as the
`SENTINEL_GATEWAY_AUTH_JSON` repository secret and cannot be read back. The
`UOS_AI_TOKEN` in `~/repos/ubiquity/.env` is **not** a super-admin gateway token
(it returns 401), so the authenticated `/admin/sentinel/*` endpoints cannot be
probed from this machine. Diagnose through the workflow's own logging instead.

## Boundaries honoured here, and still binding

No model calls, no GitHub writes to the target, no credential writes, no
deployment. `sentinel-state/release` was not touched, no ruleset was added or
changed, and no admission, quota or review policy was altered. Task acceptance
statuses in `docs/build-status.md` were left alone — only verified facts and
this session's evidence were recorded there.
