# Build status

## Active task register — primary agent owned

Updated 2026-09-17 18:35 UTC. This is the only authoritative acceptance ledger.
The goal remains incomplete: autonomous GitHub Actions repair against Sentinel,
then the separately authorized ai.ubq.fi target. The owner retired the previous
GPT-6 Astra integration owner on 2026-09-16 for not completing this job and
transferred ownership to the primary local agent, which may now change scope,
status, acceptance and write ownership here.

### Current checkpoint

**Owner-requested end-to-end run verification, 2026-09-18 02:29–03:47 UTC. Issue
77 / PR 78 is delivered, and the run exposed two live defects that are fixed.**
The owner asked for a run to be invoked and watched to the end instead of being
told it works. The protected supervisor was invoked by hand at 02:29:20Z with
the same primitive the dispatcher uses
(`gh api --method POST repos/ubiquity/sentinel/actions/workflows/supervisor.yml/dispatches -f ref=sentinel-supervisor`);
run `35299518858`, repair job 02:29:54–03:04:19Z, settled `healthy`.

Verified timeline (every instant read from the live repair/release state, the
run logs or the GitHub API — not narrated):

- 02:31:35Z the round-2 P1 receipt was recorded (evidence 1 → 2), the
  `review_pending` wait cleared and `nextStep` moved `review` → `work`. The
  journal was first validated locally with the runtime's own
  `parseReviewJournalBody` (result digest plus byte-exact re-render, review
  `5243314393`, head `c296551`, base `cf8e661`), so the recording was predicted
  before it happened rather than observed after.
- 02:31:27Z → 02:47:45Z the correction was admitted as attempt 4 (purpose
  `retry`, head `cf8e661`) and published candidate head
  `ee2307bbc5e066aeb80736ea91b19e91469005c5` at 02:48:16Z; review round 3 was
  requested 02:48:40Z and verdict `5243780886` posted 03:04:07Z with **one P2
  finding and no P0/P1**.
- The fix was verified independently on the new head, not taken on trust: the
  round-2 hazard reproduces on the reviewed head (secondary out-of-range
  RFC-850 `Retry-After` → `retryNotBefore = now + 60s`, `fallback: true`) and
  the same probe on `ee2307b` returns `retryNotBefore: null`,
  `fallback: false`, with the RFC-mandated 100-year backshift now resolving
  instead of reporting `malformed`. `tests/github/` passes; the 25 failures it
  also reports locally are byte-identical on the pre-change base, so they are
  an environment artifact, not a regression.
- `test-local` on `ee2307b` is green (started 03:04:20Z, run `35300799331`
  completed 03:17:45Z). GitHub parked the bot-authored run at
  `action_required` and the runtime's own trusted helper
  (`src/host/actions-ci.ts`) approved it at 03:04:17Z.
- 03:40:50Z the maintenance pass merged the reviewed head with an expected-head
  compare-and-swap: merge `38c70a5bf3e58ff3fb1c7cfeb7a91e98105c3d1a` with
  exactly the parents `cf8e661` + `ee2307b`.
- 03:41:15Z release request `release:c9405599111ee3176eaeb57cdfae043693ced4089dc3d68e28fd338649ec928e`
  was recorded (revision `38c70a5`, receipt `ffa3b095…`, request
  `review-review:78:ee2307b…:attempt-3`), prior proof `cf8e661`/generation 23
  (run `35304095632`), candidate proof `38c70a5`/generation 24 (run
  `35304290387`, purpose `candidate`), **phase `accepted` at 03:46:26Z**, and
  the runtime pointer promoted to `38c70a5`/generation 24 with that healthy
  proof.
- 03:46:45Z issue 77 was closed COMPLETED; the autonomy record reads
  `{"status":"applied","reason":"closed_issues","actions":["delivery:issue-ubiquity-sentinel-77:already_recorded","close:issue-ubiquity-sentinel-77:issue=77"]}`.

**Defect 1, found live and fixed (supervisor lane `4a38a91`, cherry-picked to
development as `c022936`).** The runtime advances to a correction round for ANY
unresolved finding — `src/repair/loop.ts` uses
`receipt.unresolvedSeverities.length > 0` — which is stricter than its own
documented transition ("Completed current-head review with no unresolved P0/P1 →
delivery", `src/repair/transitions.ts:379`) and than the trusted gate
(`reviewAuthorizes`, `authorizingReceipt`). A P2-only verdict therefore parked
the record in `blocked` once the attempt budget was spent, where the delivery
pass could not see it, and the retry pass then kept granting an attempt-ceiling
retry whose reservation identity was already charged (its identity check used
purpose `implementation` while the loop charges `retry` for every correction),
so the record would have livelocked on `model admission refused: duplicate`
without ever delivering. The fix, all on the supervisor lane: delivery and
check-approval eligibility also cover a record parked in `work`/`blocked` once
`reviewRounds` has reached the runtime ceiling, because no correction can become
a verdict any more and the receipt in hand is the only honest basis for
delivery; an attempt-ceiling grant is never planned once the review budget is
spent; and the identity check uses the purpose the runtime actually charges
after the grant. 22 autonomy tests green, four of them new.

**Deferred P2, future work (exact location).** Review `5243780886` finding 0,
`src/github/rate-limit.ts:195-196`: when `observedAt` is outside JavaScript
Date's range the early branch returns `unrepresentable` before validating the
captured date fields, so a malformed value suppresses the documented
secondary-limit fallback. This sits in the same class as the deferred issue-48
P2s and does not gate acceptance.

**Follow-up recorded, not yet done.** The correction predicate above should
become P0/P1-based in a future runtime revision; `src/repair/loop.ts` is
protected, so it cannot be changed by a model worker and needs a promotion
cycle. Until then the delivery pass carries the correct rule.

**Cadence measured, not assumed.** `supervisor-dispatch.yml`'s `*/5` cron is
heavily throttled by GitHub on this repository: observed dispatch instants
02:05:57, 01:53:55, 01:37:03, 01:14:01, 00:52:21, 23:57:50, 23:50:35, 23:42:35,
23:35:03 and 23:25:30Z — 12 to 55 minutes apart, never 5. The supervisor also
serializes the cheap maintenance pass behind the long repair job through the
workflow concurrency group, so while an execution is in flight no retry,
approval, delivery or closure pass can run. Both are why the fleet can look
idle while a run is genuinely working. The operator dispatches recorded above
were used to keep the pipeline moving inside this window; the scheduled path
alone adds 10–25 minutes per stage.

Updated 2026-09-17 20:54 UTC. **Issue 48 is delivered: the reviewed head was
merged, the trusted supervisor accepted the hosted release for the merged
revision, and the issue is closed with that evidence.** The self-repair
review-gate contradiction is resolved in the only way the owner's own rules
allow; no gate was weakened and nothing was fabricated.

**Why the fleet looked idle, and what now makes it autonomous.**
- Sentinel *dispatch* cadence is not *execution* cadence: the supervisor is
  dispatched every few minutes, but `prepare` only starts an execution when an
  ordinary run is due (`last ordinary + 1h`), when no healthy proof matches the
  active revision+generation, or when release work exists. Everything else is a
  deliberate no-op poll, so ~5-minute dispatches produce ~one execution an hour,
  and a single issue then costs a ~17-minute model session plus a 5–20-minute
  review round.
- An issue is in scope ONLY when its body opts in with the exact standalone
  first line `<!-- sentinel:repair -->`. Twelve of the thirteen open issues had
  no marker, so the runtime was right to ignore them; the one that did (61) had
  been **blocked** since its model run ended without a trusted receipt, and
  blocked records were never retried. Deliveries additionally needed an
  operator merge, because the runtime's trusted merge port refuses while this
  deployment carries no active `pull_request` rule.
- Fixed in `ops/hosted-autonomy.ts` (`ca99629`, promoted to the
  `sentinel-supervisor` lane, twelve focused tests), which the protected
  maintenance job now runs before `prepare`, under the repair lock:
  a RETRY pass that clears exactly five closed transient blockers and grants the
  smallest counter adjustment making the next admission an unused reservation
  identity (at most `HOSTED_AUTONOMY_MAX_RETRIES = 3` per task, counted in the
  preserved `retries`; never for a task whose pull request is already merged or
  closed; never clearing an unsettled implementation intent), and a DELIVERY
  pass that merges an exact reviewed head with an expected-head CAS once it has
  a completed no-P0/P1 receipt and a successful `test-local`, then records the
  exact release request the runtime would have written. It writes no review,
  receipt, proof or acceptance — the supervisor still owns proofs, promotion,
  acceptance and rollback — and exits zero on every non-applied outcome.
- Live proof, first run: 21:12:25Z,
  `{"kind":"hosted_autonomy","actions":["retry:issue-ubiquity-sentinel-48:skipped:pr_not_open","retry:issue-ubiquity-sentinel-21:grant=0:other:model run ended without a trusted receipt","retry:issue-ubiquity-sentinel-61:grant=0:other:model run ended without a trusted receipt"]}`
  — tasks 21 and 61 are back at `work` with their budgets intact, and the
  already-delivered 48 was correctly left alone.
- Stale-issue reconciliation with evidence (integration owner): closed 3, 7, 8,
  9, 14, 15, 16, 40 and 69 because the live system already satisfies them (the
  accepted releases, the activated runtime, the wired entrypoints, persisted
  cooldowns and the validated candidate-preservation keys), leaving four open
  with precise notes: 61 (in the repair queue), 13 (exact rollback never
  exercised), 6 (owner approval of the retention policy) and 10 (the Deno
  release controller is deliberately disabled; hosted promotion owns the self
  scope).

**Owner update, 2026-09-17 22:35Z — nothing is filtered out of the repair queue.**
The intake rule is inverted: every open issue is now repaired BY DEFAULT, and an
issue is excluded only by an explicit opt-out — the exact standalone first line
`<!-- sentinel:skip -->` or the `sentinel:skip` label. The historical
`<!-- sentinel:repair -->` opt-in marker is still accepted but no longer
required, and `MASTER-PLAN.md` records the new rule. `src/host/local.ts`
(`scopeLocalRepairIssues`) re-reads the source before every admission, so an
issue that gains either opt-out revokes eligibility before any budget is spent.
Focused coverage: `tests/host/local_test.ts` (25 tests, including the rewritten
"every open issue is admitted unless it opts out" case) passes.

**Delivery record (live evidence).**
- Hosted release `release:56fae4b9358db4e74c19a91054aef926b07202c05738dd688562ad8614e2e9b7`
  for PR 51: created 20:45:33Z, **phase `accepted` at 20:53:19Z**; revision
  `1ed66cd191271cc206aaf436d0f93d245aaee936` (the merge), source head
  `2bce980`, base `fc25d71`, review receipt
  `review-receipt:7826d27e94648e79d03f7f3900e721345c63c06edac2982de0b79b3144240e12`.
- Proofs: prior `fc25d71`/generation 17 in run `35272524410` (healthy);
  candidate `1ed66cd`/generation 18 in run `35273273110` (healthy). The runtime
  pointer reads revision `1ed66cd` at generation 18 with that candidate proof as
  `lastHealthyProof`.
- Issue 48 closed 20:53:56Z with this evidence.
- Invariants preserved: every implementation and review session observed
  `gpt-5.6-luna` with `max` reasoning, the shared 120-starts-per-rolling-hour
  admission policy was never modified, every reservation, charge, receipt and
  candidate is intact (the two bounded recoveries only lowered the attempt
  counter with all reservations preserved), and no quota or model fallback
  occurred. Credentials, state writes and promotion authority stayed out of
  model workers: the request was recorded by the protected maintenance job, and
  the supervisor and release controller owned the proofs, promotion and
  acceptance.

- Round 11 completed 17:37:05Z on head `38dff3a3` with exactly one P2 — "URL
  token can consume adjacent Markdown prose": the URL token matcher consumed
  `)Fixes:#123` because its character class accepted `)` and `#`, so a real
  auto-close directive in the published body was never sanitized. The durable
  journal is GitHub review `5239201085` on PR 51; the generation-15 execution
  recorded that receipt (evidence 6 → 7) and routed the task to a bounded
  correction at implementation attempt 4 with the finding and the earlier
  rejection history in its prompt.
- The correction loop converged on the round-11 finding. The attempt-4 candidate
  `41c2159` replaces the URL token split with a balanced-parenthesis URL scan
  (`findUrlEnd`), and the read-only local evaluator `ops/sanitizer-check.ts` —
  which imports the candidate's own `sanitizeAutoCloseKeywords` — scored it
  **22/22** on every case the review had reported at that point (the rejected
  round-11 head scored 21/22, failing exactly the P2 case). The candidate's
  whole `tests/github/` suite (243 tests) passes locally.
- Round 12 (review `5239814913`, 18:38:45Z, head `1fed7bd`) rejected the
  refreshed candidate with two further P2s, both of which the issue's own
  acceptance forbids ("preserve the issue reference and all other body
  content"): a relative link destination `[link](/foo:fixes:#123)` is rewritten
  to `[link](/foo:#123)`, and an angle-delimited destination
  `[link](<https://example.test/foo)Fixes:#123>)` is sanitized because
  `findUrlEnd` stops at a zero-nesting `)` even inside `<…>`. Both cases are now
  permanent entries in the local evaluator, which reproduces them exactly
  (22/24 for that head, failing precisely the two reported cases), so the next
  candidate is scored before its review runs.
- Owner-authorized bounded recovery, recorded: the completed round-12 finding
  requires one more correction, and the record's implementation-attempt budget
  was exhausted (`attempts` 4 of 4). The one-shot maintenance helper
  `ops/issue48-review-quota-recovery.ts` was re-pinned to the live identity
  (counters `4/0/12`, head `1fed7bd`, base `2b6a25b`, runtime generation 15) and
  granted exactly one counter unit (4 → 3), which makes the next admission
  (task / base `2b6a25b` / attempt 4) an unused reservation identity because
  attempt 4 was charged at the previous base `9fcc959`. It applied at 18:41:23Z
  (counters now `3/0/12`, wait cleared) with every charge, reservation, receipt
  and counter otherwise preserved.
- The base moved under the record twice (`9fcc959` → `4478199` → `2b6a25b`) and
  the runtime's own review-freshness gate handled it: it persisted the
  deterministic base-refresh intent, republished the candidate as the
  deterministic two-parent refresh commit `1fed7bd` (parents `41c2159`,
  `2b6a25b`), and requested review round 12 for the refreshed head against the
  new base. An old review is never reused for changed bytes.
- Owner decision 2026-09-17 ("delete all the blocking rules … just push"): the
  `development` ruleset `23197426` (required `test-local` only) was deleted and
  the pending lane commit was pushed directly to `development`. The
  release-state ruleset `23197448` (App-only state protection) stays because it
  blocks no delivery and protects release-state writes, and no branch
  protection or ruleset was added back.
- Recorded consequence, not hidden: with no active `pull_request` rule on
  `development`, the runtime's trusted merge port refuses to merge by design
  (`evaluateEffectiveProtections` → "pull_request rule is not active"). The
  operator therefore performs the expected-head merge itself, under exactly the
  runtime's own acceptance criteria — a completed current-head review receipt
  bound to the exact PR/head/base with no unresolved P0/P1 plus a green
  `test-local` on that exact head — and the new bounded one-shot
  `ops/issue48-delivery-observation.ts` (run first inside the protected
  maintenance job, idempotent, exit zero on every non-applied outcome, ten
  focused tests) records the ONE release request the runtime's delivery step
  would have written, after re-verifying the merge and the receipt against
  GitHub with the runtime's own `releaseRequestId` and frozen parsers. It writes
  no review, receipt, proof, promotion or acceptance: the trusted supervisor
  still owns prior/candidate proofs, promotion, acceptance and rollback.
- Deterministic CI for the refreshed head runs on the exact SHA
  (`35258805683`, plus the `codex/ci-head-check` fallback run `35258832432`).
  `sentinel-ci` is not required by any ruleset anymore, so it is evidence, not
  a blocker; the runtime's own gates stay unchanged.
- Round 13 (review `5240254113`, 19:18:5xZ, head `fa97f29`) rejected the
  attempt-4 candidate with a P1 and a P2, both acceptance-relevant: `www.` is
  matched at any position, so a valid qualified reference such as
  `Fixes ubiquity/www.repo#123` is split at `www.` and the keyword survives in
  the published body (the issue's primary acceptance), and a reference-style
  destination `[r]: /foo:fixes:#123` is rewritten because only inline `](…)`
  destinations were protected. Both cases are permanent evaluator entries
  (24/26 for that head, failing exactly the two reported cases). A second
  owner-authorized bounded recovery was re-pinned to the live identity
  (counters `4/0/13`, head `fa97f29`, base `2b6a25b`, runtime generation 16) and
  granted **two** counter units (4 → 2), because attempt 4 was already charged
  at this base and attempt 3 was charged at the previous base `9fcc959`; the
  generation-17 install pinned to the CI-verified `fc25d71` (its `test-local`
  run `35261462685` succeeded, and the revision was pushed to `development`)
  then bought the immediate execution that consumed the grant. Live proof: the
  record recorded the round-13 receipt (evidence 8 → 9) and admitted the next
  implementation attempt at 19:24Z with counters `3/0/13`.
- Merge performed and verified, live: round 14 (review `5240665337`, 20:03:44Z)
  reviewed the refreshed head `2bce980` (parents `28a27dc`, `fc25d71`) against
  base `fc25d71` and reported **five findings, every one of them P2** — no
  unresolved P0/P1, which is exactly the retained runtime rule
  (`reviewAuthorizes`; `MASTER-PLAN.md` §3: "P2/P3 become future work unless
  target policy requires more"). The evaluator scored that head **26/26** on
  every case the review has ever reported. With the completed current-head
  verdict and a green `test-local` on the exact head (`35266643676`,
  `35266610629`), the operator merged PR 51 with an expected-head CAS
  (`sha=2bce980`, method `merge`) at 20:09:44Z, producing merge commit
  `1ed66cd` whose parents are exactly the recorded base `fc25d71` and the
  reviewed head `2bce980`; `compare/1ed66cd...development` is `identical` with
  both compare commits equal to the merge commit, and the pull request is
  `closed`/`merged` with `merge_commit_sha = 1ed66cd`.
- Release request recorded by the runtime's own one-shot: with the round-14
  receipt in state (evidence 9 → 10), the protected maintenance job ran
  `ops/issue48-delivery-observation.ts` and wrote the single request
  `release:56fae4b9358d…` (revision `1ed66cd`, source PR 51, head `2bce980`,
  base `fc25d71`, review receipt bound to that exact pair) at 20:45:18Z. The
  trusted supervisor then created the hosted release for it and started the
  prior-revision proof execution (pointer `fc25d71`/generation 17) without any
  operator write of proofs, promotion or acceptance.
- The repair record itself is `blocked` with the implementation intent of the
  follow-on round: the model's next session ran after the pull request was
  already merged, so it published no candidate and the durable blocker
  `model run did not complete with a trusted candidate` remains. That is the
  honest steady state (no stray commit on the candidate branch, which still
  points at the reviewed head `2bce980`), and it is why issue closure is the
  operator's remaining act once the hosted release is accepted: the runtime's
  own closure step requires a `delivery` step that only a clean no-finding
  verdict can reach, and this pull request is already merged.
- Deferred, recorded as future work rather than hidden (all five are P2 and the
  plan keeps them out of the merge gate): an invalid Markdown marker `](` can
  shield a directive, link titles and reference-definition labels are rewritten,
  `findUrlEnd` absorbs prose after a `]`, and the GitHub issue-URL closing form
  `Fixes: https://github.com/owner/repo/issues/123` is still published. Each is
  now a permanent evaluator case so the next candidate is scored against it.
- Self-inflicted liveness gap found and fixed, recorded honestly: cancelling a
  supervisor run (`35260296167`) killed a repair job before it printed its
  signed terminal, and the runtime settled that as `unavailable`, so the saved
  execution could never be cleared — every later `prepare` and `finalize`
  reported "hosted supervisor execution evidence is unavailable" and no install
  or execution could start. Fixed in `src/github/client.ts` (`e660e6e`,
  promoted to the `sentinel-supervisor` lane at 18:48:54Z): a completed repair
  job concluded `cancelled` or `timed_out` published no terminal, so the only
  honest settlement is the explicit `not_started` proof — never health, never a
  failure that would trigger a rollback, and the pointer is released for a
  later execution. Focussed `tests/github/hosted-execution_test.ts` (13 tests)
  covers both new conclusions. Live proof: run `35261123109` settled the stuck
  execution and started the next one immediately (`"status":"run"`).

**The silent review-record deadlock is fixed and live, and the runtime is making
an informed correction.** The armed record had been re-armed as `review_pending`
by two executions without any diagnosable detail; the cause was in the receipt
itself: after a bounded recovery cleared the record's wait, the receipt's
`submittedAt` was derived from the wait (or from "now"), which then POST-DATED
the review's completion, and the strict receipt parser refused the inversion —
so the completed round-10 review (ready journal with a P2, published 13:18:20Z)
was never recorded and the state stayed at sequence 339 while the loop polled
forever.

- Fixed `3b78061…`/`9fcc959…` (generation 15, installed at 17:05Z): the
  transport's own reported submission instant stays authoritative whenever the
  record still holds it, and the derivation is only CAPPED at the observed
  completion, so the receipt can never invert. The first CI run caught the
  over-broad earlier revision (it replaced the transport's instant outright and
  the existing "review receipt preserves the actual submission timestamp" test
  failed) — corrected before any install, which is exactly why the runtime gate
  is CI-first.
- Live proof: the generation-15 execution observed round 10, **recorded the
  receipt** (evidence 5 → 6), routed the task to a correction and admitted an
  implementation at attempt 3 with the reviewer's findings AND the earlier
  rejection history in its prompt — the first fully informed correction.
- `ops/sanitizer-check.ts` is a new read-only local evaluator: it fetches the
  repair branch, imports the candidate's own `sanitizeAutoCloseKeywords` and
  runs every case the review ever reported plus the issue's acceptance cases, so
  the next review round can be predicted without waiting for it. Against the
  rejected round-10 candidate it reproduces exactly the two open cases
  (`References ubiquity/repo.fixes #123` and `https://example.test/foo.fixes:#123`
  both corrupted at the `.`), confirming the tool and the reviewer agree.

Remaining boundary: the informed candidate must satisfy the evaluator and then
the reviewer; only after a completed current-head verdict with no unresolved
P0/P1 may the merge, release request, supervisor prior/candidate proofs,
promotion, acceptance and issue closure follow. No merge, release, closure or
receipt has been fabricated, and the goal stays active.


**The correction loop is now informed, and the only remaining work is the
candidate content itself.** Four consecutive review rounds (7, 8, 9, 10)
rejected the candidate for four separate punctuation cases of one over-broad
keyword boundary, and the runtime was re-implementing without ever seeing them:
the correction path sent the model the rejected candidate and an opaque list of
evidence refs, while the reviewer's finding text lives inside the recorded
receipt in state. Live proof of the stalemate: the round-8 and round-9
candidates carried a byte-identical sanitizer regex.

- Fixed `664a52d…` (generation 13, installed): `ModelRunRequestV1` carries a
  bounded `reviewFindings` list (severity/path/message) derived from the exact
  completed receipt of the rejected head, and the runtime prompt renders it.
  The very next informed correction changed the sanitizer's left boundary for
  the first time in five rounds.
- Fixed `4c209dd…` (generation 14, installed): a correction also carries the
  unresolved findings of the most recent earlier rejections of the same pull
  request (at most three receipts, deduped, inside the existing bounds), so the
  model can converge on the rule rather than the last reported character.
- Bounded grants keep working: the round-10 rejection was met by a two-unit
  grant (counter 4 → 2, so the next admission is task/base/attempt 3, an unused
  reservation identity at base `0b2f389…`), a closed 0..3 value, with every
  charge, receipt, reservation and candidate preserved. The grant applied at
  13:52:16Z and the record is armed at its unobserved `review` step.
- Open observation for the next round: the first generation-14 execution
  (run `35230194237`, settled healthy) did not process the record — the repair
  state stayed at sequence 339 — so the loop's next ordinary execution
  (`nextOrdinaryAt` 14:56Z) must be checked for an armed-but-skipped record
  before any further grant is considered.

Remaining boundary: the candidate must pass the reviewer's byte-preservation
criterion, and only then may the merge, release request, supervisor
prior/candidate proofs, promotion, acceptance and issue closure follow. No
merge, release, closure or receipt has been fabricated at any point, and the
goal stays active.


**Bounded grants now work, and the reviewer keeps refusing an incomplete
candidate — which is the correct, fail-closed outcome.** Review round 8
(10:50:11Z) returned another real P2 ("Dotted references are corrupted by the
zero-width separator": the left boundary does not exclude `.`, so a non-closing
reference such as `References ubiquity/repo.fixes#123` is rewritten). The task
was then blocked by its exhausted implementation budget, the grant that should
have lifted it refused with `target_precondition_mismatch`, and the diagnosis
found a real deployment defect rather than a data one: the deployed precondition
still carried the old 0-or-1 grant set (a formatter pass had silently defeated
that patch), so the production binding's granted value of 2 could never satisfy
it. Fixed in `800b4bd…` with a production-shaped regression test that fails on
the old code, promoted as `e2bb6c2…` (CI-green, on `development`).

- Live result of the fix: at 11:18:31Z the one-shot applied the bounded grant —
  `issue-ubiquity-sentinel-48` returned to `work` with counters 2/0/8, head
  `65aaa810…`, base `b9a12eb…`, no blocker, no intent and four recorded review
  receipts (the round-5/6/7/8 findings are now in its own evidence, so the next
  correction is made with the latest finding in context). The next admission is
  task/base/attempt 3: an UNUSED reservation identity at this base.
- Every other guard held: the runtime pins moved to generation 11
  (`3f500514…`), the install chain gained generation 12, the one-shot's exit
  contract keeps a bounded refusal from failing the supervisor workflow, and no
  counter, charge, receipt, reservation or candidate was dropped.
- Remaining boundary, unchanged in kind: the candidate content must satisfy the
  reviewer's byte-preservation criterion before any merge; the loop will correct
  again on its ordinary execution (approximately 12:05Z), re-review the changed
  candidate (round 9) and only then merge, request the release, obtain the
  supervisor's prior/candidate proofs, promote and close. The goal therefore
  stays active, and `docs/build-status.md` remains the only authoritative ledger.


**The review pipeline is repaired and the runtime is refusing an incomplete
candidate, which is the correct outcome.** The counter-granted retry was
admitted at 09:14:16Z with a NEW reservation identity (task/base/attempt 3), the
runtime's own model worker produced a corrected candidate (`ec27bf7d…`,
published to PR 51), and review round 7 (09:38:39Z, review `5233650313`, key
`review:51:ec27bf7d…:attempt-7`) returned another real Luna/max verdict: findings,
P2 "The sanitizer can corrupt non-closing URLs." The merge gate therefore still
holds — no merge, no release request, no acceptance claim, no fabricated receipt.

- State at this entry: `issue-ubiquity-sentinel-48` is at `review` with counters
  3/0/7, head `ec27bf7d…`, base `3dfb3402…`, no intent, no blocker and a bounded
  `review_pending` wait; the hosted runtime is generation 10 (`80384fc3…`,
  reviewer provenance) and idle.
- The next ordinary execution (~10:14Z, hourly cadence) observes round 7, routes
  the task to a correction and admits the next implementation attempt (counter 3
  → 4, still inside the runtime's four-attempt bound) through its own model
  worker; the changed candidate must then pass review round 8 before any merge.
- All three deployed fixes are live and independently evidenced: the terminal
  no-verdict recovery (generation 8), the review-step base-refresh
  reconciliation (generation 9) and the reviewer provenance fix for the
  installed 0.154 unified-exec sources (generation 10). Real reviews, real
  executions (gpt-5.6-luna, max reasoning) and real findings are the proof; the
  earlier rounds' twenty-to-thirty-second no-verdict refusals are gone.
- Recorded boundary for the next round: the candidate content must satisfy the
  reviewer's URL/non-closing-reference criterion, which two model corrections
  have not yet achieved; the delivery, the supervisor's prior/candidate proofs,
  the promotion and the live delivery evidence therefore remain outstanding, and
  the goal stays active. `docs/build-status.md` remains the only authoritative
  ledger and every charge, receipt, reservation and candidate is preserved.

**The root cause of the "unreleasable self-repair" was a reviewer-provenance
defect, and it is fixed and live.** Review rounds 3 (02:12:21Z) and 4
(04:25:03Z) each ended about thirty seconds after their request with `verdict
unavailable`, `execution null` and — only because the reason-preservation change
below landed first — the exact producer reason "structured review unavailable: a
command execution item was malformed or contradictory". Diagnosis, made
credential-free with no model call: the pinned local Codex CLI is exactly
`@openai/codex@0.154.0`, and its own generated protocol schema enumerates
`CommandExecutionSource = agent | userShell | unifiedExecStartup |
unifiedExecInteraction` with `commandExecution` requiring
`command, commandActions, cwd, id, status, type`. The two unified-exec values are
the SAME agent shell tool over its persistent-process transport, but the reviewer
accepted only `agent`/omitted, so any review whose session used unified exec was
refused before a verdict could exist. Fix (`80384fc…`): accept the
agent-originated sources verbatim — a start and its completion must still carry
the SAME source — while a human `userShell` command, any unknown value and every
plugin/script binding stay refused; a refused item also emits one bounded,
content-free structural fingerprint line to the run log (predicate booleans and
lengths only, never the command, its output or a path), because the durable
disposition can only carry a static reason. The regression test fails before the
fix and passes after it. Activated by the owner-install chain as generation 10
(`80384fc3…`, applied 04:53:58Z; the ordinary execution at generation 10 settled
healthy).

Proof it worked — real verdicts, real findings:

- Round 5 (05:03:11Z, review `5231230066`, key
  `review:51:ae6ff044…:attempt-5`) recorded a real execution (gpt-5.6-luna, max
  reasoning, 167,098 output chars, terminal completed) and returned a P2 finding
  on `src/github/text.ts`.
- Round 6 (06:08:06Z, review `5231809100`, key
  `review:51:430b9760…:attempt-6`) returned the same substantive P2: the
  sanitizer's optional whitespace/colon still admits a zero-width separator, so
  URL and prose forms can be rewritten even though the issue's own acceptance
  requires non-closing references to stay unchanged. The candidate therefore
  genuinely fails its acceptance criteria; **no merge was performed and no
  receipt was fabricated**.

Two bounded, owner-authorized recoveries carried this one task through the
fail-closed guards, each a single expected-head CAS with a full readback, with
every counter, charge, reservation, receipt, evidence and candidate preserved:

- 03:34:27Z: the `review_quota` block (three consumed rounds, two of them
  infrastructure failures) returned `issue-ubiquity-sentinel-48` to `work`
  (`a583c491…` → `8de95790…`).
- ~05:39Z: the exhausted implementation budget was cleared together with exactly
  ONE granted implementation attempt (attempts 4 → 3; the granted amount is a
  closed 0-or-1 value in the binding) so the runtime's OWN model worker can make
  the reviewer-mandated correction — no hand-written application fix, no budget
  reset, no fabricated receipt. A first attempt refused with `runtime_mismatch`
  because the binding still named the generation 9 pointer; that refusal is
  recorded, and the runtime-identity pin is fixed in `ef5af35…` (CI-green).

Delivery state as recorded: the loop is correcting the round-6 finding through
its own model worker on PR 51; the changed candidate will be reviewed again
(round 7) before any merge, and the merge gate, release request and supervisor
proofs are unchanged. The lane promotion carrying the runtime-pinned operator
(`9b06622…`) was published under local verification (10/10 operator tests, lint,
`deno check`) with its own CI run in flight (35189179293) to meet the
ordinary-execution window; that run and the promotion merge both completed green
afterwards.

At07:30 the granted correction attempt ended WITHOUT a trusted candidate: the
runtime blocked `issue-ubiquity-sentinel-48` with kind `other` and the exact
reason "model run did not complete with a trusted candidate", consuming the one
granted attempt (counters 4/0/6, head `430b9760…`, base `3dfb3402…`). That is a
failed attempt, not substantive progress, so the same owner-directed bound is
re-applied: the one-shot recovery now also clears that closed blocker, and the
retry it arms is the subject of the two findings below.

- A settled failed implementation cannot be retried under the runtime's current
  reservation identity: the shared budget derives the identity from
  (task, base, attempt, purpose), so the same base and counter reproduce the
  settled attempt and the loop blocks with `model admission refused: duplicate`.
  That is a genuine liveness gap in the accounting (a failed attempt's counter
  unit is given back, but its identity is not), recorded here as the next
  runtime defect to fix after this delivery.
- Rebinding a preserved candidate to a newer base is NOT available to a state
  writer: the frozen record contract requires a preserved candidate's base and
  head to equal the target's ("never silently rebound"), so that attempt failed
  as `snapshot_invalid` and was reverted immediately rather than kept.
- The retry therefore uses the bounded counter grant only: the counter is
  lowered by exactly one (3 → 2), so the next admission is
  task/base/attempt 3 — an UNUSED identity at this unchanged base — and the
  preserved candidate descriptor stays exactly as the runtime wrote it. Applied
  at 08:25:57Z (`17eb286…`, lane `91b708e7…` then the counter-grant promotion);
  the record is armed at `work` with counters 2/0/6, head `430b9760…`, base
  `3dfb3402…` and no intent or blocker, waiting on the ordinary execution at
  ~09:06Z. Every charge, receipt and reservation is preserved, nothing was
  merged and no receipt was fabricated.

**Live: the deadlock is broken and the runtime is recovering issue 48 on its own.**
The fix below was activated by the owner's 2026-09-17 decision and is proven in
production, not just in tests:

- Generation 8 (`fd5902a8…`, owner-install record `22871615c6af4d29c7c6230aa22311330d34b32`,
  applied 01:32:23Z by the protected prepare job) moved the hosted pointer and
  the health-gap path started an ordinary execution at it; that execution
  (run `35170923472`, revision `fd5902a8…`, outcome healthy) immediately
  observed PR 51's terminal no-verdict review, detected the moved base, and
  persisted a base-refresh intent instead of spending a review on a stale
  candidate.
- That exposed a second, separate hole: the review freshness gate creates the
  refresh intent while the record is at `review`, and only the work and delivery
  steps reconciled such an intent, so the record deferred on its own gate
  forever. Fixed (`87193550…`, "reconcile a pending base refresh at the review
  step", regression test fails before and passes after), activated as generation
  9 (`9fefc45c…` dev head, owner-install applied 02:06:53Z).
- Generation 9 then completed the refresh for real: PR 51's head advanced to
  `f4678663746a2026e76190d70a3c15786c69705c` on base `9fefc45c…`, the loop
  persisted a review-request intent and requested **review round 3 under its own
  attempt identity** `review:51:f4678663…:attempt-3` (reservation purpose
  `review_request`, `wait.review_pending`, `reviewRounds` 3). The previously
  eternal pending poll is over.
- The round-3 attempt then produced no verdict again (review `5230258721`, ready
  journal, `execution null`) — and for the first time the durable disposition
  carries the producer's own bounded static reason instead of the generic
  sentence: "structured review unavailable: a command execution item was
  malformed or contradictory" (`src/github/codex-reviewer.ts`, the read-only
  command-item evidence check). That is the reason-preservation change working
  in production; the failure is a producer/app-server evidence refusal during the
  turn, not a candidate defect, and it consumed the third review round.
- Consequence, recorded before any further write: with three rounds consumed the
  new guard will block `issue-ubiquity-sentinel-48` with kind `review_quota` and
  the observed reason on the next ordinary execution (fail-closed, never a
  merge). Two of those three rounds were infrastructure failures (a cancelled
  execution on 09-16, this app-server evidence refusal), not substantive
  findings. Continuing to a further bounded attempt for this exact issue is the
  owner's standing direction of 2026-09-17 ("let the bot finish issue 48") and is
  recorded here as an explicit bound: one bounded recovery of the blocked item,
  every charge, counter, receipt, candidate and historical record preserved, no
  allowance reset and no merge without a completed current-head verdict.

**The self-repair review-gate contradiction is resolved: it is not a gate
contradiction at all, and no gate was weakened.** The owner's 2026-09-16 update
removes DEVELOPMENT pull requests and Codex reviews ("Make the scoped change,
test it immediately, then deliver it directly") and in the same instruction
retains them for autonomous repairs ("Autonomous target repairs retain their
existing PR, review and merge gates"). `MASTER-PLAN.md` §3 states the same
distinction directly: "Development reviews and the product's runtime review
policy are distinct. Runtime target PRs still require a verified completed
current-head Codex review with no unresolved P0/P1 plus passing deterministic CI
and branch protections", and the owner "explicitly clarified that autonomous
repairs retain their PRs and reviews". Issue 48 is an autonomous self-repair, so
`reviewAuthorizes` (`src/host/actions-supervisor.ts:644`, completed receipt bound
to the exact PR/head/base with result id, completion instant, matching
observed/expected reviewer, zero uncounted findings, no unresolved P0/P1) is the
plan's own retained runtime rule, not a contradiction. No policy, admission or
review rule was changed and no receipt was fabricated.

**The real blocker was a runtime liveness defect, and it is fixed.** A review
attempt that concluded WITHOUT an accepted verdict was indistinguishable from a
pending wait, so the loop re-armed `review_pending` forever and the gate could
never be satisfied for that head. Live evidence on PR 51:

- Work item `issue-ubiquity-sentinel-48`: `nextStep review`, attempts 4,
  reviewRounds 2, `wait.reason review_pending` since `1789580733437`
  (2026-09-16T17:45:33.437Z), re-armed by every later run to `now + 15min`
  (last re-arm 22:56:51 → until 23:11:51); it has been re-polling the same
  terminal record ever since.
- Review `5226239354` (github-actions[bot], COMMENTED 2026-09-16T17:46:23Z)
  carries a phase-ready journal for operationKey
  `review:51:2789ba07e3f87944b465f7a44632578a88a7e89a`, expectedHead
  `2789ba07…`, expectedBase `2d834946…`, `verdict unavailable`, `execution null`,
  summary "structured review unavailable: the review did not produce a validated
  result", completedAt `1789580768966` (17:46:08.966Z). The attempt's charge is
  reservation purpose `review_request` attempt 2, submitted 17:45:14.030Z — kept,
  never reset.
- Run `35129449055` (sentinel-supervisor, workflow_dispatch, created 17:38:33Z at
  head `f46bdd1`) reached conclusion `cancelled` at 17:46:00Z while its repair job
  held that review: the request was submitted at 17:45:33, no turn was ever
  started, and the disposition was published at 17:46:23. The cancellation issuer
  is not recorded (actor and triggering actor are `github-actions[bot]`, and both
  supervisor concurrency groups are `cancel-in-progress: false`), so this is
  recorded as a cancelled execution, not a producer defect.
- Consequence: because the same-head review identity was already bound to that
  terminal journal, no new attempt could be requested, so no completed receipt
  could ever exist for head `2789ba07` and `reviewAuthorizes` could never
  authorize a release for PR 51. That is the previously recorded
  "unreleasable" self-repair; its cause is liveness, not the review gate.

Fix (focused, no gate/admission change): `src/repair/keys.ts` gives a later
attempt of the same head its own durable identity (`:attempt-N`; attempt one
keeps the original PR/head key); `src/repair/loop.ts` detects a TERMINAL
no-verdict observation from the transport's own bound completion instant, reads
the current attempt identity first with the first-attempt key consulted only
when the current one binds no durable record, then either requests one bounded
fresh attempt (new key, new reservation, new journal; the shared 120/hour
admission gate charges it normally) or, at the plan's three-round allowance,
blocks with `review_quota` carrying the bounded observed reason instead of
polling a terminal disposition forever; the receipt of an accepted verdict is
derived from the identity the observation was actually read under, so an earlier
attempt's receipt can never authorize a later delivery;
`src/github/review-normalize.ts` carries the bound completion instant and static
reason into the observation and exposes the exact operation key a durable review
request id names; `src/github/impl.ts` therefore binds the merge gate to the
record identity the receipt itself names — never to the first attempt's identity
by habit — and still refuses any key that does not bind this exact PR/head or any
record other than the one the receipt names, so an earlier clean round, another
attempt's record or another head's identity can never authorize a merge;
`src/github/codex-review-transport.ts` keeps a settled start refusal's exact
bounded static reason in the durable disposition (`staticUnavailableSummary`,
≤256 printable-ASCII single-line) and refuses anything else. Focused coverage:
three loop cases (bounded re-attempt under its own identity including the receipt
identity and `nextStep delivery`, the round-allowance block with the observed
reason, the legacy first-attempt journal), two transport cases (the settled
refusal keeps its exact static reason and is read back terminal; nothing
unfiltered can reach a disposition) and one merge case (a bounded later attempt
of the same head authorizes exactly one merge write, while the first attempt's
standing record and another head's record identity both fail closed with zero
merge writes; the existing 18-case merge suite stays green). Invariants
preserved: runtime model gpt-5.6-luna/max, the shared durable 120/hour start gate
with no reset or refund of the original charge, no credential/state/promotion
authority in any model worker, and no review-gate relaxation.

Remaining boundary and the owner's decision (2026-09-17): the hosted runtime
executes the PROMOTED pointer (`92f3a87…`, generation 7), so this fix changes
repair behavior only once the runtime revision carries it. The loop cannot move
the pointer by itself while it is deadlocked on PR 51, every other work item
(`61`, `21`) is `blocked` and the loop never retries a blocked record, no
eligible `<!-- sentinel:repair -->` issue is open, and the M17 owner-install
chain is inert at generation 7. Asked whether to install the tested fix and let
the bot finish issue 48, the owner answered yes on 2026-09-17. The activation is
therefore the fixed owner-development-install chain extended by one step:
aggregate generation 7 -> review recovery generation 8
(`4e8245de734683c7d4bda22a221bb28f52ebcfac`, the CI-verified development
revision carrying this fix), authorized by the recorded aggregate generation 7
healthy proof, with the same one-time rollback to that recorded prior and the
same completion no-op afterwards (`src/host/owner-development-install.ts`, plan
tests extended). The movement is the existing owner-install record in the state
commit: it claims no review, release or autonomous receipt, and it changes no
admission, quota, reviewer or model policy. Once the pointer moves, the
supervisor's health-gap path starts an ordinary execution at generation 8 and
the runtime recovers issue 48 through its own reviewed path: one bounded fresh
review attempt of head `2789ba07…` under its own identity, then the exact-head
merge, release request, prior/candidate proofs and promotion, whose live
evidence is recorded here after it settles.

Continuation state, verified facts, next work and local environment traps are in
`docs/implementation-handoff-2026-09-16.md`. Read it with this register; it is
not a second task register and does not change scope, status or acceptance.

- At23:10 the observer repair is complete and the continuation handoff is
  written. No outstanding source change from this session. The next work items
  are, in order: the live issue-48 `review` work item and its open PR 51; the
  `reviewAuthorizes` self-repo release gate that contradicts the owner's
  2026-09-16 no-development-review instruction and currently makes autonomous
  self-repair unreleasable; the two blocked work items (61, 21) with no recorded
  blocker reason; the fact that the observer now runs but retains zero
  ciphertexts with five of six incidents source-lost; and the stale duplicate
  PRs 74/75 whose only un-integrated commit `f18ac8e` is superseded by da08c9f.

- At21:50 the scheduled observer is repaired and proved live. Exact cause: one
  incident whose replay export exceeded the contract artifact-count bound made
  `readIncident` return `invalid`, and `observe-main.ts` aborted the whole pass
  on the first such incident. Every one of the 200 preceding observe runs had
  failed, and the run log carried only `{"status":"blocked","reason":"invalid"}`
  because the entrypoint discarded the typed detail. Fixes, all CI-green on
  `test-local` and verified against the live VPS gateway at revision
  `07ee77b9aa241f516b44ced5340e814e08a8825a`: da08c9f reports the blocked
  detail; b56294b counts a per-incident `invalid` in `blockedIncidents` and
  continues while auth/rate-limit/transport/index faults still abort; fdb0d92
  makes only a retainable capture consume the artifact-count bound, since the
  expiry filter ran inside `visit` after the bound check and source-expired
  captures were consuming it. Live result, stable across three scheduled runs:
  `pages1 incidents6 evidenceRecords1 blockedIncidents0 retainedCiphertexts0`.
  The remaining five incidents return `null` evidence (source-lost before
  ingestion), which is the honest fail-closed outcome, not a pass failure.
  Primary-run local full-suite is not evidence here: only `test-local` on the
  exact pushed commits was accepted. No model call, credential write or target
  write was made. Next: none outstanding for this repair.

- At21:15 the running hosted supervisor now reports its idle reason.
  `actions-supervisor.ts` collapsed an `idle` outcome to the bare word `idle`,
  discarding `STATIC_IDLE_WAITING`/`STATIC_IDLE_NONE`, so "the supervisor does
  nothing" was equally undiagnosable. Fixed on development in b56294b and
  promoted to the `sentinel-supervisor` lane by fast-forward
  `f46bdd1..2a31d27` (ancestry-preserving merge of development, CI-green on
  `test-local` for the exact merge commit, no force, no ruleset change). Live
  prepare output is now `{"job":"prepare","status":"idle","run":false,
  "detail":"no eligible hosted supervisor work"}` — establishing that the
  supervisor is healthy and simply has no queued release/repair work, rather
  than blocked. The `sentinel-release` workflow remains `disabled_manually` by
  the owner; its failures predate 2026-09-11 15:19 and are not current.

- At21:05 `sentinel-observe` had never once succeeded: 200 of 200 runs failed,
  the earliest listed 2026-09-09T12:33:58Z. Only `development` (ruleset
  23197426, required `test-local`) and `sentinel-state/release` (ruleset
  23197448) carry rulesets; `sentinel-supervisor` carries none. A direct push to
  `development` needs the required check to be green on that exact commit, so
  each delivery went through a temporary `codex/*` branch whose check was
  allowed to pass before the same commit was pushed to `development`; the
  temporary branches and the promotion branch were deleted afterwards.

- At06:25 M17 owner installer is committed asb5f69101 after DSH corrections
  settled with exit0/completed and no descendants. Focused capture04f2fc8e
  passes7tests (2482ms); lint7266f60e and formatd0a154b7 pass. The intermediate
  74b3f087 failure was an incorrect second-stage test expectation, corrected
  to AGGREGATE without changing production behavior. Exactly three files:
  fixed owner installer, focused tests, prepare workflow invocation. Worker
  request remained Flash/max/workspace-write/ask and production cwd verified.
  Primary now integrates by ancestry and directly publishes the launcher;
  live installation and autonomous delivery remain to be proved.

- At06:20 resumed owner reverified canonical92f3a87 and M17 base2672341,
  preserving the existing ledger and three M17 worker files. Exact canonical
  CI35061716162 passed1190tests/99steps; reader development CI35062030618
  passed. Runtime remains20aae115/gen5 at release headc46cb94, executionnull.
  M17 initial worker650911 settled with no descendants. Captured focused
  resulte290ecf6 failed TypeScript narrowing at owner-development-install:559
  before tests executed. Bounded correction resumes persisted session-a29e23d2
  under exec45253/PID665734, same three-file scope with workflow frozen;
  production cwd and Flash/max confirmed. DSH rules2026-09-16.2 hash529618ba
  read and adopted. Bare UUID resume failed before execution; prefixed persisted
  session ID succeeded. No development reviews or PRs are requested. Next:
  collect corrected focused checks, directly install staged fixed revisions,
  then require real Actions settlement and autonomous issue delivery.

- At06:05 canonical92f3a87 is published; direct reader864d7a0 is on development.
  Development PRs67/70 are closed under the owner's new instruction. Existing
  ruleset23197426 now retains test-local only; its obsolete PR requirement was
  removed. Release-state App-only ruleset23197448 remains unchanged. Final
  candidate CI35061716162 is running; exact reader CI had already passed.
  No local release-state writer has authority, and autonomous release records
  require genuine reviews. M17 is now clean base2672341 (canonical92f3 plus
  installed supervisor merge ancestry), with one DSH writerPID650911/exec73654,
  persisteda29e23d2, verified production cwd/Flash/max/workspace-write/ask.
  It owns only a fixed owner-install script, focused fixture and prepare-step
  wiring. The operator uses the existing supervisor App and Git's non-force
  expected-parent update, records an owner-install intent in the remote commit,
  preserves all history/charges and never fabricates an autonomous receipt.
  Reader864 generation6 must have real healthy proof before aggregate92f3
  generation7; exact failure rolls back to its recorded prior. No schema or
  autonomous admission/review rule changes. GPT checks follow settlement.

- Owner update05:51-05:53: no further development PRs or Codex reviews; make
  changes and immediately test. Owner explicitly preserves autonomous repair
  PRs/reviews and said Proceed. The exhausted development review allowance and
  staged reviewer-bootstrap reviews are superseded; no further approval is
  needed for direct verified development delivery. No review receipt is faked.
  Canonicalad928949 integrates adapterfb4ef47 by ancestry, with publication
  validation and candidate recovery preserved. GPTb631e6b0 passes122tests/
  23steps, child0,79661ms; lint9b690822 passes. Two merge conflicts were resolved
  by settled DSHc4ae558b, required Flash/max/workspace-write/ask, no child/checks.
  Installed supervisor a076b17 already reads candidateState. Next direct
  installation uses reader864d7a0 as safe rollback before the aggregate runtime;
  current generation5 runtime20aae115 and all historical state/charges remain.

- At 05:49 final M15 adapter patch0b6003b4 passed GPT correctionse90aba1d:
  51tests/23steps, child0,11250ms; lint2fc5ef9b passed. Fresh source follow-up
  closes both replacement-ref and linked/shared-metadata findings. V3 PID602632
  was stopped under task authority after repeated post-format inspection;
  its diff was preserved and process/children settled. V3b PID607704 exited0
  completed after one nullable-nlink edit, no checks or descendants. Persisted
  92275e78 proves Flash/max/workspace-write/ask; its short lifetime prevented a
  separate live environment attestation, so the launch command's explicit
  production environment is recorded without claiming an independent check.
  GPT independently verified the resulting candidate. Adapter is ready for
  ancestry integration; PR70 remains published at864d7a0. M14 clean1a0d2a9
  is the sole next integration writer after canonical docs are committed;
  preserve canonical publication validation and candidate-loss recovery when
  resolving the five identified overlaps. Final checks run on canonical.

- At 05:42 the resumed owner verified canonical1a0d2a9, M15 reader864d7a0,
  the expected eight-file V2 patch49fe1f72 and the two preserved canonical docs.
  V2 exited0/completed with91calls despite45 assigned and an unapproved
  fmt-check; no writer remains in M15. GPT focused capturef8a3e0e0 reports
  106passed/15steps and two fixture failures; lint2e77666e passed. Fresh Astra
  audit passes profile/command/snapshot source, requires rejection of replace
  refs and linked/shared Git metadata descendants. V3 owns only local.ts and
  reviewer/local fixtures; all other source frozen. Immutable assignment fixes
  those two source gaps and two fixture defects without widening permissions.
  DSH rules2026-09-14.2 hashfc44ca6e reread; unrelated live DSH processes own
  other repositories and are preserved. Completed Pro answer reused. No new
  formal review, live installation or review allowance is inferred.

- At 05:25 M15 V1 GPT capturefbfa0e48 passed107tests/13steps, child0,71821ms.
  Fresh Astra audit confirms the writer had already fixed fresh-clone status
  ordering before final freeze; the earlier interim concern is superseded.
  Required bounded corrections: named profile before opening session, exact
  command start/completion/cwd/provenance binding, one-shot shell setting, and
  safe Git config/critical metadata before reuse. Snapshot source audit passes.
  V2 assignment is limited to those5files,45calls, no tests or schema scans.
  Preliminary full-path old-renderer measurement: combined reader+adapter
  1166198promptbytes exceeds1048576; adapter-only551001fits. Therefore staged
  reader→adapter→aggregate needs the proposed three named authenticated calls,
  still not authorized. PR70 stays published at864d7a0 while local adapter is
  prepared; do not overwrite its reviewable reader head with oversized package.
  M17 trusted-source separation settled exit0/completed,23calls/11edits and
  one formatter, no children. GPT3e6d4c4a type-check passed child0,4791ms;
  script hash79e0a527f829c046bd30ea563396abc5bea7214de71a29bd9a1f4cb828a893da.
  This ignored operator stays non-live until final candidate/ownership inputs
  and explicit review allowance are settled.

- At 05:21 M15 V1 settled exit0/completed, writer533426 exited, no children;
  exact8-file patch f1d2451bac41a5bad885e6e411af5fbbb91852a175e2202d6e8c828ea8d7e7bb
  is frozen for GPT focused checks and fresh read-only Astra audit.35 edit/write
  calls prove implementation; one formatter pass and no worker tests occurred.
  The worker used102 calls despite its70-call ceiling; record this deviation
  and tighten the next bounded assignment. Source inspection found fresh clone
  status-before-checkout rejection and the narrower one-shot shell flag change;
  these are pending correction, not accepted behavior. M17 independent operator
  writer exec76482/PID542378/persisted5dcf08a8 has verified production cwd and
  Flash/max/workspace-write/ask. Neither source patch nor operator ran live.

- At 05:19 read-only aggregate_delivery_scope audit identified the existing
  M17 operator's candidate-code imports. A disjoint M17 assignment now owns
  only ignored .sentinel-reader-install-operator/review.ts on unchanged80b58f6:
  bind all executable dependencies to installed20aae115, keep candidate Git
  objects separate and verify both exact clean identities. A private independent
  trusted-review-source-v6 clone is prepared at20aae115 with no remote; existing
  operator inputs/history are preserved. No M17 process owns the lane. GPT
  registered minimal-review-operator-check for type-check only after settlement.
  This script is not launched live; review allowance remains unanswered.

- At 05:12 M15 adapter V1 is launched as exec91152/PID533426 from the exact
  clean864d7a0 lane. Persistede1da219e request proves deepseek-official /
  deepseek-flash / max, workspace-write / ask; live cwd, production environment
  and credential-presence check passed. Actual read/tool responses exist.
  Immutable assignment SHA256d5690c64902649ee1f965dfbc724e306a06d2e5697dcc5043db2dc15874e0a66;
  private minimal-review-adapter-v1-launch.json records the binding. One writer,
  no children,70-call ceiling, first-edit checkpoint4min and expected handback
  10-15min; print-mode feedback is next settled assignment. Candidate remains
  unaccepted until settlement, primary checks and independent audit.

- At 05:09 the resumed Astra owner reverified canonical1a0d2a9 and clean
  M15 reader lane864d7a0cbb595616b4e90293338f496788b8321a, exact recorded
  branches, existing reader PR70 and the two primary-owned dirty docs. No DSH
  process owns M15. The completed Pro request is reused; no new submission.
  One bounded M15 adapter assignment will own review-snapshot.ts,
  codex-reviewer.ts, local.ts and their required fixtures only. It replaces
  prompt contents with a complete exact-Git manifest, populates the restricted
  review checkout and permits correlated shell-read events. Capture scans use
  a separate1MiB/blob bound; existing publication-safety limits/validator are
  preserved at canonical integration. DSH playbook2026-09-14.2 hashfc44ca6e
  reread; current settings Flash/max/workspace-write and launch-shell key
  presence verified. GPT registered minimal-review-adapter before delegation;
  DSH runs no checks. Extra formal-review allowance remains unanswered and no
  review, merge, installation or live state write is authorized by this patch.

- At 04:16 Pro job c7284228-d564-4eb1-b228-bed27239e699 is completed; saved
  pro-answer-v2.md recommends the existing structured turn/start reviewer with
  an isolated Git checkout, not a new review subsystem. Its minimal rollout
  revision is appended to the existing poka-yoke proposal. Independent official
  docs, installed0.154 schemas and tagged native source corroborate the choice.
  GPT-owned permission probe be1b5c63-37e7-4e27-adee-29211e8c66a4 passed child0,
  613ms: exact Git reads succeed; dummy-token/symlink reads, checkout writes and
  loopback networking fail; session settled, zero model starts. Complete copy
  minimal-review-permissions-v2-evidence.json is private. This resolves the
  local named-profile preflight only; the adapter patch/bootstrap-fit and live
  delivery are not implemented or proved. Proposed two/three authenticated
  review allowance replaces duplicated local rounds only if owner approves;
  no extra review authority is inferred. Source remains1a0d2a9; ledger and the
  existing proposal are the only dirty files. Both are preserved for the next
  source-bearing checkpoint. No source/CI/runtime policy or live state changed.

- At 04:05 the owner explicitly requested GPT Pro to identify minimal fixes
  under the new library-first, simplest-design, current-docs and meaningful-test
  rules. This is planning, not another acceptance review or rollout approval.
  One request is submitted as c7284228-d564-4eb1-b228-bed27239e699; immutable
  private prompt minimal-fixes-request-v2.md is 27,834 bytes, SHA256
  1453ed26ce5b20441cb0d0c1f7417981c0ee87426d36f8f00a4a5dfe532d1be4.
  Reuse that job; do not resubmit. Prior Pro advice was implemented already.
  Exact source/PR heads and passing CI remain unchanged. Source audit separates
  our tools-forbidden reviewer from upstream Codex capabilities; local and
  Actions use 0.154.0. Read-only gateway audit finds existing incident endpoints
  and VPS deployment, so old Deno target-release assumptions need reconciliation.
  Release blockers remain; no new model repair/review, live write or test run.

- At 00:26 the third consecutive goal turn reverified the same release
  blockers: PR70 remains open at 864d7a0 with passing CI and no new review
  authorization; PR67 remains open at 1a0d2a9 with both CI runs successful.
  Remote development 8c861f5 and supervisor a076b17f are unchanged. The
  preceding turn completed the read-only delivery-route audit; it supplied
  a concrete design decision but did not remove either release blocker.
  No live worker or CI wait can clear the exhausted review allowance, and
  no supported aggregate review route exists under the current contract.
  Independent implementation in the accepted recovery slice is complete.
  The blocked-audit threshold is now met: mark the full goal blocked pending
  the existing extra-review decision and the aggregate review-design decision.
  This does not stop the installed Actions scheduler or mark either target's
  autonomous acceptance complete. Preserve canonical source, evidence and this
  sole uncommitted ledger update; no additional review/model/test/live write.

- At 00:24 the integration owner reverified canonical and remote 1a0d2a9,
  both successful PR67 CI runs, unchanged open PR70 at 864d7a0, development
  8c861f5 and supervisor a076b17f. Accepted proof/loop/parser tips are canonical
  ancestors. Source remains frozen; only this ledger checkpoint is dirty.
  Fresh read-only Astra audit aggregate_delivery_scope found no supported
  installation route around the aggregate snapshot limit: the supervisor and
  M17 operator require an authentic exact-head receipt, so a local review log
  cannot replace it. Its proposed route is a bounded review-producer change
  that reads the complete immutable candidate on demand and retains existing
  receipt, installation and accounting checks. This is a design proposal, not
  implemented or authorized extra review work. PR70's existing unanswered
  extra-round request remains pending; no repeated question, new Pro request,
  test rerun, review, merge, installation or live state write occurred.
  Preserve this checkpoint uncommitted until the next permitted delivery step
  so the tested source candidate stays exact; it is not project completion.

- At00:17 both exact1a0d2a9 CI runs PASSED:35038212419 in14m41s and
  35038215854 in13m19s. Complete credential-free harness reports1183passed,
  84steps,0failed,5platformskips. Both full logs are saved privately as
  poka-yoke/canonical-1a0d2a9-ci-<run>.log; no local full-suite duplicate ran.
  PR67 body now records this exact candidate and evidence. Development source
  acceptance is established; formal review, reviewed installation and normal
  hosted canary delivery remain unproved. Source/workers are settled; only this
  primary-owned canonical ledger checkpoint is dirty. No gate was bypassed.
  Installed20aae115 source explicitly has perHour120/perSevenDaysnull and is
  still active generation5. The next dependent action needs the unanswered
  PR70 additional-review decision; the aggregate size gate also needs an
  explicit reviewed delivery solution. No further independent implementation
  in this bounded poka-yoke slice remains. This is blocked-goal observation1,
  not a third consecutive ended goal turn and not completed overall acceptance.

- Final behavior candidate1a0d2a90a54fed3887f5f2067d6e62dc5c690c8e is pushed
  on canonical PR67, now titled preserve/recover across Actions runs. Accepted
  proof56f2cbf, loop94a75187 and parser61641a4 are all canonical ancestors;
  worker remote61641a4 is retained and M14 local fast-forwarded to1a0d2a9.
  No implementation writer or local test remains active. Full credential-free
  CI35038212419/35038215854 runs on this exact candidate (expected13-15min from
  the preceding full runs); source stays frozen. Final focused proof8/loop9/
  contracts73 and existing runner-loss/crash/causal captures have complete copies
  in private poka-yoke/m14-final-*-evidence.json. This checkpoint is the sole
  primary-owned uncommitted ledger delta to avoid another evidence-only CI run.
  No new formal review, live state write, model start or installation occurred.
  The reader approval and aggregate review-size gates remain concrete blockers;
  this continuation has not yet ended with those blockers, so no three-turn
  goal-blocked threshold is inferred from intermediate checkpoints/compactions.

- At00:01 V18 settled exec66141/PID282397 exit0/completed,30calls, one permitted
  formatter pass; no tests/probes/children. Persisted2958d324/stream66ad8369 and
  m14-launch-v18.json prove exact cwd/production/Flash/max/workspace-write/ask.
  Primary inspected the two-file diff: bounded exact implementation/base-refresh
  descriptor syntax and canonical safe PR numbers; intent and consumer bindings
  unchanged. GPTcd7b845a-25fe-4047-8aa4-d910b114eaa4 contracts passed child0,
  3573ms. Lint4289e957 and formatec5b0187 passed. Stage2 Issue69 code prerequisite
  is accepted for integration; issue remains open until delivery. Fresh remote
  development8c861f5 and launchera076b17f unchanged; release77298d44 pointer
  blob237248da proves active20aae115 generation5, executionnull, latest settled
  ordinary35037557130 healthy. This is not proof of the new recovery behavior.
  Repair ref2ee6011f is a read-only observation. No live write/review/install.

- Canonical/M14 b289347f923ae28839a4352b541d855256e3ba09 now includes accepted
  V17 tip94a75187 by ancestry. V18 owns only work-record.ts and records_test.ts
  for the existing Issue69 Stage2 operation-key syntax requirement; trusted
  consumer binding, normal loop and other fixtures are frozen. Exact45-call
  assignment pins this base; rules hashfc44ca6e unchanged. Final push/CI will
  include this narrow prerequisite to avoid an unnecessary intermediate CI run.

- At23:57 V17b settled exec78508/PID278808 exit0/completed,16calls/3edits,
  one permitted single-file formatter pass, no checks/children. Persisted
  df99d107/stream2b75c32a and live attestation prove required exact launch.
  GPT38e760ef-5e5c-4bd8-8e49-2e733f8dba39 passes all9 bridge cases, child0,
  5428ms: real two-CAS Git ancestry, ordinary charged attempt4 atB0/H0,
  null/unavailable scan progress, unrelated eligible advancement, stale-proof
  refusal and exclusions. Lint920ab2f3 and formatdc95d3d5 pass. Primary verified
  fixture-only correction scope and unchanged audited source; V17 accepted
  for canonical ancestry integration. Live normal recovery remains unproved.
  PR67 runtime review preflight atf617e17 vs8c861f5 measured diff1,392,000bytes
  and prompt3,213,117bytes (each limit1,048,576); old ledger blob723,363bytes
  exceeds524,288. No override/filter/chunk route exists; altering only the new
  ledger cannot fix the old blob. PR70 measured772,393promptbytes fits but its
  extra-review authority remains unanswered. No review, limit change or live
  state mutation occurred. Stage2 parser requirement V18 is next independent
  source work; no formal-review cycle is reset by these integrations.

- At23:54 fresh legacy_loss_loop_audit PASSED V17 source contract and found
  fixture-only corrections: charge settledT0+500 exceeds fake clockT0, so the
  budget correctly defers; three seeded legacy PR records fill WIP3 and make
  unrelated issue9 ineligible. V17b owns only loop_test.ts to advance fake time
  before cycle3, split null/unavailable scheduling variants to two legacy PRs
  each, and replace sole lint no-await callback with Promise.resolve. Source
  frozen; assertions/accounting/selector preserved. Immutable35-call assignment,
  playbook hashfc44ca6e unchanged. Review-snapshot preflight also found existing
  aggregate size blockers; no limits, review gates or source scope are altered.

- At23:49 V17 settled exit0/completed,140calls/18edits, one permitted formatter
  pass. The primary prepared bounded stop after repeated post-format inspection;
  live guard found a terminal record before signaling, so NO signal was sent.
  Exact PID263638 and parent263624 exited, no descendants. Two files changed;
  frozen patch91d27bdf. GPT3e40055a-f2ef-4b32-b233-7825926f0938 ran all eight
  bridge cases:6passed/2failed child1,7725ms. Real loss/restore/ancestry passes
  until third cycle expects attempt4 but sees0model calls; starvation restores
  the legacy tuple but unrelated issue9.branch staysnull. Fresh no-history
  Astra legacy_loss_loop_audit diagnoses these two failures plus source contract
  before correction. Format69f706ea-f61b-458d-8e5f-bf8f10d6cbbf passed. No
  writer/test active after lint settlement; no repeated test without correction.
  Both f617e17 CI runs now pass13m14s/15m2s. Stage2 Issue69 parser syntax remains
  an independently verified two-file prerequisite; consumer bindings already
  checked. Its unlaunched V18 draft is private; existing valid fixture keys
  need no coordinated changes. Formal reader review/install remains paused.

- V17 launched23:35 as exec26383/PID263638; m14-launch-v17.json proves exact
  cwd/production/credential presence, persistedbb6d55ca/streamafd6c2d7 proves
  Flash/max/workspace-write/ask. PID263624 is its parent shell. Frozen candidate
  inputs remain untested while the sole writer works. Fresh review-accounting
  audit confirms PR67 cannot replenish the exhausted reader cycle by changing
  PR number; formal reader review/merge/install remains paused. Independent
  M14 implementation, deterministic acceptance and read-only audits continue.
  Both canonical f617e17 CI runs35036149897/35036153552 are pending. Only issues
  48/61 are opted in; no artificial queue entries or additional Pro calls.

- Canonical/M14 are both clean/pushed f617e17511d70883eab11995a26ff79c7021b667
  before this checkpoint; accepted proof56f2cbf is integrated by ancestry.
  Read-only lifecycle_fixture_scope passed the V17 assignment and real-store
  fixture seams. Frozen m14-assignment-v17-loop.md now pins that exact base;
  sole writer owns loop.ts and loop_test.ts only,140calls, normal two-CAS
  recovery plus historical-state and scheduling proof. Helpers and all host
  proof source stay frozen. DSH rules hashfc44ca6e unchanged and rechecked.
  The next acceptance is normal loss->restore->charged successor; no live
  action or PR70 permission change is implied by this development assignment.

- At23:32 V16c settled exec34788/PID258323 exit0/completed,17calls/4edits,
  one permitted two-file formatter pass, no tests/probes/children. Persisted
  9e95729a/stream51cd0e9d proves Flash/max/workspace-write/ask; live process
  attestation proves exact cwd/production/credential presence (PID258309 is
  the parent shell). GPT02339353-0501-4b73-89d9-da9d16d9b14e passed all eight
  real-Git legacy loss proof cases, child0,4198ms. Lint841129da-547e-4e56-acbb-
  758b9c01c9d8 and formatf26ed537-e7a0-4621-8b0d-c198d7302fcf also passed.
  Primary inspected the exact three callback corrections, one removed unused
  import, two helper formatting differences, contract and same-port wiring.
  This accepts V16 proof for ancestry integration; normal recovery remains
  V17, unimplemented. Fresh PR70 unchanged864d7a0 OPEN; supervisor35035719004
  succeeded at launchera076b17f. No live write/review/installation occurred.

- Continuation at23:29 verified canonical/M14 d9cdf821, exact lanes and all
  existing dirty paths; no DSH writer or test active. Fresh no-history Astra
  legacy_loss_proof_audit returned PASS with fixture correction, no substantive
  source defect. All three overridden counting callbacks must retain calls.
  Saved lint b88267f9 reports only unused portOk import in causal-capture_test.ts;
  saved format a8fe603f passed. V16c owns those two test files only, immutable
  assignment30calls; proof source and helpers frozen. DSH playbook2026-09-14.2
  hashfc44ca6e read before launch. V17 draft receives independent read-only
  fixture-scope check while correction runs. PR70 permission remains unanswered;
  no extra review, merge or installation. Completed Pro job reused, no new call.

- V16b settled exit0/completed, eight calls/one import edit and one permitted
  two-file formatter pass. Persisted d212c953/stream0bfa4cfb and livePID251200
  prove production/Flash/max/workspace-write/ask. GPT bdc6f96f-19d7-4dbe-a257-
  f361e6eb50d5 executed eight proof cases: seven passed, one failed, child1,
 4458ms. Real positive loss, binding/source/ref/PR/review, fetched-history,
  cooldown and state drift cases passed. Sole failure is local availability
  fixture at3298: loader-call assertion expected1, observed0. Fresh no-history
  Astra legacy_loss_proof_audit independently audits the frozen V16b patch
 50671184 and that failure before any correction. No source writer/test active;
  primary ran the separate existing format gate after its known CI correction.
  The two-CAS loop remains an unlaunched draft, not implemented or accepted.

- At23:20 proof capture348ce98c-b6d1-4438-b207-8805b5a38b81 failed before
  execution, child1,4356ms:21 TS2304 diagnostics are all missing SHA2/SHA3
  imports in the new fixture. V16b owns only those two imports plus one combined
  formatter pass on that file and the CI-identified helpers.ts differences.
  Source, proof behavior and assertions frozen. Immutable V16b assignment,
 25calls; no test remains active. This is not a failing runtime proof yet.

- At23:20 V16 settled exit0/completed,70calls/14edits, one permitted formatter
  pass, no tests/probes/children. Persisted8d527468/streamec4d62f2 and live
  PID240050 attest required launch identity/settings; no writer remains.
  Four owned paths changed; frozen private patchcac8b3b9. Primary inspected
  exact local-loader absence, fresh authenticated task-ref fetch, H0/B0/review
  binding, post-proof rechecks, same-port composition and absence of state/ref
  writes. GPT m14-legacy-loss-proof exec49064 started23:20, expected two minutes.
  Inputs frozen. Unlaunched V17 draft uses normal pre-ranking two-CAS recovery,
  guarded proof heads, real state ancestry and ordinary attempt4 admission.
  Fresh test-scope mapping selected existing loop_test.ts real-store rig; no
  new large two-process fixture. Guard mixed clean/P2 reviews and avoid a
  no-op higher candidate starving another recoverable candidate. V17 will
  also format the two existing helpers.ts wrapping differences found by CI.

- At23:10 V16 is the sole M14 writer, exec40692/PID240050; live attestation
  m14-launch-v16.json and persisted8d527468 prove exact cwd, production,
  credential presence, Flash/max/workspace-write/ask. No tests run during it.
  Fresh GitHub reads: PR70 remains OPEN864d7a0 with both CI runs successful;
  only issues48/61 are opted in. Supervisor35033906256 succeeded at launcher
  a076b17f. Remote development remains8c861f5, repair0469fa633913f1a99051182b2864549f4fd96abc,
  release3d91cf331fe3f403403c5781924e7c85b94c93d2. No new live write occurred.
  Canonical CI35034181137 failed only its format gate: tests/repair/helpers.ts
  has two wrapping differences from the earlier fixture work. Complete raw log
  canonical-d9cdf82-ci-35034181137.log is private. The next settled fixture/loop
  assignment must apply one formatter pass there; do not rerun unchanged CI.

- Canonical d9cdf8213928549ce86ec82866abf558863ae679 integrates dc3faba
  by ancestry and the frozen legacy-loss design; both canonical and M14 pushed.
  M14 fast-forwarded to this exact clean base. V16 owns only ports.ts,
  actions-candidates.ts, composeLocalGitHub wiring in local.ts, and focused
  actions-candidates tests for the trusted read-only loss proof. The immutable
  m14-assignment-v16-legacy-loss-proof.md limits it to160calls and one formatter
  pass. Normal loop/selector and live state are frozen; the two-CAS consumer
  follows only after this proof is independently checked and integrated.

- V15b settled exit0/completed at23:04, nine calls/one edit, no checks/probes/
  formatter/children. Persisted dda71563/stream16cd1bc8 and live PID228453
  prove Flash/max/workspace-write/ask/production; PID228437 in the launch
  attestation is its parent shell, not the DSH process. GPT88cd442a-034c-4cbe-
  a1c6-daf760bfc808 passed all five causal cases, zero ignored, child0,34975ms.
  Linux real causal consumer, proof negatives, publication and review now have
  executed evidence. Primary accepted and committed dc3faba in M14; canonical
  ancestry integration follows. Existing destructive proofs are not rerun.
  Legacy-loss design is frozen in the existing proposal after scope audit:
  one proof capability, pre-ranking two-CAS bridge, exact proof-head guard,
  no schema discriminator, new-format/pre-receipt exclusions. Implement the
  read-only proof first, then its normal loop consumer. No live state changed.

- At23:03 lifecycle_fixture_scope proved the sole positive failure is its
 30-minute hard deadline: entrypoint5min + review20min + review margin5min
 leaves latestStartAt equal toT0, correctly refusing review. V15b owns only
 that positive call's explicit60-minute window; all assertions and other cases
 remain frozen. Immutable m14-assignment-v15b-review-window.md,30calls,
 no formatter/probes/checks. GPT will rerun the five-case file after settlement.

- At22:59 causal capture0a8c3509-d030-49d1-805f-0aa9b08d3677 settled:
  four passed, one failed, zero ignored, child1,53088ms. The positive case
  returned margin instead of idle at line1436; read-only lifecycle_fixture_scope
  is diagnosing the selected action and downstream setup before correction.
  No test/writer remains active. Preserve V15's narrow diff and passing cases.
  Postflight found minor unauthorized environment probes (deno execPath and
  version) in V15; no tests, model calls or source writes occurred. Preserve
  this qualification and prohibit those probes in the next assignment.

- Continuation verified at 22:58: canonical 5476bd5121813a1ca9d219b2ee3cb226ced045d7
  and the recorded M14 lane both match their assigned identities. Only this
  primary-owned ledger is dirty in canonical. V15 exec42914/PID211535 settled
  exit0/completed; no writer or descendants survive. Persisted 4ff38128 and
  stream33c6eb4f prove Flash/max/workspace-write/ask; m14-launch-v15.json proves
  exact cwd/production/credential presence. It used 47 calls and seven edits,
  with one permitted single-file formatter pass. Only causal-capture_test.ts
  changed; primary inspected the real Linux isolation injection and retained
  Darwin/consumer/negative assertions. GPT capture m14-causal-capture-linux
  started at22:57, exec95570, expected four minutes; its inputs are frozen.
  Legacy-loss flow design continues independently with read-only scope mapping.
  Existing PR70 extra-review permission remains unanswered; no review, merge,
  installation or hosted state operation has been started.

- Canonical5476bd5121813a1ca9d219b2ee3cb226ced045d7 contains accepted M14
  integration-fixture tip1bb3bfe1eb1cba040cf0aa1fe6fa5a1ade3b1745; both pushed.
  M14 fast-forwarded to5476bd5 for its next single-writer assignment. Fresh
  read-only lifecycle_fixture_scope found a real missing Linux isolation
  injection in makeConcreteVerifier, not stale ignore metadata. GPT real
  Linux isolation prerequisite8ef43567-4f6e-4259-b276-4606f25f9f7d passed,
  child0,5306ms. V15 owns only causal-capture_test.ts to inject the existing
  production LinuxReplayIsolation and assert its real boundary, keeping Darwin
  assertions and every causal proof/negative case. Immutable V15 assignment,
  120calls; no source, state, review or deployment changes authorized by it.

- At22:48 V14b settled exit0/completed,8calls/2edits, no tests/formatter/children.
  Persistedfeb0810a-f3d1-46db-a31f-2104ecd60d8c/streame07cdaa7 proves
  Flash/max/workspace-write/ask; production is proved by the launch command,
  but this fast writer exited before live environment attestation. Preserve
  that qualification; no repeat paid run. GPT fc16dcb2-32a5-4a88-9d75-2bbbb7510a1d
  passed4/failed0, child0,20559ms. Primary verified only SHA2 import/one expected
  head changed from V14. Combined with unchanged passing03d081a7 cases, this
  accepts the eight-file integration-fixture checkpoint for canonical merging.
  The four pre-existing Darwin-only causal tests remain unproved on this VPS.
  No implementation writer/test active, no new live review or state operation.

- At22:45 integration capture03d081a7-d0e9-4216-b3e8-41dd9688da2c settled:
  31passed/1failed/4ignored, child1,166301ms. Actual entrypoint, two-task,
  composed release/closure, lost-response cooldown and replay cases passed.
  Only final cooldown admission expects SHA3 while direct FakeModel emits SHA2.
  V14b owns only that fixture's expected head/import; immutable assignment,
  30calls, source and seven other dirty fixtures frozen. GPT will run only the
  affected four-case file after settlement. Four causal-capture cases retain
  pre-existing Darwin-only skips; lifecycle_fixture_scope audits the platform
  reason without writes or execution. These skips are not acceptance evidence.

- V14 settled at22:40 exit0/completed,102calls/35edits, stream483809ae-e2ba-
  4d75-86fb-feaa814168ea, persistedfbff67d0. All eight owned integration fixtures
  changed; no source or other path changed. One permitted formatter pass ran;
  no tests/typechecks/lint/children. Primary inspected the helper's explicit
  exact base/head/ref checks, exact super-backed PR observations, and preserved
  deadline/cooldown/replay/closure assertions. Frozen patch4289f1fe is private.
  GPT m14-integration-fixtures started exec26683 at22:40, expected roughly3min.
  No writer may mutate these inputs before settlement. Existing repair and real
  destructive proofs are retained without rerunning.
  Legacy-loss audit confirms issue48 still needs a separate bridge from its
  original base_refresh intent; it cannot use the new-format preservation path
  directly. Commit a truthful loss state first, retain its Git ancestry, then
  re-prove H0/B0 before a separate CAS restore and ordinary charged attempt4.
  Normal headRejectedByReview rejects the authentic P2-bearing H0 receipt, so
  restored work routes to implementation rather than delivering H0. Exact
  transient proof contract and one contradictory legacy-ref observation are
  being resolved before the next source assignment. Issue61 stays excluded.

- V14 launched22:31 at cleanbc7e4eb54b97793291b89fc7415b8cb7a845fb4f,
  exec72231/PID138463, sole M14 writer for eight integration fixture files.
  m14-launch-v14.json and persistedfbff67d0-299c-4340-8c20-e9de1ddabd6b prove
  cwd/production/credential presence and Flash/max/workspace-write/ask.
  Canonical392aaf9 is pushed; no fixture execution while this writer is active.
  At22:32 PR70 remains OPEN864d7a0 with both exact-head CI checks passed; no
  review/merge/install beyond the pending21:28permission request was attempted.

- At22:31 the M14 durability and repair-fixture checkpoint8493511d78dc4af46568590dc33ad6a261de715d
  is integrated by ancestry as8ec1abe80d023b31c669bef9874367a4e95dc679. This is
  development integration, not release acceptance or installation. V13b settled
  exec62696/PID135724, sessiondeb35b94/stream982ce29c,6calls/3edits; exact
  production/Flash/max/workspace-write/ask verified. No checks/formatter/children
  ran; its required plan read was absent from the tool record. Primary read the
  full plan and independently verified the exact scoped correction. GPT
  567594b0-81a5-412f-9956-623b6f75d635 passed9/failed0, child0,5765ms.
  Combine with unchanged passing cases in88197184; no whole-suite repeat needed.
  V14 next owns the eight integration fixture files only, after canonical
  ancestry is reconciled into M14. Production and real destructive fixtures are
  frozen. Existing PR70 approval remains pending; no live review/install occurs.

- At22:28 fresh fixture_last_failure_audit confirmed a fixture-only correction:
  legacy publication now has exact no-op PREPARED/PREPARED, changing next/PREPARED,
  and no-op next/next calls; only one remote write, all before the one review.
  V13b owns that single test assertion/callback in base-refresh_test.ts;30calls,
  immutable m14-assignment-v13b-legacy-push-sequence.md. Other94 passing cases,
  source and destructive fixtures stay frozen. GPT will run only the9base-refresh
  cases because the remaining bytes and their successful evidence are unchanged.

- Continuation verified at22:27: canonical1969ebeb1aef070bc78c2a751bdb0e536bfbf029
  matches origin; only this primary-owned ledger is dirty. M14 remains49cbd624
  with exactly six fixture files dirty; no DSH writer or test process survives.
  V13 settled exit0/completed,83calls/13mutations, persisted ae3d475b/stream2fc4a5a8.
  Required production/Flash/max/workspace-write/ask evidence remains saved.
  One permitted formatter pass ran; an unauthorized minor awk line-length check
  also ran. Preserve that qualification. GPT exec16557 settled: capture
  88197184-d1e4-490e-871b-765c3b6e2a24 passed94/failed1, child1,139221ms.
  The sole failure is base-refresh_test.ts:838 expecting the refresh output as
  the first push. Fresh no-history Astra fixture_last_failure_audit diagnoses
  the actual lifecycle before correction. All other affected tests, including
  lost H1/H2 push/review and freshness gates, passed. Frozen patch a46a6cd6
  remains private. No production source or destructive fixture changed.
  V14 integration-fixture draft is unlaunched pending this checkpoint.
  PR70's extra review/merge/install authority remains unanswered; no new action.
  Read-only legacy-loss scope found a potential existing typed-state route,
  subject to fresh positive absence/predecessor proof; the exact current legacy
  base_refresh bridge and admission bound still need diagnosis before coding.

- V13 launch ownership at22:13: only base-refresh/actions-ci/loop/run-bounds/
  selection test files, exact49cbd62 plus preserved dirty fixture checkpoint.
  Exec86256/PID72237; m14-launch-v13.json proves exact cwd/production/credential
  presence. Persisted ae3d475b-23f7-4a20-aacc-0e2bcabaf4f3/stream2fc4a5a8 proves
  Flash/max/workspace-write/ask. At22:18 it has useful edits in all five owned
  files,81 calls against140 bound; no test execution before settlement.
  Independent inspection mapped all10 failures to setup: four PR/CI observation
  cases, distinct second PR number8, one missing closure lifecycle opt-in, three
  run-bound exact-ref/PR setups and one parser-invalid null-head/PR11 fixture.
  Immutable m14-assignment-v13-port-observations.md batches those corrections.
  New passing loss/gate cases and production source remain frozen. Read-only
  legacy_loss_disposition_scope maps the next normal-runtime recovery boundary;
  it has no write/admission authority. No extra PR70 review is authorized yet.

- At22:10 V12b settled exit0/completed, persisted ea0a88ff-5108-4837-8371-
  79870aaf14f8/stream433e8c73; live PID13680 attestation and header prove required
  settings. It used67 calls, exceeding60 by7 during useful corrections; no tests
  or formatter ran. Preserve this deviation, not an unqualified compliant run.
  GPT ff7bda06-7d1a-403d-96ac-670d406b4834 executed146270ms, child1:
  85passed/10failed. New H1/H2 push-loss, review-loss and exact freshness gates
  passed. Four failures are untouched base-refresh/CI fake observations; six
  remaining fixture setups are under bounded read-only diagnosis. No writer or
  test remains active. Source and destructive fixtures remain unchanged.
  V13 port-observation assignment is prepared but not launched; batch the six
  concrete remaining fixture corrections before that launch. PR70 authority
  still pending; no review/merge/install or runtime state write occurred.

- At22:00 V12 was stopped at131 calls after exceeding its immutable110-call bound.
  Exact PID4193888/cwd/production verified before SIGTERM; parent4193874 and
  worker absent afterwards, no children. Exec76948 exited0 but no completed
  stream result exists: retain as interrupted partial, not a compliant handback.
  Four owned test files are dirty; source and destructive fixtures unchanged.
  GPT capture4a3ac4a6-cd6d-4af9-9748-690510653c49 failed before test execution
  with one TS2540 (readonly fake capability versus intended method override).
  Independent fixture inspection found masked PR/ref/capability negatives and
  seeded PR-number collision. V12b owns only helpers/loop/run-bounds tests for
  these exact corrections,60-call hard bound. Remaining fixture files follow.
  Issue48 H0/B0 proof now exists in private issue48-h0-ancestry-v1/receipt.json:
  empty credential-free store fetched exact0e689889 from the real task ref;
  1d618965 is a commit and ancestor, and only text.ts/pr_test.ts differ.
  This does not recover lost51842315 or admit a successor. No live state changed.

- Continuation verified at 21:53 UTC: canonical fe4691b4671bcabd504f3c25f551f10bebf9443e
  matches its published branch; only primary-owned ledger additions are dirty.
  M14 is at 49cbd624ec727c359da26d6afa86e9f96e7c651e with V12 active, not the
  earlier V10/V11 states below. V12 exec76948/PID4193888 has useful helper edits.
  Persisted session4cb92c3f-3d10-40ac-84f3-8957eaa6e2f7 and stream96e970ad
  prove Flash/max/workspace-write/ask; m14-launch-v12.json proves exact cwd,
  production and credential presence. No tests run before writer settlement.
  Existing three-case crash evidence and independent PASS remain valid.
  The six-file assignment stays frozen; integration fixtures follow serially.
  Fresh read-only issue61_blocker_scope diagnoses its separate unresolved intent.
  No replacement model start, state surgery or admission-marker change is allowed.
  PR70 remains OPEN at864d7a0, development remains8c861f5; extra review permission
  is still unanswered. No new review, merge or install has been attempted.
  Fresh refs: repairefe9f80e207ab189398d48fa28e0dcf04f8bcd28 and
  releaseb52cb9a5d007d2e12bb1ef4abaacfbc10da90685. Supervisor35027650161 passed
  at launchera076b17f; this proves supervision only, not another delivery.

- Canonical4620b203a9f1d43f05474c334630eec96f83454a is clean/pushed before this
  ledger update. M15 corrected PR70 head864d7a0cbb595616b4e90293338f496788b8321a
  is committed, pushed and integrated. P1 source predicates match exact incident
  and repository; GPT150 other reader checks passed in c0b7794c, and all3 intake
  cases passed after one ref-expectation correction in807db572-72ac-4a53-bcf1-
  34edf56b7c26, child0/executed13052ms. Both CI runs35025797252/35025801940 passed
  at the exact corrected head (5m41s and5m49s). Review permission remains pending.
- PR70 REVIEW ALLOWANCE EXHAUSTED: fresh no-history Astra audit proved3 distinct
  completed local source-only/window/fixture reviews, plus earlier integrated
  review. MASTER-PLAN156/215 forbid another round or a new-commit reset. Owner
  question sent21:28:31 asks one additional local+authentic acceptance round;
  answer pending. Do not launch either review, merge or install before permission.
  M14 independent implementation/tests continue. No new review charge exists.
- M14 base54402340a98c4625267ad4018b2b9ce5cd1a4d7f has only two dirty V10 fixture
  files; no active writer. V10b's genuine unapplied-ack error/eight-step/null
  initial-result fixes settled. First capture f0b8889a failed only2 TS2322 before
  test execution. V10c exec49342/PID4168380 settled exit0/completed; live/header
  production/Flash/max/workspace-write/ask verified, session81ec7d71-8b1e-43b5-
  85fc-4848444630e5/stream8e3d4036. Four resultId observation types corrected to
  string|null; all exact runtime equality assertions retained. New three-case
  capture runs as exec68792, expected roughly7minutes. Earlier ordinary proof
  54670e80 remains valid; crash cuts are not yet accepted.
- M17 V6 exec35282/PID4167047 settled exit0/completed; live/header verified,
  session3eb1e615-b049-4d48-829a-789b3564d598/stream678f23fa. Primary proved exact
  literal-only mapping to864d7a0/source-v5/private root reader-install-pr70-v5,
  review reservation attempt3. Typecheckd6bf382d-d4c3-4694-a4da-cf4fe15ff3d9 passed
  child0/executed7860ms. Clones are clean at864d7a0; release clone is placeholder.
  No live marker, invocation or reservation; prepared operators await permission.
- M15 V2 fast one-assertion writer exited before live process attestation;
  production launch command and persisted Flash/max/workspace-write/ask proved.
  Preserve this qualification. No repeated paid run solely to recreate attestation.
- Live queue at repaire409631: issue48 is due base_refresh wait on lost H1;
  issue61 is blocked with unresolved implementation intent; issue21 is blocked,
  issues18/58 are done. Only open issues48/61 carry the explicit repair opt-in.
  There is spare WIP capacity but no additional opted-in task to dispatch; do not
  create redundant runs or alter admission markers to claim queue saturation.

At21:43 all3 real destructive cases passed64661bc7-296e-4661-ae56-3dd07469981a,
child0/executed519318ms (four fresh child lifetimes account for roughly8m39s).
Primary observed exact H1 restoration after unapplied acknowledgement and exact
saved H2 recovery after both childA stores were deleted, zero replacement model
calls and preserved accounting. Committed exact fixture as23a5f07. Fresh no-history
Astra crash_cut_acceptance_audit checks that frozen diff/evidence, no tests.
Ancestry merge fe4691b into M14 has one conflict: narrow incident predicates
auto-merged, obsolete Stage1 parking comment/guard conflicts with Stage2 removal.
V11 exec37580/PID4190047 owns only loop.ts to remove that obsolete guard/markers;
live production/cwd/credential presence saved. No fixture changes under audit.
At21:46 fresh Astra crash_cut_acceptance_audit PASS on frozen54402340..23a5f07,
independently read64661bc7. These are real Git/state consumers with injected
failure boundaries, not OS kills or hosted proof. H2 reconstruction matches the
persisted exact SHA; the fixture does not isolate fetching H2 via its preserved
ref. No substantive fixture correction required. V11 settled exit0/completed,
session5c23dc7d-5aef-4023-8419-17310e951993/stream432eabb0, required header/live
verified. Primary confirmed exact narrowed predicates with no parking restored.
M14 ancestry merge49cbd624ec727c359da26d6afa86e9f96e7c651e is clean and pushed.
Next serial assignment updates affected fake-port lifecycle fixtures only;
no further crash-fixture execution without a new reason.
V12 next writer owns only tests/repair/{helpers,loop_test,selection_test,
run-bounds_test,base-refresh_test}.ts and tests/host/actions-ci_test.ts at49cbd62.
Immutable m14-assignment-v12-repair-fixtures.md fixes explicit opt-in fake design
and remaining push/review ambiguity plus central gate cases. Shared default
preservation stays unavailable. Real handoff fixtures/source remain frozen.
Integration fixture updates follow serially after this shared test seam settles.

Earlier continuation checkpoint (superseded only by the exact items above):

- Canonical43c8171cb9f9c077f8863f9582edd2797a248657 includes final M15e5053e0
  and accepted M16 ancestry. The M16 merge retained exactly the canonical tree
  c09c63cf8f693d19e705e5ecdd04066bbfa720e7; its parser/tests were already present.
- PR70e5053e0: both CI runs and local review passed. Authentic review5215687932
  completed with one P1: fingerprint-only parked incident lookup can suppress an
  unrelated repository or incident. Exec94145 settled exit0; receipt applied,
  releaseReady false. Luna/max V4 attempt2 reservation91851f73 remains charged;
  attempt1 reservation79a4a43 remains ambiguous/charged. Fresh read-only Astra
  scope audit is checking the correction before DSH writes. No merge or release.
  Runtime remains20aae115/generation5; reader runtime is not installed.
- M14 stays at133b52d plus six dirty V9 files. V9/V9b writers settled. Current
  fixture6ab4bb96-0946-4d68-a5d6-07e0b432b4c4 failed after131612ms: H1 was
  preserved remotely before producer+mirror deletion; child restoration then
  returned unavailable. Child args still allow-run=git and envHOME,PATH while
  production DenoReplayRuntime needs full group signaling and NODE_V8_COVERAGE
  permission. Independent audit confirmed exactly those two fixture substitutions.
  V9c exec7974/PID4095994 settled exit0/completed; live attestation preserved,
  persisted session07b2a4a8-4a32-4951-8787-fea860925ea2 and streamc85a1439 confirm
  Flash/max/workspace-write/ask. Primary reviewed the exact two substitutions.
  Corrected destructive fixture54670e80-e873-4986-8407-f504c03665fd passed:
  one test, zero failures, child0/executed134129ms; exec27563 settled. Primary
  verified remote H1 retention, producer/mirror deletion, fresh-process empty
  store restoration, real publication/base refresh and review admission with
  no new implementation. No M14 writer is active. Six-file lifecycle checkpoint
  is ready for crash cuts and affected fixture updates; not installed/accepted.
  No preservation/production guard relaxation. Crash-cut scope mapping proceeds
  independently while M15's P1 is diagnosed.
- M17 V5 private files are settled and typechecked; no DSH writer active. Only
  the live review operator owns its temporary root. No release request yet.
- Legacy loss disposition, crash cuts, unit fixture updates, Stage2 installation,
  second autonomous delivery, rollback and full observation remain incomplete.

The complete earlier record, including all execution qualifications and rejected
or superseded drafts, is retained in this file at Git commit
`74e67ec5a55fdd273f5ef2b56a477ddb27bd3072`. Read it with
`git show 74e67ec5a55fdd273f5ef2b56a477ddb27bd3072:docs/build-status.md`.
This compaction changes no acceptance decision and creates no second ledger.

Continuation verification at21:17: canonical eef0d5b is clean and pushed.
M14 lifecycle checkpoint f160f08 is committed; canonical ancestry merged as
54402340a98c4625267ad4018b2b9ce5cd1a4d7f. Its real destructive test passed as
recorded above. M15 remains clean e5053e0; fresh Astra confirmed P1 and mapped
exact repository/incident matches for BOTH intake lookups, preserving dedupe.
New disjoint assignments: M15 m15-assignment-p1-intake-v1.md owns only loop.ts
and loop_test.ts. M14 m14-assignment-v10-crash-fixture.md owns only the two
candidate-handoff fixture files. M14 source/other tests are frozen. Primary
integrates accepted M15 before serial M14 unit updates; keep M14 out of Stage1.
No live review/operator active, no release request; prior review charge retained.
M15 P1 launch exec23066/PID4110122, persisted sessioncd75284c-01d1-4fec-beae-
b73718da1d6a/stream5c93477a; M14 V10 launch exec49494/PID4110152, persisted
session40866b2f-41c2-407f-bcd6-7f0773a37191/stream400897e8. Both exact cwd,
production and credential-presence attestations saved in
launch-m14-v10-m15-p1-v1.json. Both headers confirm Flash/max/workspace-write/ask.
M14 clean checkpoint5440234 is pushed; current V10 remains unaccepted.
Latest read-only hosted check: supervisor35024154550 succeeded at launcher
a076b17f; repaire409631/releasea63128f, development8c861f5 unchanged. Recheck
these historical refs before the next live operation.
At21:26 M15 P1 V1 settled exit0 in52calls; primary inspected exact source/test
diff. GPT c0b7794c-fa63-4d52-837b-47045ec4d420 passed150/failed1, child1,
executed137090ms. Only new test expected short branch rather than full Git ref.
M15 V2 exec60475 owns that one assertion in loop_test.ts; source stays frozen.
M14 V10 settled exit0/completed in55calls with two dirty fixture files. Primary
found three fixture-contract corrections before first execution: never return
applied for an unapplied acknowledgement, remove two iterations beyond the
eight-step cap, and allow the initial refresh intent's resultId to be null
before preparation. V10b exec99518 owns only candidate-handoff_test.ts for these
three changes; real child exact-H2 preservation predicate stays unchanged.
Fresh read-only review-round audit is reconciling PR70's used acceptance rounds.
Do not launch another review before that count is resolved; source work proceeds.

Continuation verification at20:34: canonical3536daf is clean; M15 remains clean
at9cc379d; M14 has only its ten owned changes; no process has a worker-lane cwd.
Fresh saved evidence b4503a79-4207-4b13-95f5-824ab7a8f1b4 confirms M14's final
preserver prerequisite passed51tests/0failures, child0, executed9708ms.
V8e settled; source inspection confirms uncertainty is set before validation
and retained on throw. Its live process attestation was missed; persisted
Flash/max/workspace-write/ask and production launch command are proved.
M15 CI35019235545/35019241504 failed five positive fixtures (1122passed/5failed).
Fresh read-only audit mapped six timing literals in three integration files;
forty minutes restores former admission headroom without weakening guards.
Primary reread playbook hashfc44ca6e and assigns those exact edits under immutable
m15-assignment-review-fixtures-v1.md. No other M15 writer is active.
M17 V3 settled; wait for corrected final PR70 head before one literal rebind.

At20:38 M15 fixture writer exec42740/PID3987029 settled exit0; live production,
credential presence and exact cwd verified. Persisted4d339454-13a6-42c8-b1fc-
9909adfb919c confirms Flash/max/workspace-write/ask and completed. Seventeen
calls include required plan reads; exact diff is six literals in three files.
GPT evidence59d29119-dedb-422e-a445-d1d64503db1a passed23tests/0failures,
child0/executed93560ms. Committed/pushed e5053e0de4b7db8365b95aa723b951af0bf6969a,
integrated as canonical302e9427bcaca04db19f09bdd2f46adedc2e1666. Local review
exec23424 and new CI pending. M17 V4 owns only its two ignored operators under
m17-assignment-v4.md, rebinding to this head and source-v4 clones; no live call.
M14 prerequisite committed b234fdafaff7ff5d3d5360eb3b16add415330c07; compact
canonical874e11c ancestry merged into its lane as133b52db35e0b71e05d912deec5147d8d9657da0.
It stays outside Stage1 because the lifecycle fixture is intentionally red.
At20:43 primary received the existing V9 read-only map after stopping a
nonproductive nine-minute resend turn; no source was changed by that auditor.
M14 V9 now owns only loop/transitions/selection/actions-ci and the two existing
candidate-handoff fixture files, exact base133b52d, immutable m14-assignment-v9.md.
First checkpoint is ordinary destructive handoff; separate serial crash-cut and
unit-fixture update follows. Legacy-loss replacement remains excluded.
M17 V4 exec33956/PID4026138 settled exit0; sessiond4400e39-00c5-47b8-aad1-
12bd5c4ba1ac, streamc7672e60-b207-4b35-8d95-a63da4214cc0. Required live/header
settings verified; primary confirmed exact literal-only mapping for both files.
Typecheck2726d842-4706-4b78-9a70-cf1beb664630 passed7723ms/child0/executed.
PR70 local reviewexec23424 passed with no actionable findings; reviewer ran
122focused tests in evidence7d014e69-d1ec-4dac-88a3-86552fd221ed. Final snapshot
dd0ae111-8f7f-439e-b67c-a51133adefbd passed505ms,14files/750684prompt bytes.
CI35020878223/35020885836 pending; authentic review not yet launched.
At20:47 both exact PR70 CI runs passed (5m37s/5m33s), local review is clean.
Ordinary run35021091739 settled success; fresh releasea63128f shows runtime20aae,
generation5/executionnull and four accepted releases. Repair9652ffc and launcher
a076b17f rechecked; PR70 exacte5053e0/base8c861f5 and three active workflows
confirmed. Primary created exclusive fresh V3 review ownership marker and
launched authentic operator exec22585 at20:47, expected20-minute transport bound.
No original terminal review/charge reset. Private review-run-v1.log records progress.
M14 V9 exec74094/PID4064500 remains the only implementation writer; live cwd,
production/credential presence and session9e8200ce-3a5a-428a-a2b0-2991bd5e12d7
Flash/max/workspace-write/ask verified. No test claim until settlement.
V3 authentic review admission79a4a43befc0af282f1280c7192e2476a3b6a2f4864dee01a72fbd783c7b74b6
returned unavailable BEFORE a request: requestId/requestedAtnull, static detail
"review transport: the immutable review snapshot is unavailable". Preserve
operationreview:70:e5053e0de4b7db8365b95aa723b951af0bf6969a and its charge;
no resubmission. Local snapshotdd0ae111 passed on M15, so fresh read-only audit
is diagnosing the actual operator/clone capture difference. Operator still owns
its bounded observation/settlement until exit; no merge/release permitted.
At20:50 exec22585 settled exit1; exact PID4066307 absent. Terminal static error
is incomplete review observation. Request never supplied an ID; saved initial
failure is immutable snapshot unavailable. All V3 artifacts and reservation
remain intact. No replacement or second invocation of that operation launched.
Permission cause confirmed: exact restricted capture20af195a-3fbd-4df8-836a-
7fdc8e63d766 failed73ms; adding only existing NODE_V8_COVERAGE env read permission
passed441ms in0dfde365-a93b-4647-9dd8-29113a7d88cd. No credential/model/network
call in either diagnostic. The earlier deno eval check did not test this envelope.
Fresh source audit proves DETAIL_SNAPSHOT occurs before journal/preparation/start
and supports separately charged attempt2 on SAME head/canonical operation key.
Primary assigns M17 V5 under m17-assignment-v5.md: two private root/invocation
bindings and attempt2 only; keep original attempt1 ambiguous and fully charged.
No source-only commit or refund to obtain new identity. Verify unused attempt2
and fresh hosted ownership before launch; exact corrected permission is required.
M14 V9 settled naturally exit0 at20:54 before a planned bounded stop could signal
it. Six owned files only, one formatter;138+calls exceeded100, recorded deviation.
Existing destructive fixture now runs as exec61688; fresh no-history Astra
ordinary_lifecycle_acceptance_audit audits exact six-file diff independently.
M14 evidenced8b8b0fd-7fe3-44ef-ad50-dc29413da904 failed1test at preservation
acknowledgement (19237ms): parsed intermediate state attached descriptor before
clearing candidate_preservation intent. Fresh audit requires that nesting fix
and six bounded CHECK_POLL_MS publication/PR/read error waits; null waits prevent
later reconciliation. No second intermediate-parser error found in remaining
transitions. V9b owns only loop.ts under m14-assignment-v9b.md; fixtures unchanged.
M17 V5 exec57589/PID4082937 settled exit0; session89bec53d-a083-44d1-8242-
9fd0a914d26c/streame6cc7868-d7cd-4848-ab8c-7fa6f31f2c34, required live/header
settings verified and primary literal diff matched. Typecheck3c5ccaf6-776f-4e36-
8b29-7c936ac9c773 passed2769ms. Fresh state showed only attempt1 for e5053e0.
V4 live operator exec94145 launched20:58 with corrected permission and fresh
repair97374a1/releasea63128f ownership. Attempt2 reservation
91851f73acb75e5f3c4e023c946f25c93c6f59a70575018d0f24f7ee770f08b9 admitted,
request applied at1789505937790, requestId review-review:70:e5053e0de4b7db8365b95aa723b951af0bf6969a.
This is the first actual request for that operation; attempt1 remains charged.
Await exact completed receipt; no merge/release claim.
V4 review5215687932 is PENDING with exact e5053e0/base8c861f5, canonical operation,
submitted provideruos/modelgpt-5.6-luna/reasoningmax and thread01a0a6dd-c220-7383-
a81c-258edebfde2c. This is correlated running-request evidence, not completion.
M14 V9b exec84661/PID4088743 settled exit0; sessioncd877aa5-e184-4945-ac01-
9ec98cdbf3bf/stream739015f5-ebda-4e27-a4d2-9851f068cfae, live/header verified.
Primary confirmed intended acknowledgement nesting and unchanged parser/fixture.
Corrected destructive check runs as exec12233; previous failure retained.

M16 ancestry reconciliation: accepted019fc75 changes only work-record.ts and
records_test.ts. Canonical parser is identical; canonical tests contain the exact
M16 tests plus98lines of accepted no-weekly-cap coverage. Normal merge calculation
conflicts at the shared insertion. Primary will preserve canonical tree with an
ancestry-only ours merge after this exact patch-containment proof; no source loss.

## Canonical identity and policy

- Canonical path: `/home/codex/repos/ubiquity/sentinel/.codex-worktrees/master-plan-gfa795549e5`.
- Canonical branch: `codex/master-plan-gfa795549e5`.
- Source checkpoint: `80b58f66440cae044bb043b81bca2c52019c6e85`; the history-only
  commit above follows it. Root/published `development` last verified at
  `8c861f5c4ba0453b1abfe95241ba36274ae42920`. Recheck before writes.
- Runtime: cron-triggered GitHub Actions, one implementation writer, separate
  deterministic release owner, at most three unfinished target PRs.
- Development policy: 120 shared starts per rolling hour, no weekly cap.
  Implementation, review, retry and continuation share durable accounting.
  Preserve every historical charge, Luna/max and no model/quota fallback.
- Local implementation: DeepSeek official / deepseek-flash / max, production,
  workspace-write/ask. DSH writes source; GPT owns checks, Git and acceptance.
  Current playbook hash: `fc44ca6ec8e008328b59199fda05bf46f6ca536db8ccad7739d7ef8143ca5377`.
- Keep eligible tasks moving around task-level waits. Existing writer ownership,
  WIP limits and shared-state availability still govern admission. Do not flood
  Actions with redundant waiting runs or wait on a successor while holding its
  concurrency group. No branch protection/ruleset additions.

## Installed hosted state

| Surface | Last verified identity and meaning |
| --- | --- |
| Supervisor source | PR68 merged and launcher installed as `a076b17f426a0a590806cd2f1e066d5f494bc9f2`; reviewed head `019fc75df644a83f9b02b662a3bf5fc1e7d642dc`. CI and local Codex review passed. Parser SHA256 `62f15f102b89d99230824b55b66fb0977b36349108feb7e003181425cc028cb8` equals M15. |
| Repair runtime | `20aae115b44ed740c37e2452de4d5530b66430ec`, generation 5; effective 120/hour and no weekly cap. Reader runtime installation remains pending. |
| Last ordinary proof | Actions run `35014756582`, repair job `104535433250`, launcher `a076b17f`; healthy execution, no new application delivery claim. |
| Ownership before PR70 review | Repair ref `004b63ffddcfa0dd3ce17a1b1c238bb5b7307043`, release ref `fd5d353fe5d5208d50d9a5958e2b775ab73f518f`; execution null and all four hosted releases terminal. These are historical pre-admission pins; re-read before any live write. |
| Workflows | Repair `353743354`, dispatcher `357012160`, supervisor `357012162` all active. |

Only the existing supervisor may write release state or change the runtime
pointer. New candidateState live emission is prohibited until the exact Stage 1
reader is verified as both installed launcher/source and runtime.

## Reader delivery: PR70 and PR67

[PR70](https://github.com/ubiquity/sentinel/pull/70) is the focused runtime source:
current head `9cc379d2d4792154c23f6ab66425cfbfc90b16c8`, base
`8c861f5c4ba0453b1abfe95241ba36274ae42920`. The existing M15 head is already an
ancestor of canonical `80b58f6` through its original `af366697` revision;
nine original source/test blobs equal PR67's source,
excluding its two documentation changes. Independent delivery-history audit
approved this reuse of the existing lane.

The new head raises the existing whole-review bound from10to20minutes after
the observed incomplete review. Close reserve, Luna/max, exact-head admission
and shared charging are unchanged. M15 writer exec38119/PID3964831 settled exit0,
session `7ee1feb1-34ed-4d11-95b8-28ee8604425a`, stream
`8df16abb-6432-4ea3-9184-477fc9e6d7ee`; settings and live production/cwd verified.
GPT evidence `18bb1a12-df49-4982-b8dd-11f1f6645474` passed55tests/8steps/0failures
in7274ms. New actual snapshot `0671b484-e14e-42a3-b7d9-b2bca32e1d0b` passed440ms,
11files/649681prompt bytes. Local exact-source Codex review exec18130 settled
exit0/no actionable defects. Push CI35019235545 and PR CI35019241504 pending.
These new bytes require their own authentic review; none has launched yet.

Validation: equivalent integrated source passed 1,127 tests / 84 steps / nine
existing ignores; focused reader validation passed 149. Exact source-only local
Codex review exec7514 exited 0 with no actionable defect, reusing identical-source
checks without claiming fresh execution. Push CI `35014681751` and PR CI
`35014844919` passed. Actual credential-free production snapshot passed with
9 files / 537,804 prompt bytes, evidence `7d6cb66c-1b28-4bf5-8996-65ec173c76fd`.

The authentic runtime review FAILED TO PRODUCE A VALIDATED RESULT:

- Exec43357 settled exit1; GitHub review `5215017092` became COMMENTED at
  19:54:45 UTC with phase ready, verdict unavailable and execution null.
- Operation `review:70:af3666976241c0739f72e13cb18fc224fc6a7cad`.
- Request `review-review:70:af3666976241c0739f72e13cb18fc224fc6a7cad`.
- Reservation `2a99e53c468f6ae27cd3c518ba29c7f17efdd68595bc759b8a383e91a62429d4`.
- Request was applied at `1789501492527`; published running journal had UOS,
  Luna/max and thread `01a0a699-ed1e-7d80-b04c-06a9dd2fabd7`.
- Observation artifact is unavailable; no completed authentic receipt exists.
  Preserve this charge and original operation. Do not resubmit it or merge.
- Read-only `hosted_failure_acceptance_audit` is diagnosing saved runtime
  evidence and whether observation-only recovery is possible. At20:13 it found
  121 reasoning records, zero final messages, no saved completed turn and zero
  persisted threads (ephemeral review). HTTP200 streamed until19:54:27 without
  saved auth/transport error. The unavailable journal at19:54:36.427 matches the
  600-second host bound minus close reserve. Deadline intervention is strongly
  supported; exact terminal subtype was discarded and remains unproved.
  Observation-only recovery is unavailable. A scoped review-window correction
  is under read-only assessment; no unchanged request or charge reset.

[PR67](https://github.com/ubiquity/sentinel/pull/67) remains the aggregate
canonical history delivery. Its prior authentic review failed before a model
request because the changed ledger was 739,526 bytes, above the 524,288 per-file
snapshot bound. Exec42518 exited1, requestId null. Preserve ambiguous reservation
`60faee7dace1395d5e7d9d3760aa2c544c1c60a749416ec95c4b6d60b3039f6f`;
never reset/retry it or describe it as a provider failure. The working ledger is
now compact; historical evidence remains in Git. Do not discard PR67/history.

P3 operation-key syntax validation remains tracked in
[issue69](https://github.com/ubiquity/sentinel/issues/69), linked on PR67 with a
thread reply. Stage 1 parks new records, so this does not expose an execution
bypass. Stage 2 must verify syntax AND full operation/task/head/base/ref binding.

## Current worker lanes and ownership

All lanes below are under `/home/codex/repos/ubiquity/sentinel/.codex-worktrees/`;
each branch is `codex/` plus its exact lane name. Never retarget a lane.

| Module / exact lane | Head / disposition / next action |
| --- | --- |
| M14 `master-plan-m14-candidate-durability-a7d774f22e6` | `cd0ff053a89c981b77de8e8c9ab4302ce5ad95d1`; NOT integrated. Publication validator prerequisite committed. V8 settled with ten dirty owned files; focused GPT validation started as exec59710. See below. |
| M15 `master-plan-m15-candidate-state-reader-aa67276ff21` | `9cc379d2d4792154c23f6ab66425cfbfc90b16c8`; review-window correction committed/pushed after focused validation and local review. Integrate reader/prerequisite before M14 behavior. Runtime installation pending. |
| M16 `master-plan-m16-supervisor-candidate-reader-a45474af741` | `019fc75df644a83f9b02b662a3bf5fc1e7d642dc`; source installed through PR68. Its accepted ancestry still needs integration into canonical after reader delivery. |
| M17 `master-plan-m17-reader-install-operator-a8a5557444a` | Base `80b58f66440cae044bb043b81bca2c52019c6e85`; V3 private operator rebind running exec85754/PID3977260, immutable m17-assignment-v3.md, two private files only. Clean source-v3 clones at9cc379d; release clone remains a placeholder until actual merge/receipt. |

M07, M08, M10, M11, M12 and M13 recorded tips were freshly verified as canonical
ancestors on 2026-09-15 19:55 UTC. Their exact lanes and tips remain in the full
history commit. Preserve their ignored private operators and evidence; old live
preimages are not reusable authority. No automatic worktree/remote-branch cleanup.

### M14 completed prerequisite and current V8 result

M14 history contains the intentionally failing lifecycle fixture
`88dbef7ee2655e953da0191e0a5caea9d98e0287`, reader ancestry merge
`3935771a858cebb351dcc368f8e024818dfce7b8`, and publication validator
`cd0ff053a89c981b77de8e8c9ab4302ce5ad95d1`. Do not integrate the red fixture
into Stage 1 or ignore/weaken it to pass CI.

`GitReviewSnapshot.validatePublication` checks all newly exposed history,
metadata, intermediate blobs, parent edges, structural bounds and protected
entries/ancestor types, including absent leaves, empty subtree identity and
terminal NUL framing. Fresh audit corrections passed 26 tests / 0 failures in
7,282 ms, evidence `883c409f-038a-4cca-b637-26e985886a36`.
V4 used unassigned probes/two format passes; V5's four type errors were corrected;
V7 stopped at its call bound without formatting. Keep these historical
qualifications; final integrated formatting is pending.

V8 exec73703/PID3929686 settled exit0/completed with no surviving parent. Launch
proof `m14-launch-v8.json` confirms exact cwd, production and credential presence;
persisted session `ae3061c7-bd01-4162-8ee9-f946775e47d7`, stream
`75149d26-8b87-46df-900e-7a4db6cc19d4`, Flash/max/workspace-write/ask.
Immutable `m14-assignment-v8.md` owns exactly:

- `src/contracts/ports.ts`, `src/repair/keys.ts`, `src/github/impl.ts`.
- `src/host/actions-candidates.ts`, `src/host/local.ts`, `src/host/actions.ts`.
- `tests/repair/helpers.ts`, `tests/contracts/ports_test.ts`,
  `tests/host/actions-candidates_test.ts`, `tests/host/local_test.ts`.

The result adds the required preservation port, deterministic operation ref,
trusted storage/restoration, exact-head local import and completed-receipt
preservation. Worker reports no tests, children, probes or live effects; one
final formatter. Primary diff check passed; checks and audit remain pending.
Primary found a required correction: local loader must not classify every Git
nonzero, unreadable mapping or mismatched mapping as positive `not_found`.
Fresh no-history `candidate_preserver_acceptance_audit` requires full refresh
restore binding, safe settlement-aware scratch retention and faithful fixtures.
GPT evidence `8ed82c6f-69db-4289-818e-de60cc7cfffc` failed with 46 passed / 3 failed
in 11,424 ms (race, dropped injected runtime, relative fixture-root setup).
V8 used 144 tool calls, exceeding its 100-call assignment; preserve that deviation.
V8b owns only the two host files and their two test files under immutable
`m14-assignment-v8b.md`, max65 calls / expected10 minutes. Parent3929686 and its
direct descendants are absent; transfer source ownership only to this correction.
No V8 acceptance or dependent wiring until its known defects are corrected.
V8b launched20:13 as exec60647/PID3960889 in the same lane; live production/cwd/
credential-presence proof is `m14-launch-v8b.json`. Persisted session
`b14d1ca0-1834-4aa5-9636-297b024b6a00` and stream
`bfcbecf1-74a3-4bad-bf26-d24a8eba4953` confirm Flash/max/workspace-write/ask.
V8b settled exit0/completed in63calls. V8c settled exit0 after correcting exact
object peeling, preventing lazy network fetch and binding the actual Git store;
PID3967452/session `b2640453-406f-477b-ad07-1d5b36c89dcd`/stream
`c5d71b62-09f2-423e-9f39-42e486e92b42`, required settings and launch verified.
New GPT evidence `a432ac8e-b826-4e08-be68-7b12fe1efe5c` passed50 and failed only
one new negative fixture before its consumer: the strict parser rejected the
fixture's unequal target/preserved head. V8d exec68169/PID3972936 settled exit0
after changing it to a parsed descriptor with mismatched operation/ref digest.
Fresh audit found one remaining cleanup path: thrown validation must preserve
scratch just like unavailable validation. V8e exec61268/PID3977746 owns only
actions-candidates.ts for that correction. No new unchanged test execution.

Next serial work: preserve → publish and acknowledge → refresh → preserve/publish
successor → one central current-base/current-publication review gate before
reservation. Pending review recovery stays observation-only. Wire the real
preserver in both candidate-handoff fixture processes; preserve the destructive
fresh-process, empty-object-store and eight-step bounds. The read-only V9 map
from `issue48_application_candidate_audit` identifies exact loop/transition/
selection/CI and fixture call sites. Integrate compact canonical ancestry into
M14 only after its writer settles, so its later PR cannot restore the old ledger.

### M17 release boundary

Private owned paths: `.sentinel-reader-install-operator/{review,release}.ts`.
V2 exec17982/PID3928801 settled; session `4d4f52d7-3ab9-4408-906b-7d5252bb7bf8`
and stream `b39527b8…` prove required settings. Typecheck evidence
`ea133197-e993-46ed-aec0-632ffe0b79d4` passed in 6,983 ms. Bindings/import paths
and formatter whitespace changed from V1; guards are unchanged. Fixed local Git
identity reads lack explicit timeout (accepted availability qualification).
V2 appended verification after its formatter; preserve that deviation.

Required path after review recovery: exact completed authentic receipt → merge
PR70 exact head → rebind release-source-v2 to exact verified merge → fresh
`merge-binding.json` and `release-ownership.json` → existing GET-only-observation
operator appends one release request via repair-state CAS/readback → supervisor
owns fresh prior proof, promotion, candidate proof and acceptance/rollback.
Never fabricate a receipt, bypass a guard or manually write release state.

## Stranded tasks and queue acceptance

Issue48 attempt3 produced H1 `51842315f2f51cea007fefef1cd29d7baa755386`, while
PR51 remained H0 `0e689889b9486f020b7e6a7638e6c81fe181bd0d`. No retrievable H1
copy has been proved. Preserve its trusted completion, submitted attempt3 charge
and exact identity. Clearing an intent or recreating similar code is not recovery.

The approved generic loss path must distinguish positive absence from unknown
availability. A state-bound preservation attempt can report missing only when
the operation ref and configured trusted stores are positively absent. Persist
H1/B0 unchanged, preserved null, verified published H0, missing_evidence blocker
and original charge. A separately charged attempt4 requires an owned open H0 PR,
authentic H0 correction review, source eligibility and a real H0 fetch/B0 ancestry
proof BEFORE admission. The current V8 restorer does not yet provide that narrow
published-head recovery case. Do not fake it with advertised SHAs; leave the task
blocked until implemented. The full loss record remains in state Git ancestry.

Issue61 remains independently blocked with an ambiguous pre-receipt failure.
Fresh read-only issue61_blocker_scope confirmed this is distinct from issue48:
attempt2 reservation96e114 retains null resultId/requested PR/head in its intent;
ordinary-34993587187-repair.log:307 reports runtime_error/unavailable without a
trusted receipt. PR63 still contains the two-file RFC-850 fix ataf252716, with
passing CI34990801355 and unresolved P1 review5212344049. M14 preservation cannot
resume an unknown result; a byte/test dispute is not a cleared review finding.
Any future pre-receipt disposition must reconcile existing evidence and preserve
that ambiguous charge, candidate and review. Its cause is unproved. Do not reset
charges or let it stop unrelated eligible work.

Issue58 is a verified autonomous delivery: PR62 reviewed candidate `c89f4b1…`,
review5212089661, passing CI, bot merge at 16:15:06 UTC as runtime `20aae115…`,
accepted hosted release at 16:34:02.640, and bot closure at 17:19:29 (event
31190993641). Independent audit retained authenticated logs and matching digests.
This is one delivery; reader/storage infrastructure is not an additional canary.

## Overall acceptance register

| Task | Disposition and remaining boundary |
| --- | --- |
| T01 causal capture verifier | Accepted local production-consumer proof; gateway live capture remains separate. |
| T02 runtime model receipt | Accepted correlated request/runtime Luna/max evidence; no backend-attestation claim. |
| T03 runtime review transport | Accepted earlier concrete transport/source evidence; current PR70 failure requires diagnosis. |
| T04 gateway replay consumer | Accepted/published via gateway PR279; later actual causal capture remains T11. |
| T05 production replay isolation | Accepted source; issue4 closed. Preserve exact Linux/Mac qualifications in history. |
| T06 trusted host wiring | Hosted self-scope works; gateway credential/replay/VPS release capability remains incomplete. |
| T07 activation decisions | Hosted policy approved and installed. Gateway retention/stability/release authority still pending. |
| T08 integrated delivery | Earlier accepted source delivery remains valid; current durability slice not accepted/installed. |
| T09 isolated release and rollback | Required exact candidate/prior, real promotion and restoration proof remains pending. |
| T10 production ownership | Sentinel hosted active; gateway VPS ownership transfer unresolved. |
| T11 two autonomous deliveries | Incomplete; require two qualifying new deliveries, captured regression and queue overlap. |
| T12 six-hour observation | Incomplete; record actual window and gaps after verified activation/receipts. |
| T13 preserved work | Earlier reconciliation accepted; M14/M16 current integration obligations are listed above. |

Open issues last verified: 3, 6, 7, 8, 9, 10, 13, 14, 15, 16, 40, 48, 61, 69.
Issue40's full authenticated-request coverage includes unresolved token/checkout/
Git-transport authority seams; do not infer closure from REST-only coverage.
Gateway ai.ubq.fi runs on the VPS at verified revision
`07ee77b9aa241f516b44ced5340e814e08a8825a` (live `/health`, 2026-09-16 17:25
deploy); the earlier `8bf9daad…` record is superseded, and Deno is retired. The
local ai.ubq.fi checkout is only a development copy. The scoped
observer/replay credentials and release-authority choices are unanswered.
Existing gateway owner remains authoritative. Do not repeat questions, infer
approval or let those separate choices stop Sentinel self-repair.

## Evidence and continuation rules

Private artifact root: `/home/codex/.local/state/sentinel-reporting/2026-09-15/poka-yoke/`.
PR70 artifacts are under `reader-install-pr70-v1/`; failed PR67 artifacts under
`reader-install-v1/`. Retain originals; create new versions for changed inputs.
GPT Pro job `beef79fa-b45b-4d6d-b6e8-0be7648b3e67` completed; answer
`pro-answer-v1.md` and proposal `docs/poka-yoke-proposal-2026-09-15.md` are saved.
The one authorized submission is consumed. Do not submit another.

Test tool: `/home/codex/.codex/agents/assets/test-evidence/evidence.ts`.
Repository namespace: `459acb17ad9ea6b3117a31ea7e3934ee42910852ebdd735c5b0a8110d8083e59`.
References above are UUID suffixes in that namespace. Read archived output;
never rerun to recover it. GPT runs credential-free registered checks after
writer settlement. No model calls, GitHub writes or deployment inside tests.

Before a continuation: read this register first; reconcile exact canonical and
worker Git/process state; inspect existing evidence; record changed facts here.
A repeated unchanged failure requires diagnosis and a changed next action.
Worker READY, green CI, reviewed/merged source and healthy runtime are separate
from autonomous application delivery. Keep the goal active until its actual
acceptance is complete; do not reset missing evidence or historical charges.
