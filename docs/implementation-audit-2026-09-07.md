# Sentinel implementation divergence audit

Audit date: 2026-09-07. Initial source baseline: `5ed87855c4bd911b2bd395e2ce7a9c09e7c326de`. Latest accepted local source: `a3eb26e494a31cb1c754971466db14b06ec05df1` at 22:41 UTC, canonical branch `codex/master-plan-gfa795549e5`. This is an implementation audit, not a replacement plan or production acceptance receipt. `docs/build-status.md` remains the single progress ledger.

## Governing documents

- [MASTER-PLAN.md](../MASTER-PLAN.md) defines the outcome, architecture, ownership and acceptance requirements.
- [lifecycle.txt](lifecycle.txt) is the readable runtime sequence.
- [design-rationale.md](design-rationale.md) explains the design choices and is subordinate to the master plan.

The plan's opening status and planned-lane labels describe its planning snapshot. They do not describe current implementation progress. The code is in the recorded canonical worktree; the root `development` checkout remains planning-only.

## Finding

The code follows the proposed polling architecture at module level, but the complete production path is not assembled. The main divergence is between tested component behavior and the required autonomous delivery outcome. Both scheduled commands still reach direct entrypoints that throw for missing host wiring. Passing the local harness cannot establish a working standalone deployment.

## Requirement and evidence matrix

| Master-plan requirement | Current evidence | Divergence or missing proof |
| --- | --- | --- |
| One repair writer and a separate deterministic release writer (§4) | Separate repair/release modules and non-cancelling workflow concurrency groups. | No deployed host or ownership transfer. Source configuration is not proof of exclusive live writers. |
| Actual production entrypoints with real adapters and fake external transports (§9.1) | `runRepairEntrypoint` and `runReleaseEntrypoint` exist. Gateway adapter/store and release REST client have real composition tests. | `src/main.ts:146` and `src/release-main.ts:195` deliberately throw on direct execution. `makeRepairRig` still uses FakeGithub, FakeReplay and FakeModel (`tests/integration/helpers.ts:206`). This is not the required complete real-adapter composition. |
| Capture, preserve and replay an offending request (§6, §9.1) | Real gateway artifact retention and incident/repository identity lookup; actual producer-compatible decryption of a synthetic capture through LocalArtifactStore. | Gateway adapter emits `replay: null` (`incident-adapter.ts:227`). No composed positive sanitizer, permanent regression generator, fixture resolver or capture-to-fixture binding. Decryption produces private plaintext, not a safe fixture. |
| Recorded upstream replay without paid reproduction (§6) | Current target capture schema stores request bytes and failure/client observations. | It does not store upstream response bytes. The frozen contract rejects a fixture digest when `upstreamCaptured` is false (`src/contracts/incident.ts:403`). Setting that flag from observation-only capture would fabricate evidence. Target producer work or an explicit contract decision is required. |
| Work on a second task while the first review waits (§9.2) | Deterministic loop tests exercise pending-review selection with one implementation action at a time. | Useful overlap through the assembled real runtime and two new production deliveries remains unproved. |
| Crash recovery and real state conflicts (§9.3) | Git-backed state/CAS tests and scripted ambiguous publication/release tests exist. | Full actual-adapter lifecycle interruption proof and an isolated real release/rollback drill remain unproved. |
| Durable rolling-hour/seven-day limits and bounded sessions (§5, §9.4) | Durable budget tests, 90-minute model-start cutoff, 120-minute repair ceiling, late-admission settlement/resume tests. | Live limits/session settings remain unset. Actual runtime provider receipt verifier and session host are not supplied. Default-unverifiable sessions now stop before opening. |
| Verified current-head review, CI and protected writes (§7, §9.5) | Strict review/merge normalization and negative-path tests; bounded app-server transport. | No production ReviewServiceTransport is assembled. Actual completed-clean/finding-bearing reviewer receipts need verified service integration. The prior development review cycle is exhausted; current bytes are not accepted by a new review. |
| Exact candidate/prior revision, monitoring and rollback (§7, §9.6) | Deno release REST client and controller are tested against scripted transport, including identity and telemetry failures. | Build receipt resolver defaults to unavailable. Target workflow still promotes, so exclusive ownership is not transferred. No actual isolated rollback or new live delivery proof. |
| Evidence retention past the source's 48-hour expiry (§6, §9.7) | Local ciphertext store has bounded retention; expiry behavior is tested. | Target unresolved discovery/export/retention integration is incomplete. Finite production retention/storage values are owner decisions. |
| Two new autonomous deliveries, continued selection and six-hour observation (§1, §9) | No receipt set proving this outcome. | Not achieved. Existing prototype issues, health checks, synthetic fixtures and local test totals cannot substitute. |

## Confirmed defects corrected during this audit

- `2cba969`: all evidence consumers match explicit incident ID and full repository identity. Fresh foreign records and global evidence-ID collisions fail before persistence/use. Real adapter/store tests now reach the truthful missing-fixture blocker without repeated fetches or unchanged writes.
- `2ddf0b9`: retained ciphertext can be authenticated and decrypted using the existing producer protocol. The compatibility fixture was generated with actual producer functions using public synthetic data. A separately reproduced oversized-stream cleanup defect was corrected before acceptance.
- `c0e066c`: missing receipt verification prevents session opening; early notifications are retained in a bounded ordered buffer; fatal transport failure discards queued completion and remains persistent. A real subprocess regression covers terminal/response/overflow ordering.

Focused independent checks passed for these changes. The integrated `test:local` run on the exact source candidate passed 465 tests with zero failures in 8 minutes 21 seconds; formatting, lint and types passed, and before/after source hashes matched. The build-status ledger records the receipt. This proves the existing harness, not the missing real-adapter composition or live delivery.

## Target policy decision resolved; integration is in progress

At target base `9331946ef10d3b7259b5ca4933598dd380c1d794`, ai.ubq.fi `AGENTS.md` prohibited restoring request capture and incident delivery. The owner explicitly approved the narrow m06 exception at 21:07 UTC: authenticated failure capture/export, bounded upstream replay data, and exact-build receipts, while keeping scheduling and agents standalone and live activation separate. The target lane now records that exception in its instructions.

Local target commits `5df8cbd0` and `93cac701` restore the authenticated encrypted export and automatic request-capture path. Thirteen focused tests pass, including actual handler capture/export and unauthorized rejection; an independent cross-repository probe proves compatibility with standalone retained decryption. CI now invokes the focused real-KV task. These commits remain local on the recorded m06 lane, not reviewed, merged or deployed. Upstream recording, unresolved discovery, retention and build receipts remain incomplete.

Release divergence was verified during integration: the official Deno CLI cannot supply the custom revision labels required by the former release port, and a synthetic probe showed `sampleHealth` accepting contradictory JSON body and header identities. Local source commit `a3eb26e` corrects both, adds bounded real Link pagination and supports the actual two-label Deno hostname. The exact transaction still needs the authenticated build-receipt resolver; that production integration remains incomplete.

Publication identity, hosted credentials, live budgets/retention/stability settings, promotion ownership transfer and a fresh acceptance-review cycle are also unresolved. These are distinct from local implementation and must be recorded explicitly before activation.

## Next acceptance surface

Correct incident pagination and complete target evidence capture, then assemble the real gateway adapter, retained-capture preparation, trusted safe fixture source, isolated replay runtime, GitHub/model/review transports and release receipt resolver. Exercise the complete lifecycle through those adapters with scripted external transports and real temporary Git state. Only then freeze the candidate for the authorized integrated review and subsequent live gates. Do not add more placeholder host capabilities and call that composition complete.

## Follow-up inspection at 21:56 UTC

The canonical release correction is still being written and is not an accepted candidate. Independent validation of its draft rejects the actual managed target hostname `https://ai-ubq-fi.ubiquity-dao.deno.net`: the draft hostname regex accepts only one label before `.deno.net`. The real target shape must pass configuration validation as well as the REST-client probes before acceptance. The immutable URL helper also needs consistent handling of credentials, ports and non-root URL components. The recorded probe is `release-managed-host-primary-probe-v1.ts` under `/tmp/sentinel-gfa795549e5/`.

A separate confirmed producer/consumer contradiction blocks normal incident pagination: `parseGatewayIndexPageV1` rejects a complete page with a continuation cursor, while the repair loop stops on incomplete coverage before following its cursor. Page completeness and normal continuation must be independent. The prepared correction preserves genuine missing-source coverage and requires a real adapter-to-entrypoint test with the highest-priority incident on a later page. This correction is not implemented yet.

Direct execution of both scheduled entrypoint modules still throws for missing trusted host wiring, confirmed again in this inspection. The 465-test receipt above remains evidence for its recorded older source candidate, not for the changing release draft.

## Release correction accepted locally at 22:41 UTC

Commit `a3eb26e` passed 101 fresh primary release/entrypoint/contract tests, all independent actual-host/page-two/auth-origin/contradictory-health probes, repository formatting/lint and configured type checks. Before/after source hashes matched. This closes the release defects recorded above, including the draft hostname validator error. Exact rollback and interrupted-monitor cases pass through the scripted Deno transport and real temporary Git state; an actual isolated Deno rollback drill and production delivery are still not proved.

The actual adapter-to-repair-entrypoint pagination probe remains failing: only page one is requested. The next producer integration must also bind stable incident IDs to capture references at capture completion. Today, incident-filtered export references depend on the retired coalescer; restoring unfiltered capture/export did not close that gap. No coalescer, dispatch or scheduler should be restored to provide that binding.
