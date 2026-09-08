# Sentinel open-source reuse plan — 2026-09-07

Date: 2026-09-07, America/New_York. Source retrieval started on 2026-09-08 UTC. Role: planning facilitator. Status: research complete; ready as an additive implementation handoff. The single GPT Pro result was retrieved and important claims were checked against pinned source. No implementation performed by this session.

## 1. Decision and scope

Reuse small, licensed components at Sentinel's existing module boundaries. Do not import an entire issue-solving agent or replace the controller. The first implementation slice is (1) deterministic detection of repeated failed repair commands, adapted from OpenHands, and (2) GitHub rate-limit classification and durable cooldown, adapted from Octokit and GitHub's documented behavior. These target wasted work without adding another model runtime; the benefit still needs measurement.

The user asked for popular immature projects. This research includes emerging projects and established references, with activity and maturity stated separately. Stars establish visibility, not reliability. No measured improvement in Sentinel fix throughput is claimed by this planning document.

This is an additive handoff for the existing MASTER-PLAN.md goal. It does not replace that plan, its canonical identity, its module lanes, or its live acceptance requirements. The owner is already implementing Sentinel. Reconcile and transfer ownership before editing any affected surface. The recommendations marked **later** are not part of the copyable implementation goal.

| Priority | Source component | Sentinel use | Delivery scope |
| --- | --- | --- | --- |
| 1 | OpenHands TypeScript stuck detector | Stop repeated failed repair commands before the session ceiling | Implement narrow adaptation |
| 2 | Octokit rate-limit handling | Correct secondary-limit classification and respect cooldown across restarts | Implement narrow adaptation |
| Later | Aider repository map | Reduce repeated code search and prompt context | Measure before adopting |
| Later | Open SWE CI helpers | Avoid repeated repair attempts on unchanged or unrelated CI failures | Pattern reference |
| Later | OpenCode output truncation | Inspect saved failure output without rerunning commands | Pattern reference |
| Reference | mini-swe-agent / SWE-agent | Small trajectory and issue-to-patch evaluation cases | No runtime import |
| Reference | Cline | Context/checkpoint design | No runtime import |
| Reject | Current Sweep source | License and product-direction mismatch | No transplant |

## 2. Verified local starting point

The root is a planning checkout on `development`, observed at `17e1c1ad1a9f84ab4a20f1d2b2cd8bdca05ac800`. It has a pre-existing untracked `error.log`; preserve it. No remote was configured in this checkout at inspection. Do not create a GitHub repository or choose visibility from this handoff.

The active canonical implementation checkout was observed at `487b15c278287a06a290e257c5e2892d0e3891d9`. That is a research snapshot, not an instruction to reset or select an old implementation base. Its build ledger records active gateway producer and canonical decryption work. Other worker lanes and an additional Wave C lane also exist. At the later 00:27 UTC read, canonical remained at that SHA with dirty build/audit documents and decryption source/test files, plus four pre-existing untracked test directories; preserve all of them. Do not treat the original master plan's old “not created” status as current.

Source inspected in the canonical checkout:

| Existing surface | What is already present | Implication |
| --- | --- | --- |
| `src/github/client.ts`, `http.ts`, `impl.ts` | Bounded authenticated HTTP, pagination, same-origin Link checks, typed errors, ambiguous-write handling | Do not replace the client merely to obtain pagination. At the inspected revision, a 403 is rate-limited only when remaining is zero; secondary limits can be misclassified as authentication failures. Retry timing is not carried in `PortErrorV1`. |
| `src/repair/selection.ts`, `loop.ts` | Deterministic ranking, waits, one writer, WIP cap, durable model reservations | A new issue-hunting scheduler would duplicate existing work. |
| `src/repair/model-port.ts`, `codex-transport.ts` | Bounded Codex app-server session, notification callback, output/duration limits, supported interruption and settlement | Insert a narrow observer here. Do not replace the model runtime. The inspected observer does not classify repeated completed commands. |
| `src/contracts/ports.ts`, `state-snapshots.ts` | Strict shared types; errors have kind/detail; repair state uses exact keys | Durable GitHub cooldown needs a small explicit shared-contract change before module edits. Do not encode timestamps in error strings. |
| `src/replay/**`, `src/adapters/gateway/**`, `src/release/**` | Existing replay, sensitive evidence and deterministic release work | Keep these under their current owners; this reuse slice does not redesign them. |

These are source observations, not fresh test, review, deployment, or live-delivery proof. Read the current canonical `docs/build-status.md` on continuation.

## 3. Candidate findings

### OpenHands: best immediate component source

The linked `OpenHands/OpenHands` repository currently describes **Agent Canvas**, a beta control center. The current README assigns the agent engine to `OpenHands/software-agent-sdk` and scheduling/dispatch to `OpenHands/automation`. Old recommendations to copy `openhands/resolver/` from current main are not applicable: that path was absent in the retrieved tree. Historical resolver behavior is not proof of current production issue closure.

The SDK has an actual TypeScript detector at `clients/typescript/src/conversation/stuck-detector.ts`, plus tests at `clients/typescript/src/__tests__/stuck-detector.test.ts`. It detects repeated action/observation sequences, repeated actions with errors, alternating patterns, and monologues. Both the SDK root license and the separate TypeScript-client license are MIT, with distinct copyright notices.

**Adopt narrowly:** adapt the repeated failed-command pattern and relevant tests to Sentinel's completed Codex items. Keep attribution and a record of modifications. Do not import SDK conversation, server, workspace, UI, auth, or event classes.

**Required corrections to the upstream pattern:** pair results by exact item ID; ignore duplicate delivery of an item; bind thread/turn; exclude thoughts and timestamps from equality; use canonical data, not insertion-order JSON equality; require unchanged checkout evidence; disable monologue-based cancellation. Upstream's separate collection of actions and observations is not sufficient for concurrent event correlation. A changing error or a source edit is progress evidence and must break the sequence. No raw reasoning is needed.

SDK context condensers and sandbox tools are later references. LLM summarization would introduce model work and must not evade the existing admission policy. The basic GitHub workflow example runs a task with model credentials; it is not a complete implementation of Sentinel's review, merge, deployment, or closure gates.

### Octokit: best deterministic GitHub reference

The maintained MIT packages `@octokit/rest`, `@octokit/plugin-paginate-rest`, `@octokit/plugin-retry`, and `@octokit/plugin-throttling` provide concrete API plumbing. Prefer a pinned package when a missing API client is needed. Sentinel already has an implemented client boundary, so replacing it now would be unnecessary rework.

**Adopt now:** a small Deno adaptation of primary/secondary rate-limit classification and cooldown calculation. GitHub documents honoring `retry-after`, then `x-ratelimit-reset` when remaining is zero, and at least one minute with increasing backoff for secondary limits without a usable hint.

**Do not enable the retry plugin globally.** At the inspected pin it defaults to three retries and its error classifier has no read-only method restriction. A lost or failed mutating request can require reconciliation rather than repetition. The throttling package uses Bottleneck and in-process queues/timers; that is not durable repair state across scheduled runs. Do not copy its timers or add Redis. Preserve Sentinel's stricter redirect, body-size, origin and deadline checks. The pinned pagination iterator also catches any 409 and yields a synthetic 200 with an empty list, intended for empty repositories; do not inherit that behavior for review/check/issue completeness.

Conditional authenticated GETs can reduce primary-rate usage on unchanged responses, but ETag cache correctness is a separate later change. A 304 cannot mean an empty issue set, and pages must be cached with authorization/repository/query identity. Do not bundle this cache into the first slice.

### Aider: useful repository map, later

`aider/repomap.py` ranks definitions/references and fits a repository map within a token budget. It brings Python, tree-sitter/grep-ast, diskcache, graph/tokenization and Aider-specific integration. The project license is Apache-2.0.

**Later experiment:** compare a bounded, revision-keyed map against the existing agent's own search on representative accepted issue tasks. Reuse the algorithm or a controlled helper only if saved search/model work exceeds indexing and maintenance cost. Exclude secrets and generated/vendor trees; invalidate on actual content changes, not just HEAD when the checkout is dirty. Do not introduce Python and a graph stack in the first slice.

`aider/coders/editblock_coder.py` is an edit-engine reference, not an immediate import. Sentinel already delegates edits to Codex. Adding a second fuzzy edit engine would expand the correctness boundary without evidence of a current editing bottleneck.

### Open SWE: valuable CI and continuation patterns, later

The current `langchain-ai/open-swe` implementation is a Python Deep Agents/LangGraph system with an MIT repository license. Its README explicitly says it is evolving and says production self-hosting of the standalone LangGraph Agent Server requires a license key. Repository licensing does not settle the deployment stack's terms.

Useful concrete paths: `agent/baby_sit.py` and `agent/bundled_skills/baby-sit/SKILL.md` (head-bound CI observation and targeted feedback), `agent/github/ci.py` (failed checks and comparison inputs), `agent/middleware/stable_tool_order.py` (canonical order of parallel tool results), and `agent/middleware/repair_orphaned_tool_calls.py` (interrupted transcript recovery).

**Later:** borrow head-bound failure deduplication and compare candidate/base failures before spending another repair call. Do not adopt best-effort partial reads as clean CI. A same-name base failure is not sufficient proof that a candidate failure is harmless.

Stable tool order can improve prefix reuse only where Sentinel owns the model message assembly. It currently uses app-server; do not reorder that server's internal transcript. Orphan repair is a diagnostic reference, not permission to manufacture a successful result, retry an ambiguous external write, or recreate a missing workspace. `pr_creation_guard.py` is a useful policy example, but a shell-command regex is not a substitute for withholding write credentials.

The inspected baby-sit code deduplicates dispatch with a hash of head SHA and retry count, and removes that key after a dispatch exception. Do not copy those semantics: new failures can arrive at the same head, and an exception can follow an accepted dispatch. Reuse the check/feedback separation with evidence identity covering repository, PR, head, check or review ID, run attempt and changed content. Preserve ambiguous operations until reconciled.

A later zero-model experiment can replay a small sanitized observation set through the actual m01→m04 path: identical snapshots, a different failure at the same head, new run attempt, changed review content, changed head, incomplete pages and lost write acknowledgement. Stop with “already handled” if existing code performs correctly. Implement a new feedback helper only if this reveals a real redundant-diagnosis gap. Any later live comparison uses ordinary authorized eligible tasks, never solves the same issue twice for a benchmark.

Do not import the dashboard, webhooks, five graph entrypoints, parallel task runtime, provider fallback, or scheduler.

### mini-swe-agent and SWE-agent: evaluation references

Both repositories have MIT licenses. `mini-swe-agent/src/minisweagent/agents/default.py` is a compact agent loop with step/time/cost limits and a saved trajectory; `sweagent/agent/agents.py` contains a much larger agent/retry implementation. `sweagent/utils/github.py` reads issue statements and related GitHub data.

**Reuse as test-design references:** terminal outcomes, repeated format-error handling, useful trajectory fields, and a small issue-to-patch evaluation contract. Do not copy a post-call cost counter as durable rolling admission. Do not import a Python model/environment loop or broad benchmark harness into the runtime. Benchmark patch success is not evidence of reviewed, deployed and accepted issue closure.

### OpenCode: large-output handling, later

`anomalyco/opencode/packages/opencode/src/tool/truncate.ts` saves full output and returns a bounded preview plus a file reference. MIT applies to this source at the inspected root; other directories have separate licenses. The implementation couples to Effect, Node services, configuration, permissions and cleanup.

**Later pattern port:** retain authorized sanitized failure output once, provide a bounded preview, and let the agent read selected ranges without rerunning the command. Use Sentinel's existing restricted evidence/test archive and its retention rules. Do not copy the seven-day cleanup timer, task-delegation hint, full session runtime, or raw private-output handling. A preview must not become the only evidence of pass/fail.

### Cline: useful history, low immediate fit

The current tree has an Apache-2.0 root, a separate VS Code license, a CLI and SDK packages. Context compaction and checkpoint components are real, but integrating them would overlap the existing Codex session and Git checkpoint boundaries. Concrete paths include `sdk/packages/core/src/extensions/context/basic-compaction.ts` and `apps/vscode/src/sdk/sdk-checkpoints.ts`.

**Reference only for this goal.** These paths were located; their full dependency and per-file license closure was not audited. Do not vendor them on the strength of popularity.

### Sweep: reject current transplant

The current README says the team is building a JetBrains assistant. The retrieved root license is the Sweep Enterprise Edition license, restricts production/commercial use, and distinguishes an unspecified Free Software subset. The last pushed timestamp was in September 2025.

**Reject current-head source copying for this plan.** A historical permissively licensed file could be assessed separately with exact provenance, but this research did not prove such a candidate. Do not call the current root a general MIT-licensed issue bot.

## 4. Reuse method

Use this order: existing capability → small pinned dependency → narrow attributed source adaptation → larger subprocess only with measured benefit. A submodule is a pinned repository checkout; it does not isolate dependencies, freeze transitive packages, grant a license exception, or make transplanted code track future fixes.

No production submodule is required for the first slice. The selected detector depends on upstream event types that Sentinel does not use; adapt the small algorithm and tests into the existing repair module. Port the small rate-limit classification/calculation into the existing GitHub module rather than pulling in Octokit/Bottleneck solely for it.

For copied or derived code/tests, record the repository URL, full commit SHA, exact paths, license/copyright text, upstream file digest, local destination, modifications and update owner in a concise third-party manifest. Keep required notices with distributions. An update is a reviewed diff against a pinned source, never an automatic pull from main. Do not import upstream workflows, hooks, secrets, telemetry or build scripts. A reference checkout outside runtime may help compare updates; it need not be a committed submodule.

## 5. Bounded implementation contract

Implement the following two changes sequentially. No repository reorganization, replacement framework, model substitution, new environment variable, secret or user-facing CLI flag is part of this scope.

### Slice A — OpenHands-derived failed-command loop guard

Owner: existing m04-repair lane, after its previous writer has settled. Surface: `src/repair/**` and `tests/repair/**`; shared contracts/integration remain primary-owned.

1. Normalize only completed command items from the current exact thread and turn. Deduplicate item IDs. Compare command, checkout-relative cwd, exit status, bounded output digest and a trusted checkout-content checkpoint. Ignore prose, reasoning, timing and duplicate stream delivery. Missing output or uncertain progress evidence means insufficient evidence for an early stop.
2. Start with the narrow case of four identical **failed** command/result pairs and no intervening progress. Do not cancel on repeated successful reads, elapsed silence, agent messages, normal polling, expected fail-before replay, changing failures, file changes or an active command. Keep existing overall bounds active. Do not normalize arbitrary changing text out of errors to force equality. Nonzero exit alone is insufficient: use known command/result semantics, exclude no-match search results and trusted expected-failure phases, and treat an unknown command outcome as inconclusive.
3. On a confirmed loop, send one bounded corrective message through supported `turn/steer` with `expectedTurnId`, if the installed interface supports it within the existing charged session. Tell the worker to inspect the saved failure and change its approach. The message is trusted fixed text with a sanitized evidence reference, not raw command output. If two further identical failed pairs arrive after steering with no intervening progress, or steering is unavailable, use the existing `turn/interrupt` path. Do not automatically start a replacement model session. Any later continuation/retry still requires normal admission. If the configured budget policy treats steering as a separately charged continuation, reserve it first; if that reservation is unavailable, interrupt without starting more inference.
4. Await exact terminal settlement and preserve checkout/checkpoint evidence. An interrupt acknowledgement is not exit proof. Record a sanitized loop-stop reason through the existing outcome path; do not classify this as an application defect or a successful candidate. The repair writer must settle before the next item can run.
5. Use a bounded observation window; do not retain an unbounded transcript. Event observations do not reserve additional model starts. Do not inspect raw reasoning.

Verified integration surface: official app-server documentation exposes `item/completed`, `turn/steer`, `turn/interrupt` and `turn/completed`. Local `codex-cli 0.153.4` generated schema confirms `ItemCompletedNotification` carries item/threadId/turnId; `commandExecution` carries command/cwd/status/aggregatedOutput/exitCode; `TurnSteerParams` requires `expectedTurnId`. Schema generation made no model request. These facts do not prove an authenticated runtime session works. Regenerate against the implementation host's installed version before binding its parser.

Acceptance: scripted completed-item stream proves the loop stops before the existing duration ceiling; distinct failures and edits continue; duplicates/stale-turn events cannot trigger; expected baseline failure is not suppressed; terminal settlement is required; a second eligible issue progresses only after writer settlement. Exercise the real model-port and repair entrypoint with injected external transport, not only a pure helper.

### Slice B — Octokit-derived GitHub cooldown

Owners in order: primary for the minimal contract, m01-github for classification/calculation, primary for durable repair-loop wiring. Do not overlap these writers.

1. Preserve the existing GitHub client. Classify authenticated primary exhaustion and explicit secondary-limit responses separately from ordinary authorization denial. Inspect bounded response text only for known secondary-limit markers; never return raw bodies or credentials in errors. A generic 403 remains forbidden, not retryable by assumption.
2. Carry a validated retry-not-before timestamp as structured rate-limit metadata. Honor all applicable server hints conservatively; do not clamp a server deadline earlier to fit a run. Handle malformed, absent and out-of-range hints explicitly. For a confirmed secondary limit without a valid hint, use GitHub's documented minimum minute and bounded increasing cooldown; do not apply this fallback to arbitrary auth errors.
3. Persist cooldown in the existing repair-state branch before another GitHub request. It must cover intake before a work record exists and all requests sharing the affected installation credential. A per-issue wait alone is insufficient. Keep this independent of model-start reservations and release state. The primary freezes the smallest exact parser/type/fixture change first; use the existing Clock and CAS store.
4. On resume, load the cooldown before any affected GitHub read/write. Skip until eligible; continue independent local/evidence work where possible and exit when no useful work remains. Do not sleep an agent, busy-poll, create a queue service or add Redis. Do not use an in-memory-only timer as restart proof.
5. No automatic retries of mutating requests. Preserve operation intent and reconcile exact push/PR/review/merge/closure effects before any later reattempt. A cooldown is permission to reconsider an operation, not proof that an earlier write failed. Successful reads must not erase a still-applicable later deadline for the same scope.

Acceptance: actual client → typed error → durable store → restart → loop path respects primary and secondary deadlines, including a deadline longer than the next scheduled run. A generic 403 does not retry. A read failure never becomes an empty issue set. Duplicate requests, extra model reservations and writes during cooldown must be zero. Inject a lost PR/merge response and prove that enabling cooldown has not introduced automatic repetition. Preserve current pagination, origin, body-size and deadline regressions.

### Local proof and live boundaries

Read `~/.codex/agents/test-evidence.md`, register the existing focused commands with its installed evidence tool, and preserve output outside Git. Do not run tests merely to rediscover output. Start with small deterministic cases, then one relevant integrated run through the actual entrypoint after wiring. No model calls, GitHub writes or deployment belong in the local harness.

Record baseline and candidate SHAs, fixture digests, result references, request/model-start counts, loop detection/settlement point, false-positive cases and recovery result. Deterministic proof establishes behavior, not actual model-token or production-throughput savings.

After local acceptance, use the master plan's integrated current-head Codex review and delivery gates. Do not request per-module reviews. If live operation is already authorized and configured by the owner, observe the next existing eligible tasks without introducing extra benchmark model calls. Report time to accepted fix, model starts, authoritative tokens when available, failed repair attempts and duplicate external actions. Otherwise report the exact live boundary; do not guess budgets or enable the target.

## 6. Canonical identity and ownership handoff

This document extends the existing goal, so the existing-identity rule in `git-coordination.md` applies. Do not derive or create a competing canonical integration lane from this dated filename.

| Field | Preserved identity |
| --- | --- |
| Canonical goal ID | `/Users/nv/repos/ubiquity/sentinel/MASTER-PLAN.md` |
| Additive handoff | `/Users/nv/repos/ubiquity/sentinel/docs/oss-reuse-plan-2026-09-07.md` |
| Repository root | `/Users/nv/repos/ubiquity/sentinel` |
| Canonical worktree name | `master-plan-gfa795549e5` |
| Canonical worktree path | `/Users/nv/repos/ubiquity/sentinel/.codex-worktrees/master-plan-gfa795549e5` |
| Canonical branch | `codex/master-plan-gfa795549e5` |
| Lane state | Existing; owned by the current master-plan orchestrator |
| Original initialization base | `ec4bd82df4adfdb962e10332607ee4fbf539cdeb` |
| Research snapshot | `487b15c278287a06a290e257c5e2892d0e3891d9`; not a reset target |
| m04 worktree / branch | `/Users/nv/repos/ubiquity/sentinel/.codex-worktrees/master-plan-m04-repair-ac50ee9a0a3` / `codex/master-plan-m04-repair-ac50ee9a0a3` |
| m01 worktree / branch | `/Users/nv/repos/ubiquity/sentinel/.codex-worktrees/master-plan-m01-github-a86bd3790da` / `codex/master-plan-m01-github-a86bd3790da` |
| Implementation base | Exact current integrated SHA recorded by the owning primary after reconciliation and before assignment; never a moving ref or the old research snapshot by default |

Immediate next step: read the master plan, this addendum and current build ledger; verify branch/worktree/status and obtain the existing owner's transfer of the affected surfaces. A new session is not proof that the old owner or descendants stopped. If another primary still owns canonical integration, hand this plan to that owner or obtain an explicit handoff; do not run two orchestrators on the same lane.

The primary owns contract changes, third-party notices, cross-module wiring, Git and acceptance. Use the current global DSH playbook for implementation assignments and required model/max receipts; DSH workers do not commit or push. Use the recorded existing module lanes only after their uncommitted work and descendants are reconciled. Record exact new module bases and integrate with ancestry preserved. Update the existing canonical `docs/build-status.md`; do not create another progress ledger. Bring this planning-only document into canonical history without pulling unrelated root work.

No target gateway edits or release-controller edits are authorized by this addendum. Retain one runtime implementation writer, at most three unfinished PRs, fixed Luna/max, rolling-hour/seven-day model admission, secret-free workers, trusted external writes, current-head completed review/CI/protections, and issue closure only after exact production acceptance. Keep two-task live delivery and exact Deno rollback requirements from MASTER-PLAN.md distinct from this local efficiency slice.

## 7. Research provenance and source pins

One user-authorized GPT Pro submission: `2f124644-a2fc-4dde-9616-2c4f65601ba7`, submitted 2026-09-08 00:15 UTC; budget used 1 of 1. Authorization was the user's explicit `$gpt-pro` request for this OSS reuse research. Do not submit another Pro prompt from this handoff. Retrieve the same job if needed. Local source copies and retrieval output: `/tmp/sentinel-oss-research-20260908/`; this temporary cache is not needed to follow the pinned public links below. The private Pro job cache retains the original request/result. The result completed and was retrieved at about 2026-09-08 00:32 UTC; retrieval process exited 0. No resubmission was made.

GPT Pro independently recommended narrow reuse, prioritized Octokit where gaps exist, and proposed Open SWE CI-feedback deduplication as its first experiment. It also discussed Aider maps, OpenCode edits, mini-SWE-agent, OpenHands condensation and test-cache correctness. The primary verified the decisive repository split, licenses, retry behavior and Open SWE dispatch code. The final implementation order differs deliberately: local inspection found concrete missing secondary-limit timing and failed-command detection, while duplicate CI reasoning has not yet been demonstrated. Therefore CI deduplication remains a bounded later probe, and OpenHands' locally verified TypeScript detector is added to the immediate shortlist. This is a source-grounded synthesis, not an unreviewed copy of the model answer.

No Turbo/Nx or remote-cache migration is included. Existing test-evidence rules remain authoritative. Native dependency caching and any existing evidence reuse should be assessed before new caching machinery; cached worker output cannot replace mandatory fresh acceptance evidence. Other model-suggested candidates not independently verified here are not approved dependencies.

GitHub metadata observed on 2026-09-08 UTC (2026-09-07 New York). Pushed dates are repository activity signals, not human-maintenance or release evidence.

| Repository | Stars | Last pushed (UTC) | Root license | Exact inspected commit |
| --- | ---: | --- | --- | --- |
| [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) | 86,663 | 2026-09-07T23:20:30Z | MIT | [f7fb0c4b21f5](https://github.com/OpenHands/OpenHands/commit/f7fb0c4b21f5ed726edbba8a6309634ef434b004) |
| [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk) | 1,066 | 2026-09-07T18:03:11Z | MIT | [df2ea8fa5542](https://github.com/OpenHands/software-agent-sdk/commit/df2ea8fa5542d5d2a543e108bc8b2d4fbbab34b1) |
| [octokit/plugin-throttling.js](https://github.com/octokit/plugin-throttling.js) | 127 | 2026-09-07T23:13:47Z | MIT | [eb4215edcd97](https://github.com/octokit/plugin-throttling.js/commit/eb4215edcd97f20ade800b18d964bf798e0d70b7) |
| [octokit/plugin-retry.js](https://github.com/octokit/plugin-retry.js) | 48 | 2026-09-07T18:32:00Z | MIT | [d6e06bd8c68b](https://github.com/octokit/plugin-retry.js/commit/d6e06bd8c68b34abcf1e4d24b647f74027788352) |
| [octokit/plugin-paginate-rest.js](https://github.com/octokit/plugin-paginate-rest.js) | 60 | 2026-09-07T21:55:41Z | MIT | [27411a02014a](https://github.com/octokit/plugin-paginate-rest.js/commit/27411a02014add863308588113dd4d703bf3d165) |
| [octokit/rest.js](https://github.com/octokit/rest.js) | 662 | 2026-09-08T00:10:43Z | MIT | [cd9cb8cd4965](https://github.com/octokit/rest.js/commit/cd9cb8cd4965d99c7dac8c87d249308956250be3) |
| [Aider-AI/aider](https://github.com/Aider-AI/aider) | 48,820 | 2026-05-22T14:02:20Z | Apache-2.0 | [5dc9490bb35f](https://github.com/Aider-AI/aider/commit/5dc9490bb35f9729ef2c95d00a19ccd30c26339c) |
| [langchain-ai/open-swe](https://github.com/langchain-ai/open-swe) | 10,681 | 2026-09-07T21:35:41Z | MIT | [2ad5524a8a29](https://github.com/langchain-ai/open-swe/commit/2ad5524a8a29211678408e5261733b4f0f1cf1ff) |
| [SWE-agent/mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) | 7,152 | 2026-09-07T22:16:21Z | MIT | [04d809ceab9d](https://github.com/SWE-agent/mini-swe-agent/commit/04d809ceab9df28f9adaed044884180159172930) |
| [SWE-agent/SWE-agent](https://github.com/SWE-agent/SWE-agent) | 20,270 | 2026-09-07T22:17:28Z | MIT | [3ea751c087f3](https://github.com/SWE-agent/SWE-agent/commit/3ea751c087f32b16e039a2233dd6eefecef325d5) |
| [anomalyco/opencode](https://github.com/anomalyco/opencode) | 205,689 | 2026-09-08T00:10:01Z | MIT | [ecbc6ccac85b](https://github.com/anomalyco/opencode/commit/ecbc6ccac85b3e8087b6445e584318419b9e2b34) |
| [cline/cline](https://github.com/cline/cline) | 67,643 | 2026-09-08T00:00:59Z | Apache-2.0 | [c21b17255b22](https://github.com/cline/cline/commit/c21b17255b228e88a1518c18a73a473ee5876362) |
| [sweepai/sweep](https://github.com/sweepai/sweep) | 7,708 | 2025-09-18T06:10:59Z | NOASSERTION | [a8b8b67bda4f](https://github.com/sweepai/sweep/commit/a8b8b67bda4f89faac9314d34e7c7d5a64f76046) |

OpenHands/automation was also checked: 21 stars, pushed 2026-09-07T12:40:09Z, MIT, commit [05fcfff79f68afd2d48e8446b4e90551f10747bd](https://github.com/OpenHands/automation/tree/05fcfff79f68afd2d48e8446b4e90551f10747bd). Its scheduler/database/webhook runtime is out of scope; this small split repository is not independently popular merely because OpenHands is.

Pinned component sources:

- OpenHands/OpenHands: [README.md](https://github.com/OpenHands/OpenHands/blob/f7fb0c4b21f5ed726edbba8a6309634ef434b004/README.md); [LICENSE](https://github.com/OpenHands/OpenHands/blob/f7fb0c4b21f5ed726edbba8a6309634ef434b004/LICENSE).
- OpenHands/software-agent-sdk: [clients/typescript/src/conversation/stuck-detector.ts](https://github.com/OpenHands/software-agent-sdk/blob/df2ea8fa5542d5d2a543e108bc8b2d4fbbab34b1/clients/typescript/src/conversation/stuck-detector.ts); [clients/typescript/src/__tests__/stuck-detector.test.ts](https://github.com/OpenHands/software-agent-sdk/blob/df2ea8fa5542d5d2a543e108bc8b2d4fbbab34b1/clients/typescript/src/__tests__/stuck-detector.test.ts); [clients/typescript/LICENSE](https://github.com/OpenHands/software-agent-sdk/blob/df2ea8fa5542d5d2a543e108bc8b2d4fbbab34b1/clients/typescript/LICENSE); [openhands-sdk/openhands/sdk/context/condenser/README.md](https://github.com/OpenHands/software-agent-sdk/blob/df2ea8fa5542d5d2a543e108bc8b2d4fbbab34b1/openhands-sdk/openhands/sdk/context/condenser/README.md); [examples/03_github_workflows/01_basic_action/agent_script.py](https://github.com/OpenHands/software-agent-sdk/blob/df2ea8fa5542d5d2a543e108bc8b2d4fbbab34b1/examples/03_github_workflows/01_basic_action/agent_script.py).
- octokit/plugin-throttling.js: [src/index.ts](https://github.com/octokit/plugin-throttling.js/blob/eb4215edcd97f20ade800b18d964bf798e0d70b7/src/index.ts); [LICENSE](https://github.com/octokit/plugin-throttling.js/blob/eb4215edcd97f20ade800b18d964bf798e0d70b7/LICENSE).
- octokit/plugin-retry.js: [src/index.ts](https://github.com/octokit/plugin-retry.js/blob/d6e06bd8c68b34abcf1e4d24b647f74027788352/src/index.ts); [src/error-request.ts](https://github.com/octokit/plugin-retry.js/blob/d6e06bd8c68b34abcf1e4d24b647f74027788352/src/error-request.ts); [src/wrap-request.ts](https://github.com/octokit/plugin-retry.js/blob/d6e06bd8c68b34abcf1e4d24b647f74027788352/src/wrap-request.ts).
- octokit/plugin-paginate-rest.js: [src/iterator.ts](https://github.com/octokit/plugin-paginate-rest.js/blob/27411a02014add863308588113dd4d703bf3d165/src/iterator.ts).
- octokit/rest.js: [README.md](https://github.com/octokit/rest.js/blob/cd9cb8cd4965d99c7dac8c87d249308956250be3/README.md); [package.json](https://github.com/octokit/rest.js/blob/cd9cb8cd4965d99c7dac8c87d249308956250be3/package.json).
- Aider-AI/aider: [aider/repomap.py](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py); [aider/coders/editblock_coder.py](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/editblock_coder.py); [LICENSE.txt](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/LICENSE.txt).
- langchain-ai/open-swe: [agent/baby_sit.py](https://github.com/langchain-ai/open-swe/blob/2ad5524a8a29211678408e5261733b4f0f1cf1ff/agent/baby_sit.py); [agent/bundled_skills/baby-sit/SKILL.md](https://github.com/langchain-ai/open-swe/blob/2ad5524a8a29211678408e5261733b4f0f1cf1ff/agent/bundled_skills/baby-sit/SKILL.md); [README.md](https://github.com/langchain-ai/open-swe/blob/2ad5524a8a29211678408e5261733b4f0f1cf1ff/README.md); [agent/github/ci.py](https://github.com/langchain-ai/open-swe/blob/2ad5524a8a29211678408e5261733b4f0f1cf1ff/agent/github/ci.py); [agent/middleware/stable_tool_order.py](https://github.com/langchain-ai/open-swe/blob/2ad5524a8a29211678408e5261733b4f0f1cf1ff/agent/middleware/stable_tool_order.py); [agent/middleware/repair_orphaned_tool_calls.py](https://github.com/langchain-ai/open-swe/blob/2ad5524a8a29211678408e5261733b4f0f1cf1ff/agent/middleware/repair_orphaned_tool_calls.py); [agent/middleware/pr_creation_guard.py](https://github.com/langchain-ai/open-swe/blob/2ad5524a8a29211678408e5261733b4f0f1cf1ff/agent/middleware/pr_creation_guard.py); [LICENSE](https://github.com/langchain-ai/open-swe/blob/2ad5524a8a29211678408e5261733b4f0f1cf1ff/LICENSE).
- SWE-agent/mini-swe-agent: [src/minisweagent/agents/default.py](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/agents/default.py); [LICENSE.md](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/LICENSE.md).
- SWE-agent/SWE-agent: [sweagent/agent/agents.py](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/agent/agents.py); [sweagent/utils/github.py](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/utils/github.py); [LICENSE](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/LICENSE).
- anomalyco/opencode: [packages/opencode/src/tool/truncate.ts](https://github.com/anomalyco/opencode/blob/ecbc6ccac85b3e8087b6445e584318419b9e2b34/packages/opencode/src/tool/truncate.ts); [packages/opencode/test/tool/truncation.test.ts](https://github.com/anomalyco/opencode/blob/ecbc6ccac85b3e8087b6445e584318419b9e2b34/packages/opencode/test/tool/truncation.test.ts); [LICENSE](https://github.com/anomalyco/opencode/blob/ecbc6ccac85b3e8087b6445e584318419b9e2b34/LICENSE).
- cline/cline: [sdk/packages/core/src/extensions/context/basic-compaction.ts](https://github.com/cline/cline/blob/c21b17255b228e88a1518c18a73a473ee5876362/sdk/packages/core/src/extensions/context/basic-compaction.ts); [apps/vscode/src/sdk/sdk-checkpoints.ts](https://github.com/cline/cline/blob/c21b17255b228e88a1518c18a73a473ee5876362/apps/vscode/src/sdk/sdk-checkpoints.ts); [LICENSE](https://github.com/cline/cline/blob/c21b17255b228e88a1518c18a73a473ee5876362/LICENSE).
- sweepai/sweep: [README.md](https://github.com/sweepai/sweep/blob/a8b8b67bda4f89faac9314d34e7c7d5a64f76046/README.md); [LICENSE](https://github.com/sweepai/sweep/blob/a8b8b67bda4f89faac9314d34e7c7d5a64f76046/LICENSE).


Official references fetched during planning:

- GitHub REST best practices: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
- Codex app-server lifecycle, items and schema generation: https://learn.chatgpt.com/docs/app-server

The recommendations are engineering judgments from retrieved source and the local snapshot. Source files were not executed; Deno package compatibility, achieved speedups and autonomous production closure are not established by this research.

## Copyable implementation goal

Goal: Use canonical worktree name master-plan-gfa795549e5 at /Users/nv/repos/ubiquity/sentinel/.codex-worktrees/master-plan-gfa795549e5 on branch codex/master-plan-gfa795549e5, read AGENTS.md, MASTER-PLAN.md and /Users/nv/repos/ubiquity/sentinel/docs/oss-reuse-plan-2026-09-07.md in full, reconcile and transfer existing ownership, then implement and integrate only the OpenHands-derived failed-command loop guard and Octokit-derived durable GitHub cooldown through the recorded existing lanes, prove their actual runtime paths with deterministic local evidence, preserve the current model, budget, review and release boundaries, and complete the applicable integrated delivery gates without importing a replacement agent framework or activating unapproved live work.
