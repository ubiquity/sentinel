# Sentinel implementation divergence audit

Audit started: 2026-09-07; refreshed 2026-09-08 01:26 UTC. Initial source baseline: `5ed87855c4bd911b2bd395e2ce7a9c09e7c326de`. Accepted upstream source checkpoints: Sentinel consumer `278bcbb` on canonical branch `codex/master-plan-gfa795549e5`, gateway producer `df256c74` and exact-build receipt producer `79ca71fc` on the recorded m06 lane. This is an implementation audit, not a replacement plan or production acceptance receipt. `docs/build-status.md` remains the single progress ledger. Dated follow-ups below preserve the investigation history; later acceptance entries supersede earlier defect status.

## Governing documents

- [MASTER-PLAN.md](../MASTER-PLAN.md) defines the outcome, architecture, ownership and acceptance requirements.
- [lifecycle.txt](lifecycle.txt) is the readable runtime sequence.
- [design-rationale.md](design-rationale.md) explains the design choices and is subordinate to the master plan.

The plan's opening status and planned-lane labels describe its planning snapshot. They do not describe current implementation progress. The code is in the recorded canonical worktree; the root `development` checkout remains planning-only.

## Finding

Current status (00:51 UTC): actual gateway raw upstream capture, incident discovery, export, retained storage and standalone v2 decryption now work together in an independently verified local path. The consumer terminal/header defect and producer simultaneous-limit disclosure defect are corrected and committed. A public synthetic fixture was generated from the exact committed producer for permanent compatibility testing. Trusted sanitization, application regression replay and runtime assembly remain incomplete.

The code follows the proposed polling architecture at module level, but the complete production path is not assembled. The main divergence is between tested component behavior and the required autonomous delivery outcome. Both scheduled commands still reach direct entrypoints that throw for missing host wiring. Passing the local harness cannot establish a working standalone deployment.

## Requirement and evidence matrix

| Master-plan requirement | Current evidence | Divergence or missing proof |
| --- | --- | --- |
| One repair writer and a separate deterministic release writer (§4) | Separate repair/release modules and non-cancelling workflow concurrency groups. | No deployed host or ownership transfer. Source configuration is not proof of exclusive live writers. |
| Actual production entrypoints with real adapters and fake external transports (§9.1) | `runRepairEntrypoint` and `runReleaseEntrypoint` exist. Gateway adapter/store and release REST client have real composition tests. | `src/main.ts:146` and `src/release-main.ts:195` deliberately throw on direct execution. `makeRepairRig` still uses FakeGithub, FakeReplay and FakeModel (`tests/integration/helpers.ts:206`). This is not the required complete real-adapter composition. |
| Capture, preserve and replay an offending request (§6, §9.1) | Actual authenticated gateway handler → adapter discovery/read → LocalArtifactStore → standalone authenticated decryption preserves exact request and raw upstream bytes. | Gateway adapter emits `replay: null` (`incident-adapter.ts:227`). No composed positive sanitizer, permanent application regression generator, fixture resolver or capture-to-fixture binding. Decryption produces private plaintext, not a safe fixture. |
| Recorded upstream replay without paid reproduction (§6) | Committed m06 producer captures bounded raw bytes before normalization on all four approved provider paths. Private metadata v2 binds the trace to the fingerprint; actual producer-to-consumer compatibility passed without network or inference. | A recorded raw trace and public protocol golden do not establish a trusted sanitized incident fixture or a before-failure/after-pass application regression. Partial/cancelled/error/truncated traces remain explicit. |
| Work on a second task while the first review waits (§9.2) | Deterministic loop tests exercise pending-review selection with one implementation action at a time. | Useful overlap through the assembled real runtime and two new production deliveries remains unproved. |
| Crash recovery and real state conflicts (§9.3) | Git-backed state/CAS tests and scripted ambiguous publication/release tests exist. | Full actual-adapter lifecycle interruption proof and an isolated real release/rollback drill remain unproved. |
| Durable rolling-hour/seven-day limits and bounded sessions (§5, §9.4) | Durable budget tests, 90-minute model-start cutoff, 120-minute repair ceiling, late-admission settlement/resume tests. | Live limits/session settings remain unset. Actual runtime provider receipt verifier and session host are not supplied. Default-unverifiable sessions now stop before opening. |
| Verified current-head review, CI and protected writes (§7, §9.5) | Strict review/merge normalization and negative-path tests; bounded app-server transport. | No production ReviewServiceTransport is assembled. Actual completed-clean/finding-bearing reviewer receipts need verified service integration. The prior development review cycle is exhausted; current bytes are not accepted by a new review. |
| Exact candidate/prior revision, monitoring and rollback (§7, §9.6) | Deno release REST client and controller are tested against scripted transport. Target `79ca71fc` writes an exact repository/run/attempt/workflow/SHA/project/revision receipt after candidate verification; actual shell execution and permanent offline tests pass. | Authenticated upload consumption and trusted request/run association are not assembled; the resolver remains unavailable. Target workflow still promotes, so exclusive ownership is not transferred. No actual isolated rollback or new live delivery proof. |
| Evidence retention past the source's 48-hour expiry (§6, §9.7) | Local ciphertext store has bounded retention; expiry behavior is tested. Target `f771c2a9` adds durable discovery and exact export binding, with incident metadata surviving logical capture expiry. | Continuous production ingestion is not proved. Source ciphertext still expires after 48 hours; finite production retention/storage values remain owner decisions. |
| Two new autonomous deliveries, continued selection and six-hour observation (§1, §9) | No receipt set proving this outcome. | Not achieved. Existing prototype issues, health checks, synthetic fixtures and local test totals cannot substitute. |

## Confirmed defects corrected during this audit

- `2cba969`: all evidence consumers match explicit incident ID and full repository identity. Fresh foreign records and global evidence-ID collisions fail before persistence/use. Real adapter/store tests now reach the truthful missing-fixture blocker without repeated fetches or unchanged writes.
- `2ddf0b9`: retained ciphertext can be authenticated and decrypted using the existing producer protocol. The compatibility fixture was generated with actual producer functions using public synthetic data. A separately reproduced oversized-stream cleanup defect was corrected before acceptance.
- `c0e066c`: missing receipt verification prevents session opening; early notifications are retained in a bounded ordered buffer; fatal transport failure discards queued completion and remains persistent. A real subprocess regression covers terminal/response/overflow ordering.

Focused independent checks passed for these changes. The integrated `test:local` run on the exact source candidate passed 465 tests with zero failures in 8 minutes 21 seconds; formatting, lint and types passed, and before/after source hashes matched. The build-status ledger records the receipt. This proves the existing harness, not the missing real-adapter composition or live delivery.

## Target policy decision resolved; integration is in progress

At target base `9331946ef10d3b7259b5ca4933598dd380c1d794`, ai.ubq.fi `AGENTS.md` prohibited restoring request capture and incident delivery. The owner explicitly approved the narrow m06 exception at 21:07 UTC: authenticated failure capture/export, bounded upstream replay data, and exact-build receipts, while keeping scheduling and agents standalone and live activation separate. The target lane now records that exception in its instructions.

Local target commits `5df8cbd0` and `93cac701` restore the authenticated encrypted export and automatic request-capture path. At that checkpoint, thirteen focused tests passed, including actual handler capture/export and unauthorized rejection; an independent cross-repository probe proved compatibility with standalone retained decryption. CI now invokes the focused real-KV task. The later `f771c2a9` checkpoint below adds durable unresolved discovery and exact capture binding. These commits remain local on the recorded m06 lane, not reviewed, merged or deployed. Upstream recording, production retention and build receipts remain incomplete.

Release divergence was verified during integration: the official Deno CLI cannot supply the custom revision labels required by the former release port, and a synthetic probe showed `sampleHealth` accepting contradictory JSON body and header identities. Local source commit `a3eb26e` corrects both, adds bounded real Link pagination and supports the actual two-label Deno hostname. The exact transaction still needs the authenticated build-receipt resolver; that production integration remains incomplete.

Publication identity, hosted credentials, live budgets/retention/stability settings, promotion ownership transfer and a fresh acceptance-review cycle are also unresolved. These are distinct from local implementation and must be recorded explicitly before activation.

## Next acceptance surface

Complete upstream capture and safe fixture preparation. Durable target incident discovery and capture-reference binding are now accepted locally (see 23:28 checkpoint below). Assemble the real gateway adapter, retained-capture preparation, trusted safe fixture source, isolated replay runtime, GitHub/model/review transports and release receipt resolver. Exercise the complete lifecycle through those adapters with scripted external transports and real temporary Git state. Only then freeze the candidate for the authorized integrated review and subsequent live gates. Do not add more placeholder host capabilities and call that composition complete.

## Follow-up inspection at 21:56 UTC

The canonical release correction is still being written and is not an accepted candidate. Independent validation of its draft rejects the actual managed target hostname `https://ai-ubq-fi.ubiquity-dao.deno.net`: the draft hostname regex accepts only one label before `.deno.net`. The real target shape must pass configuration validation as well as the REST-client probes before acceptance. The immutable URL helper also needs consistent handling of credentials, ports and non-root URL components. The recorded probe is `release-managed-host-primary-probe-v1.ts` under `/tmp/sentinel-gfa795549e5/`.

A separate confirmed producer/consumer contradiction blocks normal incident pagination: `parseGatewayIndexPageV1` rejects a complete page with a continuation cursor, while the repair loop stops on incomplete coverage before following its cursor. Page completeness and normal continuation must be independent. The prepared correction preserves genuine missing-source coverage and requires a real adapter-to-entrypoint test with the highest-priority incident on a later page. This correction is not implemented yet.

Direct execution of both scheduled entrypoint modules still throws for missing trusted host wiring, confirmed again in this inspection. The 465-test receipt above remains evidence for its recorded older source candidate, not for the changing release draft.

## Release correction accepted locally at 22:41 UTC

Commit `a3eb26e` passed 101 fresh primary release/entrypoint/contract tests, all independent actual-host/page-two/auth-origin/contradictory-health probes, repository formatting/lint and configured type checks. Before/after source hashes matched. This closes the release defects recorded above, including the draft hostname validator error. Exact rollback and interrupted-monitor cases pass through the scripted Deno transport and real temporary Git state; an actual isolated Deno rollback drill and production delivery are still not proved.

The actual adapter-to-repair-entrypoint pagination probe remains failing: only page one is requested. The next producer integration must also bind stable incident IDs to capture references at capture completion. Today, incident-filtered export references depend on the retired coalescer; restoring unfiltered capture/export did not close that gap. No coalescer, dispatch or scheduler should be restored to provide that binding.

## Pagination correction accepted locally at 22:53 UTC

Commit `c2fa5ce` separates successful page coverage from pagination exhaustion and bounds the actual intake consumer to 128 pages with repeated-cursor detection. Fresh primary validation passed 84 focused tests with zero failures. The independent real gateway adapter → repair entrypoint → temporary Git probe passed: both incidents were persisted and the P0 incident on page two was selected before the P2 on page one, with no model or replay invocation. The earlier pagination failure is closed locally.

Both direct scheduled entrypoints still throw for absent host wiring, rechecked at this checkpoint. The target's capture completion still needs an atomic binding from a durable incident ID to its encrypted capture reference; the existing unfiltered export test cannot prove that binding. These are current integration gaps. The pagination correction has no deployment, new Codex review or production-delivery receipt.

## Durable target index and binding accepted locally at 23:28 UTC

Target m06 commit `f771c2a9022ea4bdc4b2eb9dfd578c737da6437d` adds a passive, super-admin authenticated `GET /admin/sentinel/incidents`, stable safe failure-group identity and durable minimal metadata without a TTL. Capture completion atomically binds the index and incident-filtered export reference to actual ciphertext digest, original capture expiry, exact original revision and capture timestamp. Missing keys still leave discoverable incidents; logical evidence expiry does not erase incident metadata. The source capture lifetime remains 48 hours, and finite production retention/storage choices remain open.

Primary independently ran 25 focused tests and three cross-repository probes with zero failures. The probes use the actual authenticated handler, standalone strict index parser, incident-filtered encrypted export and actual decryption; they verify the original request bytes, the frozen 1..100 query range, and historical revision/timestamp binding across a new capture followed by an older duplicate. Source/test/toolchain hashes stayed unchanged through acceptance and the commit hooks. A native read-only DSH child checked the binding while the sole parent corrected the source; both completed and all jobs settled.

This closes the earlier missing index/reference producer gap locally. These target commits are not yet reviewed, published, merged or deployed. They still capture request bytes and observations only. Real upstream byte capture before provider normalization, trusted permanent fixture generation, complete runtime wiring, final review and live delivery/rollback proof remain incomplete.

## Actual adapter divergence confirmed at 23:37 UTC

Rechecked Sentinel HEAD `00710af4cf869f4a78a07f3d417de5431597e010` and clean target m06 HEAD `f771c2a9022ea4bdc4b2eb9dfd578c737da6437d`. A credential-free, network-disabled synthetic probe exercised the actual target request handler, authenticated index route and actual standalone `GatewayIncidentAdapter.listUnresolvedIncidents(null, 1)`.

The producer emitted provenance endpoint `/v1/responses`. Strict wire parsing succeeded, but the actual adapter returned `{"ok":false,"error":{"kind":"invalid","detail":"gateway index row failed record validation"}}`. Target `normalizeSentinelIncidentEndpoint` permits recognized relative paths or `other`; standalone `parseProvenance` requires an absolute HTTP(S) URL. `gatewayRowToSummary` passes the value through unchanged. Thus normal newly captured incidents cannot enter repair selection through the actual adapter.

This narrows the 23:28 acceptance claim: wire parsing and capture binding passed, but actual adapter consumption does not. Reproducer: `/tmp/sentinel-gfa795549e5/m06-index-actual-adapter-audit-v1.ts`, derived from the existing synthetic handler probe without changing that original. Exit 0 means the probe reproduced the expected rejection; it is not a passing integration result. Previous ciphertext/export assertions also passed. No production requests, model calls or source changes occurred. This bounded probe was run directly and has no registered evidence-archive receipt.

Immediate next work: reconcile trusted endpoint provenance between producer and domain contract, then require actual handler → actual adapter success as the acceptance check. Preserve safe endpoint classification and exclude untrusted host/query data. Upstream capture remains the next larger missing capability after this defect. The full suite was not rerun for this documentation-only audit; earlier test counts retain their recorded candidate scope.

## Follow-up: artifact reference mismatch at 23:49 UTC

The DSH URL-projection draft passes 26 target tests, but independent actual adapter acceptance still rejects its records. A second incompatible wire field is now identified: target index refs are `capture:<id>`, while the domain restricted-ref parser allows `artifact`, `fixture` and `secret` schemes. The actual retained store uses `artifact://sentinel/<incidentId>/<captureId>`. The original wire-parser-only test missed both constraints.

The candidate is not accepted. A bounded target correction now maps validated internal capture refs to the exact retained artifact namespace at the wire projection only, preserving storage identities and digests. Primary acceptance has been extended through actual adapter listing, actual evidence read, actual retained store and standalone decryption, with temporary storage and synthetic data. No model/network/deployment call is part of that check.

## Actual producer-to-consumer discovery accepted locally at 23:56 UTC

Target commit `8d70e3853562cf320ccc6f3baa3cc37ae919154a` fixes both wire/domain mismatches without changing internal storage identities. Known endpoint classifications map to fixed canonical gateway URLs; unknown endpoints map to the gateway origin. Validated internal capture refs map to the exact `artifact://sentinel/<incidentId>/<captureId>` retained-store identity, preserving ciphertext digest and historical timestamp/expiry.

Independent full-consumer probe `m06-provenance-actual-adapter-v3.ts` passed: actual synthetic failure through the authenticated gateway handler → actual adapter listing → actual adapter evidence read → actual temporary LocalArtifactStore → standalone authenticated decryption → exact original request. The discovered reference exactly matches the retained artifact reference. Request-only evidence still has `replay: null`, as required. Receipt `591bceabb6cc0ae63ee09ee9914b02c17ad0b9b53f9be3f4389670cde15755a5/bde8a6fe-5533-47b3-a74f-1894826023ad` is fresh, exit0. Independent focused suite passed26 tests, zero failures, receipt `591bceabb6cc0ae63ee09ee9914b02c17ad0b9b53f9be3f4389670cde15755a5/1f619c3f-c573-4a94-befe-96c202f69824`. Source/test/toolchain hashes matched before/after fresh acceptance and after commit hooks; configured formatting/lint/build/test type checks passed.

This supersedes the two wire mismatch blockers above. These changes remain local, unreviewed, unpublished and undeployed. The next coordinated upstream producer and decryptor assignments are active against frozen contracts section12. Their in-progress drafts are not accepted code and do not yet prove replay capture, trusted sanitization or production delivery.

## Upstream consumer validation and remaining assembly (2026-09-08 00:29 UTC)

The v2 consumer draft initially accepted eof/read_error/cancelled with no response headers. Primary inspection and the target's independent native inspection both found this violation of contracts section12. A bounded DSH correction first reproduced failure through the actual full decryptor with an independently encrypted envelope, then added the minimum guard and all three negative cases. Fresh primary validation passed84gateway tests and gateway type checking, with unchanged source/test/old-golden/config hashes. Exact receipts and worker settlement are in build-status.md. Source changes are still uncommitted and await actual producer compatibility; these checks do not prove the producer or safe replay.

Reverified assembly gaps:

- Both scheduled workflows call the existing Deno tasks whose direct entrypoints throw for missing trusted host capabilities (`src/main.ts`, `src/release-main.ts`).
- `makeRepairRig` constructs FakeGithub, FakeReplay and FakeModel. Adapter-specific tests do not establish the required full real-adapter lifecycle.
- Gateway `readIncident` returns `replay: null`; decryption is not connected to trusted positive sanitization, permanent CI fixture preparation and fixture identity resolution.
- The implementation model port defaults to an unavailable receipt verifier and refuses to open a session. A production session factory and actual receipt verifier remain required.
- Runtime review transport still needs authenticated completed-clean and finding-bearing results bound to the current candidate head.
- The build receipt resolver returns unavailable for every request. The actual target build receipt producer/resolver and exclusive promotion handover remain required.

The producer worker continues recorder/provider/handler tests on its recorded m06 lane. Its two native read-only children completed, but their advisory source inspection is not runtime acceptance. The prepared actual handler → adapter → retained store → v2 decrypt probe and the real committed-producer golden have not run. No publication, deployment, activation, rollback drill or autonomous production delivery occurred.

## Upstream evidence and permanent compatibility regression accepted (2026-09-08 00:55 UTC)

Gateway commit `df256c74` passed48fresh local tests, independent dual-limit/strict-parser probes and actual cross-repository handler-to-decryptor acceptance. Its hooks passed formatting, lint, build and test type checks without changing accepted bytes. Canonical consumer `278bcbb` and permanent public producer golden/test `8ccebf2` are committed on the canonical branch. The final independent gateway suite passed85tests with unchanged hashes. Exact receipts and worker settlement are in build-status.md.

The real producer-generated fixture explicitly records its source SHA and retains the old v1 fixture unchanged as unsupported-version evidence. It proves private metadata-v2 interoperability and exact byte preservation. It does not replace the missing trusted positive sanitizer, permanent application regression, before-failure/after-pass replay or production host assembly. The gateway deployment workflow still lacks a published build receipt for the standalone resolver. No publication, deployment, ownership transfer or live delivery was performed.

## Receipt archive prerequisite accepted locally at 02:02 UTC

m05 commit `486486b` adds a bounded, dependency-free reader for the receipt ZIP produced by the pinned upload action. The golden comes from actual committed gateway receipt emission and the exact upload archiver version, using public synthetic values. Fifteen focused tests, independent contradictory-size/hidden-expansion/trailing-input probes, and an empty-cache `--cached-only` run passed. A declared-size defect in the first draft was independently reproduced and corrected despite its native child's passing review.

This commit is local to the recorded m05 lane and is not yet integrated into canonical source. It is a resolver prerequisite, not authenticated GitHub artifact retrieval, request-to-run binding, host wiring or production release proof. The concrete resolver remains unavailable on canonical. The build ledger records exact receipts, ownership and continuation instructions; all earlier live acceptance gaps remain open.

## Replay limitations lost at the actual consumer (2026-09-08 02:22 UTC)

New confirmed defect on canonical `b0776e0`: `buildReplayResult` in `src/repair/loop.ts` writes `limitations: []` regardless of the limitations reported by the original and candidate replay runs. `ensureBeforeReplay` and `candidateValidated` accept their outcomes without refusing these limitations. This can manufacture durable unrestricted causal proof from limited replay evidence and then satisfy the later expiry-bypass predicate.

Independent probe `/tmp/sentinel-gfa795549e5/replay-limitations-consumer-primary-v1.ts` supplied `fixture_redacted` before and `output_truncated` after through the scripted replay port into the actual repair entrypoint, rolling budget and temporary Git-backed state. It recorded three replay calls, a durable replay with an empty limitations list, and work at `review` with synthetic PR 7. Receipt `cc48556d9d6816f2605c36c352452867e2de5be694f7aa26c8a9330e9268c576/656592a8-816e-49ce-84e4-255076028640` failed as intended in 10.6 seconds; this is a consumer-defect reproduction, not full real-adapter acceptance or an external PR write.

The m04/canonical owner is the reuse primary, session `01a07e70-bc67-7810-b2a0-e4c3949f0281`. That owner must preserve reported limitations and prevent limited replay from becoming publication/expiry-bypass proof, with focused before-only, after-only and resumed-state checks. No competing repair writer was launched by the gateway continuation. This defect is open and must be resolved before integrated acceptance.

## Concrete receipt association accepted locally (2026-09-08 02:42 UTC)

m05 commit `ecbff3c` implements the actual GitHub receipt resolver, using the accepted archive reader. Fresh independent empty-cache testing passed 38 tests and 68 steps. Actual producer archive consumption, exact request/workflow/run/attempt/artifact bindings, unrelated-artifact coexistence, credential isolation, bounded auth/body handling and exact reader-lock cleanup also passed separate probes. Full receipts, worker settlement and hashes are in the build ledger. The earlier API-field, unbounded cancellation and retained-lock defects are closed locally.

This accepted m05 tip is ready for the existing canonical integration owner; it is not yet an ancestor of canonical at this checkpoint. The missing concrete resolver source is now implemented locally, but runtime host construction, hosted artifact retrieval, exclusive promotion ownership and actual isolated rollback remain unproved. All repair/sanitization/model/review/live-delivery gaps above remain open, including the newly reproduced lost replay limitations.

## Recorded upstream replay accepted locally (2026-09-08 03:09 UTC)

Gateway tip `f138d7269492b62ef466d91ab460d33cdbf5e7ba` adds the reusable recorded-upstream test transport and an actual authenticated handler capture → encrypted export → actual decryption → actual handler replay test. Fresh primary validation passed 17 tests. The replay reconstructs the same 500 status and error body using the decrypted original method, compatibility headers and request bytes; it consumes the exact recorded trace, preserves the encrypted capture, and makes no real upstream request. Independent terminal/chunk/order checks, formatting, lint, build and test type checks passed. This is a local, committed gateway result; it is not published, reviewed, merged or deployed.

The helper refuses unavailable traces and never invents EOF for a cancelled prefix. It preserves each recorded chunk, enforces exact provider route order, and requires every recorded attempt to complete. It performs no sanitization and issues no causal-success attestation. The standalone adapter still needs trusted capture-to-fixture preparation and a permanent application regression before it can populate replay metadata.

A separate historical application probe reproduced the intended sparse-stream failure on exact archived source `0d795e28e42be63bbd7f0d4ce44d8ea0f6ab9d4a`. Replaying that EOF trace through historical fix `7cac5b68d09efe2a053e8ac658288a15aeac9af8` failed the helper's completion check: the application Responses parser cancels on the terminal SSE event before reading transport EOF. Receipt `591bceabb6cc0ae63ee09ee9914b02c17ad0b9b53f9be3f4389670cde15755a5/03677da0-0056-4917-9372-ce653b5755c3` is a failed calibration, not accepted before/after proof. The probe and archived source are under `/tmp/sentinel-gfa795549e5/historical-sparse-v1/` and `historical-sparse-primary-v1.ts`. Future replay policy must distinguish truthful application cancellation from complete transport observation without silently weakening evidence requirements.

The 02:58 build-ledger entry supersedes the preceding resolver integration gap: accepted m05 tip `ecbff3c` is now a canonical ancestor, with combined contract/state/resolver/archive checks passing. The concrete resolver exists in canonical source. Host construction, live association, target promotion handover, trusted sanitization, the replay-limitations consumer fix and the full delivery/rollback/observation gates remain incomplete.

## Current implementation audit after Wave C composition (2026-09-08 08:42 UTC)

The canonical Sentinel lane is `/Users/nv/repos/ubiquity/sentinel/.codex-worktrees/master-plan-gfa795549e5`, branch `codex/master-plan-gfa795549e5`, at `9bba05d233589ed0f5af91d828df959cbce92429`. The accepted m01–m05 work and the Wave C composition commit `541ad66a1d9768750b1aa6b5d985002fec04add8` are ancestors. The target m06 gateway work remains on its separate local branch at `5ac19a44` and is not in this graph. Existing documentation and disposable test dirt are preserved.

The new `GatewayReplayComposition` closes the previous local composition gap. It drives the actual gateway adapter and retained store, authenticates the producer capture, applies the accepted structural sanitizer, and exposes a deterministic `FixtureResolverV1` plus `resolveTestIds` identity source. Its focused suite and the existing gateway/replay/entrypoint/evidence suites pass `155/155` on the integrated head with credential-free temporary Git and storage. The ReplayPort positive case passes the configured command but records `fixture_redacted`; the composition therefore does not manufacture unrestricted causal proof.

| Master-plan surface | Evidence at `9bba05d` | Remaining divergence |
| --- | --- | --- |
| §6 / §9.1 captured request → fixture → replay | Actual adapter → encrypted retained artifact → authenticated decrypt → sanitizer → deterministic fixture and resolver are exercised in `tests/adapters/gateway/replay_composition_test.ts`. | The composition is an injected capability only. No trusted host constructs it from the target key/policy/test identity, and no permanent target failure fixture or before-failure/after-pass result is proven. `redacted: true` remains a replay limitation. |
| §4 / §9 actual production entrypoints | `runRepairEntrypoint` and `runReleaseEntrypoint` remain type-checked and their injected lifecycle tests pass. | `src/main.ts:157-161` and `src/release-main.ts:195-199` still throw on direct execution. `.github/workflows/repair.yml` and `release.yml` invoke those inert tasks without state, adapters, composition, credentials, review/model transports or release resolver wiring. |
| §7 / §9.5 review and merge | Strict local review/merge contracts and fake-port lifecycle tests pass. | No authenticated production review transport or current-head completed-clean/finding-bearing receipt is assembled; publication identity and the prior review cycle remain unresolved. |
| §7 / §9.6 release | Deterministic release controller, Deno REST client and concrete `GithubBuildReceiptResolver` are locally tested. | `src/release-main.ts:106` defaults to `UnavailableBuildReceiptResolver`; no hosted receipt association, exclusive target promotion handover, isolated real rollback or live acceptance exists. |
| §6 / §9.7 retention | Local encrypted store, expiry checks and target-side capture binding have synthetic evidence. | Target source capture still has a 48-hour lifetime and production retention/storage values are unset; no continuous live ingestion is proven. |

The `deno task test:local` run on this head was not clean: `638` tests passed and the existing Git descendant-settlement test failed because its child PID marker disappeared before the assertion. The isolated test rerun passed, but this does not upgrade the full harness to a clean result. The Wave C focused scope independently passed `155/155`; no model, network or external write was used.

The remaining divergence is therefore host assembly and live acceptance, rather than the local capture-to-fixture mechanics: `src/adapters/gateway/incident-adapter.ts:227` still returns `replay: null` unless a host wraps it with `GatewayReplayComposition`; the repair loop receives no such wrapper from the scheduled workflow; the model port's default receipt verifier is unavailable; release defaults to an unavailable build resolver; and integration rigs still use fake GitHub/replay/model ports (`tests/integration/helpers.ts:206-218`). No trusted capture-to-`ReplayMetadataV1` causal receipt, production review receipt, published aggregate PR, deployed runtime, ownership transfer, isolated rollback drill, two autonomous deliveries or six-hour observation is proven.

Disposition: the local Wave C composition is accepted and integrated, while the plan's production host wiring and live delivery outcome remain unfulfilled. The next acceptance surface is a trusted host composition that connects this wrapper to the scheduled repair entrypoint and proves a permanent target regression through the real producer, followed by the separately gated review, publication, release and live-delivery steps.

## Independent audit recheck (2026-09-08 08:51 UTC)

The canonical lane was rechecked at `9bba05d233589ed0f5af91d828df959cbce92429` with the existing documentation edits and five disposable test directories preserved. `deno check` across every module and entrypoint plus `git diff --check` passed. The registered gateway/replay/entrypoint/evidence scope passed `155/155` in 2m59s using temporary Git and storage only; no model, network, GitHub, publication or deployment call was made. The full `deno task test:local` result remains the recorded `638` passes plus the unrelated `DenoGitExecutor` descendant-marker race, so the full harness is not clean.

Direct `deno task repair:run` and `deno task release:run` both exited 1 with their static missing-trusted-capability errors. This confirms the principal divergence is still host activation: `.github/workflows/repair.yml` and `release.yml` invoke inert entrypoints, and no authorized credential/configuration source is present to construct the trusted host. No activation interface, environment variable, secret, CLI flag, external write or speculative fallback was added.

## Current implementation audit after release host composition (2026-09-08 10:01 UTC)

The canonical lane is `/Users/nv/repos/ubiquity/sentinel/.codex-worktrees/master-plan-gfa795549e5`, branch `codex/master-plan-gfa795549e5`, at `7e34dc509df279cde7933f8d794a54a8feb4e2ca`. Commit `7e34dc5` adds the trusted release-side composition seam and its seven focused tests; the earlier repair-side host composition commit `40273d7` remains an ancestor. The worker evidence and exact changed-path handback were reconciled before the primary committed the two files. Existing documentation, dirty repair transport/model files, and disposable test directories remain preserved.

The release host seam now accepts only caller-supplied clock, release/read state capabilities, repository/environment/target/policy, Deno transport/auth, and optional exact GitHub receipt binding. It constructs the existing concrete clients only after target and policy validation, rejects repository/environment/project drift with static errors, preserves the unavailable resolver when authenticated receipt inputs are absent, and has no environment, filesystem, network, state, repair, model, revision-selection, promotion-fallback, or workflow-activation path. Current-head focused tests passed `7/7`; the integrated Wave C gateway/replay/entrypoint/evidence scope passed `155/155`; all-module formatting, lint, type checks and diff checks passed. Direct `deno task repair:run` and `deno task release:run` each exited `1` with the expected static missing-trusted-capability error.

| Master-plan surface | Evidence at `7e34dc5` | Remaining divergence |
| --- | --- | --- |
| §6 / §9.1 captured request → fixture → replay | Gateway adapter, retained store, sanitizer and `GatewayReplayComposition` still pass through the actual Wave C scope. | The composition remains an injected capability; no trusted production host constructs it from target credentials/configuration, and no permanent target application regression with before-failure/after-pass causal proof is established. `fixture_redacted` remains a truthful limitation. |
| §4 / §9 actual production entrypoints | Repair and release entrypoint lifecycle tests pass; both host factories are locally composable. | `src/main.ts` and `src/release-main.ts` still fail closed when run directly. `.github/workflows/repair.yml` and `release.yml` still invoke those inert tasks without state stores, adapters, host configuration, credentials, model/review transport, or release resolver wiring. |
| §7 / §9.5 review and merge | Strict local review/merge contracts and fake-port lifecycle tests pass. | No authenticated current-head completed-clean review receipt, aggregate publication, or accepted target PR exists. |
| §7 / §9.6 release | Deno REST client, deterministic release controller, concrete resolver, and release host factory pass local checks; missing receipt defaults to wait/block without promotion. | The target build receipt is not hosted and associated with a trusted release request on the canonical graph; no exclusive target promotion handover, isolated real rollback, deployed runtime, or live acceptance is proven. |
| §6 / §9.7 retention | Local encrypted retention and expiry behavior pass the Wave C scope. | Target capture retention/storage choices remain unset; the target producer branch is separate and no continuous live ingestion is proven. |

The full `deno task test:local` result is still the earlier exact-candidate record of `638` passes plus the known `DenoGitExecutor` descendant-marker race; it was not repeated for this narrow host seam. Local evidence therefore supports module and Wave C composition acceptance only. No model request, GitHub write, publication, deployment, target ownership transfer, rollback drill, autonomous delivery, or six-hour observation was performed.

Disposition: release-side local composition is now integrated, while the requested autonomous delivery outcome remains incomplete. The next acceptance surface is a single trusted host wiring pass for the scheduled repair and release workflows, with real producer/replay/model/review capabilities and explicit activation boundaries, followed by exact-head review, publication, target handover, isolated rollback and live delivery evidence.

## Host runner recheck (2026-09-08 10:34 UTC)

`bfbe04597b06c23e29c63ba230d4786236648f55` adds the explicit `src/host/run.ts` seam that composes the existing repair/release factories and calls the real injected entrypoints. Its four focused tests prove the repair idle and source-error paths, the unavailable release resolver with no promotion, and observable clock/state/transport pass-through. The fresh exact-head host-wiring receipt `cc48556d9d6816f2605c36c352452867e2de5be694f7aa26c8a9330e9268c576/4dd212d3-b69e-44a8-939f-3e6d97589f94` passed `24/24` with no external calls; formatting, lint, type and diff checks also passed.

This closes the local composition-to-entrypoint seam but does not activate production. The workflows still invoke the direct fail-closed tasks without state, gateway/GitHub/model/review capabilities, credentials or a hosted build resolver. No trusted causal replay receipt, authenticated clean review, publication, deployment, target ownership transfer, isolated rollback or live delivery proof exists. The DSH worker's evidence archive attempt was blocked by its sandbox; the primary receipt above is the independent acceptance evidence. Existing unrelated dirty files remain preserved.


## Independent model/candidate boundary audit (2026-09-08 11:14 UTC)

At canonical `5a2284309e6bc735ae45d130c39c19cc4cf6b61c`, the repair host/model seam is locally accepted. The focused model/transport/host scope passed `31/31`, the independent loop suite passed `18/18`, and formatting, lint, type and diff checks passed. The candidate commit adds a trusted local committer and rejects base-head or empty-change candidates; the model transport opens lazily, fails closed after close, and binds the requested Luna/max effort in the generated app-server thread and turn request. The default missing provider receipt still prevents session opening.

| Master-plan surface | Evidence at `5a22843` | Remaining divergence |
| --- | --- | --- |
| §5 / §9 model admission and candidate identity | Local committer, descendant/changed-path gates, lazy-open regression, and receipt-verifier tests pass without model or network calls. | No production receipt verifier or credential-backed model host is wired; live model admission remains unavailable by design. |
| §4 / §9 actual entrypoints | Host factories and runner still compose the real repair/release entrypoint APIs. | `.github/workflows/repair.yml` and `release.yml` still call fail-closed direct tasks without durable state, adapters, transports, or release receipt resolution. |
| §6 / §9.1 causal replay | Gateway replay composition remains available as an injected local capability. | No trusted production host constructs it and no permanent target before-failure/after-pass causal receipt exists; `fixture_redacted` remains a truthful limitation. |
| §7 / §9.5–9.7 delivery | Local review/merge/release state machines remain deterministic and independently tested. | No authenticated current-head review, aggregate PR, target handover, hosted build receipt, deployment, isolated rollback, two autonomous deliveries, or six-hour observation is proven. |

The DSH evidence archive was denied by the workspace sandbox and therefore has no host-local receipt; direct primary execution is the fresh acceptance source. The optional read-only child was settled under task-owned authority after a corrupt registry prevented normal observation; no child edits or external effects were found. Existing dirty ledger work and disposable test directories remain preserved.


## Full-harness scheduling result (2026-09-08 11:47 UTC)

The integrated harness on `5a22843` passed 659 tests but exposed one timing-sensitive failure in `loop-guard-runtime_test.ts`; a fresh isolated run and captured evidence reference `cc48556d9d6816f2605c36c352452867e2de5be694f7aa26c8a9330e9268c576/c1aab352-4e29-4c5c-9948-74179376308e` pass 1/1. This is recorded as unresolved test determinism, not a production boundary fix. A DSH test-only worker made no edit before task-owned cancellation and was rejected; no source or child changes remain.

## Current implementation audit after host seams and clean full harness (2026-09-08 13:07 UTC)

The canonical lane is `/Users/nv/repos/ubiquity/sentinel/.codex-worktrees/master-plan-gfa795549e5`, branch `codex/master-plan-gfa795549e5`, at `0c98854e42f1ad2f2fc48ccd4f93a59ccb3f4a68`. The accepted loop-guard synchronization (`7024818`), explicit GitHub host factory (`d3ef9b3`) and host-seam typecheck coverage (`0c98854`) are now integrated. The target m06 lane remains separate and is not an ancestor of this repository.

The exact registered `wave-c-full-local` capture `cc48556d9d6816f2605c36c352452867e2de5be694f7aa26c8a9330e9268c576/e7115f78-8ad9-4286-8c21-af96d5a11dc3` ran `deno task test:local` at this head. It completed with child exit `0`, outcome `success`, `reuse: executed`, `666` passing tests across `68` steps, `0` failures, and `998260ms` duration. The harness also checked formatting, lint and all listed module/host entrypoints. Two store symlink-defense cases reported their existing permission-limited post-test message (`Deno.symlink needs unscoped read/write grants`) while remaining passing; this is recorded as a test-environment limitation, not as proof of those OS-level branches.

| Master-plan surface | Evidence at `0c98854` | Remaining divergence |
| --- | --- | --- |
| §4 / §9 actual scheduled entrypoints | `src/host/run.ts` composes the real repair/release entrypoint APIs; host and entrypoint tests pass, and `deno.json`/`test-local.ts` typecheck the host seams. | `.github/workflows/repair.yml` and `release.yml` still call direct `deno task repair:run` / `release:run`. Those entrypoints intentionally throw without trusted capabilities, so no workflow constructs state stores, gateway/GitHub adapters, replay composition, model/review transports, credentials or the release resolver. |
| §5 / §9.4 model admission | The model transport and candidate boundary are locally tested, with pinned effort and fail-closed missing receipts. | No credential-backed production session factory or provider receipt verifier is wired; live inference remains unavailable. |
| §6 / §9.1 capture → fixture → replay | Gateway capture/decrypt/sanitize/replay composition and deterministic fixture resolution pass the focused suites. | The wrapper remains an injected capability, its fixture carries `fixture_redacted`, and no permanent target before-failure/after-pass causal receipt is proven. `incident-adapter.ts` still returns `replay: null` unless a trusted host supplies the wrapper. |
| §7 / §9.5 review and merge | Exact-head review/merge state machines and fake-transport lifecycle tests pass. | No authenticated current-head completed-clean or finding-bearing review receipt, aggregate publication, or accepted target PR exists. |
| §7 / §9.6 release | The deterministic release controller, Deno REST client, build-receipt resolver and explicit release host factory pass local checks. | No hosted receipt association, exclusive target promotion handover, deployed runtime, isolated real rollback or live acceptance exists; the workflow still reaches the unavailable resolver through the direct task. |
| §1 delivery outcome | The local harness and focused suites are green at the integrated source head. | No two distinct new autonomous deliveries, continued eligible selection or six-hour observation has been recorded. |

The `wave-c-composed-lifecycle` worker was stopped after roughly eight minutes of pre-edit work with no mutation. Its exact process group and descendants settled, its owned test file stayed unchanged, and the disposition is `rejected:no useful progress before first edit`. The loop-guard and GitHub-host workers were accepted only after independent primary validation and the receipts recorded in the build ledger.

Disposition: local host seams and the complete credential-free test harness are now verified, but the production plan is still incomplete at trusted workflow wiring and live acceptance. The next acceptance surface remains one real host composition that supplies authorized runtime capabilities, followed by the plan's exact-head review, publication, target handover, isolated rollback, two deliveries and observation gates.
