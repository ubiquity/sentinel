# Sentinel implementation divergence audit

Audit date: 2026-09-07. Initial source baseline: `5ed87855c4bd911b2bd395e2ce7a9c09e7c326de`. Latest accepted local source: `c2fa5ce` at 22:53 UTC, canonical branch `codex/master-plan-gfa795549e5`. This is an implementation audit, not a replacement plan or production acceptance receipt. `docs/build-status.md` remains the single progress ledger. Dated follow-ups below preserve the investigation history; later acceptance entries supersede earlier defect status.

## Governing documents

- [MASTER-PLAN.md](../MASTER-PLAN.md) defines the outcome, architecture, ownership and acceptance requirements.
- [lifecycle.txt](lifecycle.txt) is the readable runtime sequence.
- [design-rationale.md](design-rationale.md) explains the design choices and is subordinate to the master plan.

The plan's opening status and planned-lane labels describe its planning snapshot. They do not describe current implementation progress. The code is in the recorded canonical worktree; the root `development` checkout remains planning-only.

## Finding

Current correction (23:37 UTC): actual gateway discovery is blocked by a producer/consumer provenance mismatch. The 23:28 index acceptance proves wire parsing and capture binding, not successful consumption by `GatewayIncidentAdapter`. See the final checkpoint below.

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
