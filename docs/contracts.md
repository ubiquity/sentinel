# Sentinel v1 shared contracts

Foundation-owned record types, fail-closed runtime parsers, deterministic
canonical serialization, distinct identity brands and typed operational ports.
This document is the contract semantics reference for all consumers (m01-m06,
state and budget implementations). The files in `src/contracts/` are frozen
after review; consumers never invent their own status or digest variants.

All records are JSON-safe values. There are no secret literal fields anywhere in
these records; credential-bearing inputs are injected by the trusted host
outside the record surface, and raw evidence payloads live only in restricted
encrypted storage behind artifact refs. A schema alone never proves actual
GitHub/Deno behavior — the authenticated transports in later modules are the
only evidence of external behavior; these contracts define the shapes and the
fail-closed rules they must satisfy.

## 1. Design invariants

Every parser in `src/contracts/` enforces all of the following; a violation is a
typed `RecordParseError` (`code`, `path`, `message`) or, through
`tryParse(parser, input)`, a `{ ok: false, issues }` result.

- **Fail closed.** Unknown keys are rejected at every nesting level. Missing
  keys are rejected. Nothing is ignored, defaulted or trimmed.
- **Correct version.** Every record has `version: "v1"`; any other version is
  rejected (`invalid_version`).
- **Explicit kind.** Every record has a `kind` discriminant matching its parser
  (e.g. `"work"` for `parseWorkRecordV1`), so records are distinguishable in
  JSON state files.
- **Full identity.** Git SHAs are exactly 40 lowercase hex characters; all
  digests are exactly 64 lowercase hex characters (SHA-256).
- **Finite nonnegative timestamps and counts.** Timestamps are nonnegative safe
  integers (millisecond epoch); counts/ranges are nonnegative safe integers;
  rates are finite numbers in [0,1].
- **Bounded text.** Every string field has an explicit length cap; arrays have
  explicit item caps (`MaxText`, `MaxItems` in `validation.ts`); sparse arrays
  (holes) are rejected at parse time.
- **Explicit enums.** Every enum is a closed literal union; case folding,
  numbers and coercion are rejected.
- **No coercion.** A number is accepted only where a number is expected, a
  boolean only where a boolean is expected; numeric strings are rejected.
- **Explicit nulls.** Nullable fields are declared `T | null` and must be
  present (as `null`) or a value; `undefined` is never a valid JSON value and is
  treated as a missing key by `expectExactKeys`.
- **No input echo.** Parse error messages report `path`, `code`, `type` and
  length only — never the invalid input value, which may be an arbitrary secret
  (`expectSha256Hex`, `describeValue` and all `fail` messages follow this).
- **Restricted refs only.** Every storage/credential reference field validates
  against the restricted-ref shape: an opaque storage record name, never a
  network URL, absolute filesystem path or traversal. Refs follow
  `^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,511}$` with structural rules: only the opaque
  storage schemes `artifact`, `fixture` and `secret` may use the `scheme://`
  authority form (any other scheme — including `http`/`https`/ `file`/`git` — is
  rejected, and the authority may not carry a port); `scheme:/` absolute
  filesystem forms are rejected; `.`/`..` path segments (including after an
  opaque scheme delimiter) are rejected; URL query/fragment/userinfo characters
  (`?`, `#`, `@`) are outside the charset. A signed credential URL can never be
  persisted into public Git state, and actual URL endpoints belong in configured
  adapter URLs, never in secret/artifact refs.

## 2. Identity brands and digest separation

`src/contracts/brands.ts` defines nominally-distinct brands:

| Brand                     | Shape                    | Meaning                                                                |
| ------------------------- | ------------------------ | ---------------------------------------------------------------------- |
| `GitSha`                  | 40 hex                   | exact Git commit SHA-1                                                 |
| `SourceSnapshotDigest`    | 64 hex                   | SHA-256 of a captured source tree snapshot                             |
| `FixtureDigest`           | 64 hex                   | SHA-256 of sanitized fixture material (request, upstream, test output) |
| `EncryptedArtifactDigest` | 64 hex                   | SHA-256 of an encrypted restricted artifact (raw evidence payload)     |
| `IncidentFingerprint`     | 64 hex                   | stable incident dedupe identity                                        |
| `FindingFingerprint`      | 64 hex                   | SHA-256 of the canonical form of one review finding                    |
| `CommandId`               | `^[a-z][a-z0-9_]{0,63}$` | trusted credential-free configured command identity                    |
| `WorkItemId`              | bounded id chars         | deterministic work item identity (task/branch/PR source)               |

A 40-hex value can never be a digest and a 64-hex value can never be a Git SHA,
so cross-brand confusion is rejected at parse time; the TypeScript brands
additionally make the brands non-assignable in code. The four 64-hex brands
share a shape but occupy differently-named fields in every record
(`sourceSnapshotDigest`, `fixture.digest`, artifact `digest`, fingerprints), and
`EvidenceRefV1` is a discriminated union whose digest brand is fixed by branch
kind — an artifact digest can never be placed in a fixture slot.
`canonicalStringifySha256` returns an unbranded hex string; callers apply the
exact brand with the `as*Digest` helpers.

`DeploymentIdentityV1 { gitSha, revisionId }` is the typed pair of the exact Git
SHA and the platform's own revision id (e.g. the Deno deployment id) — two
distinct values that are always kept together and never selected by time or list
order. `gitSha` and `revisionId` are one identity, not alternatives.

## 3. Canonical serialization

`canonicalStringify(value)` (and `canonicalStringifySha256(value)`):

- Object keys are sorted by UTF-16 code-unit order, recursively; array order is
  preserved.
- Values must be JSON-safe: null, boolean, finite number, string, array or plain
  object. `undefined`, functions, symbols, bigint, `NaN`, `Infinity`, class
  instances, sparse arrays and non-plain objects are rejected instead of
  silently dropped (`CanonicalizationError`).
- Cycles fail with `CanonicalizationError` (never a stack overflow); shared but
  acyclic references serialize normally.
- Own symbol keys, non-enumerable own keys and accessor (getter/setter)
  properties are rejected: they would otherwise be silently dropped from the
  hash or read with side effects. Arrays additionally reject own non-index
  properties.
- `-0` normalizes to `0`; strings use JSON escaping.

Consequences for consumers: a record parsed from JSON and re-serialized
canonically is byte-identical to the canonical form of the original JSON
(verified by the fixture round-trip tests), and digests of canonical forms are
stable across key orders.

## 4. Records

All records have `version: "v1"` and a `kind`; fields below are complete.

### RepositoryConfigV1 (`kind: "repository_config"`)

Per-repository configuration; the only credential surface is a restricted
reference — no secret literal is allowed in any field.

| Field                   | Type                                             | Semantics                                                                                                                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repository`            | `{ owner, name, installationId }`                | GitHub identity + App installation reference                                                                                                                                                                                                                                                        |
| `baseBranch`            | string                                           | primary source branch                                                                                                                                                                                                                                                                               |
| `adapter`               | `{ kind: "gateway", baseUrl }`                   | exact adapter kind — only `"gateway"` in v1                                                                                                                                                                                                                                                         |
| `commands.replay/.test` | `CommandId`                                      | trusted command IDs only; the config never carries shell argv (model-supplied commands are outside the contract). Registry lookup is **own-property only**: a configured id like `constructor` against an empty registry is rejected instead of resolving to an inherited `Object.prototype` member |
| `commandRegistry`       | `CommandRegistryV1`                              | required concrete registry (file/injected config — never env/flag); references the same IDs and is checked to contain them                                                                                                                                                                          |
| `protectedPaths`        | string[]                                         | path prefixes that must never be modified                                                                                                                                                                                                                                                           |
| `build.projectId`       | string \| null                                   | Deno Deploy project id; null = not deployed                                                                                                                                                                                                                                                         |
| `build.acceptance`      | object \| null                                   | `healthPath`, `metricsPath`, `managedBodyMarker`, `managedHeaders` (non-secret identity markers), `domain`                                                                                                                                                                                          |
| `secretRef`             | string \| null                                   | restricted storage reference to host-injected credentials; must be a ref, never a literal URL/query/userinfo                                                                                                                                                                                        |
| `liveStartLimits`       | `{ perHour, perSevenDays }` \| null              | rolling model-start caps; **null = inference not enabled**; `perHour <= perSevenDays` enforced                                                                                                                                                                                                      |
| `sessionBound`          | `{ maxDurationMs, maxOutputChars }` \| null      | declared supported session bounds                                                                                                                                                                                                                                                                   |
| `retention`             | `{ evidenceMaxAgeMs, evidenceMaxBytes }` \| null | owner-approved evidence retention bound                                                                                                                                                                                                                                                             |
| `stabilityPolicy`       | object \| null                                   | declared metrics/denominators, `windowMs`/`sampleIntervalMs`, `minSamples`, `minRequests`, baseline window/samples, owner thresholds; empty threshold list rejected; `sampleIntervalMs <= windowMs` enforced                                                                                        |

`CommandRegistryV1 { version, commands }` binds each `CommandId` to
`CommandSpecV1 { executable, args, maxDurationMs, maxOutputBytes }`:
`executable` is a name/path without whitespace or shell metacharacters, `args`
is an exact argv array (never shell text) with control characters rejected, and
runtime/output are bounded. No model-supplied text can enter the registry.

`StabilityThresholdV1 { metric, maxRate, maxIncrease }` adds the
owner-configured comparison threshold alongside the absolute maximum: acceptance
fails when the observed rate exceeds `baselineRate + maxIncrease` or `maxRate`.
A `null` `stabilityPolicy` disables live release entirely. The production
gateway consumer requires a 30-minute window with 30-second samples before any
acceptance is claimed (a checked module rule, not a config value).

**Global budget policy.** `resolveGlobalLiveStartLimits(configs)` returns
`{ status: "disabled" }`, `{ status: "enabled", limits }`, or
`{ status: "conflict", repositories }`. Caps are one owner configuration across
all repositories; conflicting per-repository limits refuse inference and
per-repo independent caps are never used. This helper is **cap agreement only,
never admission**: it only derives the one agreed global policy from the
complete config set; a model start is granted exclusively by
`RollingStartBudget.reserveModelStart` returning `admitted` (§10).

### WorkRecordV1 (`kind: "work"`)

Durable per-work-item progress record on `sentinel-state/repair`.

| Field                             | Type                                                              | Semantics                                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `repository`                      | `RepositoryIdentityV1`                                            | repository this work item belongs to; stable identity includes it for deterministic IDs                                              |
| `id`                              | `WorkItemId`                                                      | deterministic identity (never regenerated)                                                                                           |
| `source`                          | `{ kind, id, revision }`                                          | immutable source identity; `kind` is `"issue" \| "incident" \| "review_backlog"`, `revision` is the bounded captured source revision |
| `related`                         | `{ incidentId, issueNumber }`                                     | cross references; issue tasks require `issueNumber`, incident tasks require `fingerprint`                                            |
| `fingerprint`                     | `IncidentFingerprint \| null`                                     | incident dedupe identity                                                                                                             |
| `failingRevision`                 | `GitSha \| null`                                                  | original failing revision; immutable, never rewritten to match a resumed run                                                         |
| `sourceSnapshotDigest`            | `SourceSnapshotDigest \| null`                                    | captured source snapshot provenance                                                                                                  |
| `classification`                  | `{ severity, priority }`                                          | priority null = missing (sorted last)                                                                                                |
| `urgency`                         | `{ activeProduction, reproducible5xx, severeSecurityOrDataLoss }` | explicit selection urgency; no module-owned side map required                                                                        |
| `dependencies`                    | `WorkItemId[]`                                                    | bounded exact ids of work items that must complete first                                                                             |
| `controller.sha`                  | `GitSha`                                                          | Sentinel controller commit owning this record; immutable                                                                             |
| `target`                          | `{ base, branch, checkpoint, head, pr }`                          | base must be revalidated before actions; `pr != null` requires `head`                                                                |
| `nextStep`                        | `"work"\|"review"\|"delivery"\|"blocked"\|"done"`                 | the single lifecycle field                                                                                                           |
| `wait`                            | `{ reason, since, until } \| null`                                | waiting reason on a next step — not a second lifecycle                                                                               |
| `blocker`                         | `{ kind, message, since } \| null`                                | present iff `nextStep === "blocked"`                                                                                                 |
| `counters`                        | `{ attempts, retries, reviewRounds }`                             | `retries <= attempts` enforced; **observation is not an attempt**                                                                    |
| `evidence`                        | `EvidenceRefV1[]`                                                 | bounded refs, never payloads                                                                                                         |
| `intent`                          | typed incomplete operation identity \| null                       | see below                                                                                                                            |
| `firstSeenAt/createdAt/updatedAt` | timestamps                                                        | `createdAt <= updatedAt`; `firstSeenAt <= updatedAt`                                                                                 |

Lifecycle rules enforced: `nextStep === "done"` forbids open `intent` and
`wait`; `nextStep === "blocked"` requires `blocker`.

`intent` carries the typed exact identity of an incomplete external operation
(`IncompleteOperationV1`):
`{ kind, key, startedAt, branch, expectedHead, observedBase, pr, requestId,
resultId }`.
There is no free-text detail and no model-supplied arbitrary JSON:
`expectedHead` is the exact head expected/pushed, `observedBase` the base
observed before starting, `branch` the deterministic branch, `pr`/`requestId`/
`resultId` stay `null` until the object exists. Per-kind rules: push and
`pull_request` require `expectedHead` plus `branch` (push forbids `pr` and
external ids); `review_request` and `merge` require `pr` and `expectedHead`;
`review_request` requires `branch`. The model-produced candidate checkpoint and
original provenance stay immutable on resume.

### IncidentSummaryV1 (`kind: "incident_summary"`) and IncidentEvidenceV1 (`kind: "incident_evidence"`)

Summary records come from pending-unresolved discovery; evidence records
describe restricted encrypted artifacts and replay metadata. Raw evidence
payloads never appear in either; only bounded sanitized context plus artifact
refs with digest/size/expiry.

- `repository`: the repository the incident/evidence belongs to (identity, not
  just endpoint URL).
- `coverage`: `{ status: "complete" }` (pagination exhausted) or
  `{ status: "incomplete", reason, nextCursor }`; complete records carry no
  `nextCursor` (unknown key otherwise). A failed source read is a port error,
  **never** an empty successful result.
- `IncidentArtifactRefV1`: `{ ref, digest, sizeBytes, expiresAt, contentType }`;
  `expiresAt >= capturedAt` enforced; `ref` is a restricted reference (no
  URL/query/userinfo), so a signed credential URL never reaches Git state.
  Duplicate artifact refs inside one evidence record are rejected at parse time
  on every path — direct parse, initial snapshot creation, existing-state
  transitions and raw remote reads (refs are exact storage pointers, never
  multiply-claimable).
- `ReplayMetadataV1`:
  `{ fixtureRef, fixtureDigest, upstreamCaptured,
  commandId, reproducedAt }`;
  captured upstream requires a fixture digest and vice versa; `reproducedAt`
  requires a fixture; `fixtureRef` is also a restricted reference.

### ReviewReceiptV1 (`kind: "review_receipt"`)

One normalized review observation; completion is never inferred from silence or
reactions, and the receipt is derived by m01 from authenticated original
evidence (never from unverified transport lists or agent-set flags).

- Binds `expectedReviewer` and `observedReviewer` — the identity actually seen
  (e.g. `chatgpt-codex-connector[bot]`; the `[bot]` suffix is accepted for
  GitHub bot identities). A `"completed"` review requires the observed reviewer
  to exactly match the expected reviewer; non-completed reviews carry
  `observedReviewer: null`.
- Also binds `pullRequest { number, head, base }` (exact head), `requestId`,
  `resultId`, `submittedAt`, `completedAt`, `observedAt`.
- `outcome`: `"completed" | "pending" | "unavailable"`. `"completed"` requires a
  non-null `resultId` and `completedAt` with `completedAt >= submittedAt` and
  `observedAt >= completedAt`. `"pending"`/`"unavailable"` forbid `completedAt`;
  `"unavailable"` forbids `resultId`.
- `findings` are full and untouched
  (`{ id, severity, path, message, fingerprint, resolved,
  resolutionEvidence }`);
  `unresolvedSeverities` is validated to equal the distinct unresolved
  severities derived from findings. `resolved: true` requires authorizing
  `resolutionEvidence { authorizingIdentity, reference }` (trusted human dispute
  or changed reviewed head); an agent-set flag alone never removes a P0/P1.
  `findingsUncounted` records how many findings could not be retained (the
  256-finding cap) — a receipt with `findingsUncounted > 0` and an empty
  `unresolvedSeverities` is rejected, so truncation can never claim clean review
  evidence.
- A completed receipt is the required evidence input to an exact-head merge
  request (see §5, merge authorization), and the merge parser additionally
  requires zero uncounted findings and no unresolved P0/P1. The receipt is
  identity/cleanliness evidence only — never current CI, protection or
  authenticity evidence, and never by itself authorization.

### BudgetReservationV1 (`kind: "budget_reservation"`)

Durable model-start admission record; it is persisted before invocation and
persistence failure prevents invocation.

- Identity: `{ repository, id, taskId, attempt, head, purpose }` with `purpose`
  in `"implementation" | "continuation" | "retry" | "review_request"`. `attempt`
  is **one-based**: the first reservation for a task is `attempt: 1`.
  Reservations are preserved across retries and restarts by the state/budget
  implementation (deterministic ids; one shared policy across repositories).
- `outcome`:
  `"reserved" | "submitted" | "ambiguous" | "confirmed_not_submitted"`.
  `"reserved"` is the interim state (`settledAt: null`). Terminal outcomes
  require `settledAt >= createdAt`. `"submitted"` and `"ambiguous"` remain
  **charged**; `"confirmed_not_submitted"` is the only uncharged terminal and
  requires a non-null `proofRef` (and no other outcome may carry one). The
  `proofRef` is an opaque restricted storage reference (never a URL, filesystem
  path or traversal): it points into the trusted evidence store, not at a
  network endpoint that could leak into public state. Reconciliation:
  `ambiguous` → `submitted` is valid (still charged), and an `ambiguous` →
  `confirmed_not_submitted` refund still requires the proof ref; the recorded
  settlement time may advance, never move backward, and an equal repeated
  settlement is idempotent.

### ReplayResultV1 (`kind: "replay_result"`)

One isolated before/after validation.

- `original`/`candidate` each record exact `revision`, `outcome`
  (`"passed" | "failed" | "unavailable"`), `exitCode`, output digests and
  failure detail. `failed` requires `failure`; `unavailable` has no exit/output;
  `failure.intended` records whether the before-failure matched the intended
  reason.
- `fixture { ref, digest, testIds }` uses `FixtureDigest` and a restricted
  `ref`; `commands { replay,
  test }` are `CommandId`s; `expected.beforeReason`
  declares the intended failure.
- Causal rule: unless `original.outcome === "failed"` with an intended failure
  and `candidate.outcome === "passed"`, `limitations` must be non-empty —
  non-causal results never claim proof (`original_not_reproduced`,
  `candidate_not_verified`, `fixture_redacted`, `upstream_dependent`,
  `output_truncated`).

### ReleaseRequestV1 (`kind: "release_request"`)

Written by the repair workflow; no model-chosen arbitrary revision is possible —
`revision` is the exact accepted merged SHA with the PR/review reference
(`source { pullRequest, reviewRequestId, reviewReceiptId, head,
base }`) and
`target { repository, environment }` with
`environment: "production" | "isolated"` (the isolated environment is a
separate, representable target from production).

- `status`: `"open" | "fulfilled" | "failed" | "cancelled"`; `failed` and
  `cancelled` require `failureReason`; `open`/`fulfilled` forbid it.

### ReleaseRecordV1 (`kind: "release_record"`)

Owned exclusively by the deterministic release workflow.

- `repository` (release target identity, resolves the deploy config),
  `environment` (same enum as the request), `requestId`, `requestRevision`
  (recorded from the request; the only promotable Git revision),
  `candidate { identity, buildTransactionId }` where
  `identity: DeploymentIdentityV1` and the build transaction id is a separate
  exact identity (candidate `gitSha` must equal the request revision),
  `prior { identity, verifiedHealthyAt }` — the attested healthy exact prior
  identity (must differ from the candidate).
- `phase`:
  `"requested" | "promoting" | "monitoring" | "accepted" | "failed" |
  "rolled_back"`.
  `"promoting"` requires a persisted
  `intent { action:
  "promote", key, persistedAt }`.
- `observed { identity, domain, verified, at }` is the actually observed exact
  deployment identity; verified observations require identity + timestamp.
- `monitoring { startedAt, samples, continuous, lastSampleAt }` cannot fabricate
  continuity: `samples > 0` requires `startedAt <= lastSampleAt`; `"accepted"`
  requires `continuous`, `samples >= 1`, a passing and continuous `acceptance`
  referencing exactly the candidate identity, and a verified observed identity
  equal to the candidate.
- `acceptance { identity, windowMs, sampleIntervalMs, continuous, baseline,
  samples, thresholdResults, passed }`
  persists the actual baseline and sample metrics evidence (`MetricsSampleV1`
  arrays — never a bare boolean), and `thresholdResults` record
  observed/`baselineRate` against `maxRate` and `maxIncrease`. Missing telemetry
  is explicit `null` inside a sample, never a 0-rate picture.
- `MetricsSampleV1`:
  `{ identity: DeploymentIdentityV1, windowStart, windowEnd, sampledAt,
  domain, requestCount, fiveXxCount, timeoutCount, streamFailureCount,
  upstreamWideFault, coverage: IncidentCoverageV1 }`:
  each sample binds the exact deployment identity it proves (Git SHA + Deno
  revision id, never one without the other), the explicit inclusive/ exclusive
  telemetry window it covers (`windowStart < windowEnd <=
  sampledAt`, never
  inferred from the current wall clock on resume), and the coverage of the
  source scan that produced it. Counts are bounded by the denominator
  (`requestCount`), a null denominator forces all counts and the flag null, and
  no raw request data is stored. Within an acceptance result every acceptance
  sample must record the exact acceptance identity and every baseline sample the
  exact recorded prior identity — a wrong Git SHA or Deno revision id in either
  collection is rejected. Incomplete coverage can never support a passing
  acceptance: `parseReleaseRecordV1` rejects `passed: true` results whose
  baseline or samples declare incomplete coverage, while `passed: false`
  diagnostics persist their incomplete coverage instead of discarding the
  failure evidence.
- `receipts { promote, rollback, error }`: promote receipts record the status
  code and the observed exact identity; `"rolled_back"` requires an ok rollback
  receipt restoring exactly the recorded prior identity and a verified observed
  identity equal to that prior; `"failed"` requires an error receipt.

### RepairStateSnapshotV1 (`kind: "repair_state_snapshot"`)

The single JSON document on `sentinel-state/repair`:
`{ stateHead, sequence, updatedAt, incidents, evidence, work, reservations,
reviews, replays, releaseRequests }`.
Every nested record is fully validated by its own parser; corruption of any
nested record fails the whole snapshot. `stateHead` is the **parent** state
branch head this snapshot extends (`null` only on branch creation) — it is never
claimed to be the snapshot's own content commit hash. Enabling strict
expected-head CAS. Duplicate work/reservation/release (and incident/evidence/
review/replay/request) ids are rejected instead of collapsing to last-wins maps.

### ReleaseStateSnapshotV1 (`kind: "release_state_snapshot"`)

The single JSON document on `sentinel-state/release`:
`{ stateHead, sequence, updatedAt, releases }`. It contains **only** release
records; the repair snapshot contains **only** work records, budget reservations
and release requests. These sets never cross; duplicate release ids are
rejected.

## 5. Ports and result semantics

`src/contracts/ports.ts` declares the operational interfaces. Every method
returns a `PortResultV1<T>`; transport-level failure is
`{ ok: false, error: { kind, detail } }` with `kind` in `unavailable`,
`auth_failed`, `rate_limited`, `not_found`, `conflict`, `invalid`. Distinctions
the callers rely on:

- **Unavailable ≠ empty.** `listOpenIssues` failing is `ok: false`; an
  authoritative empty list is `ok: true, value: []`. `readIncident` /
  `readArtifact` use `null` for _gone/expired_ and `ok: false` for transport
  failure, so `evidence_expired` block reasons stay distinct from outages.
  `IncidentPageV1` carries explicit `coverage` independent of whether `items` is
  empty: an empty page may still be incomplete coverage, and a failed source
  read is never a successful empty page.
- **Ambiguous ≠ failed.** Writes return `outcome: "applied" | "ambiguous"` (pull
  request creation, push, review request) — ambiguous means the effect may have
  been applied and the caller must reconcile against exact authoritative state
  before repeating. Merges are `merged | ambiguous |
  blocked(reason)` where
  `blocked` is a known non-merge state, not an error.
- **GitHub recovery identity.** `GitHubPullRequestV1` carries the observed
  `mergeSha` (exact merge commit) so an ambiguous merge can be reconciled;
  `findPullRequestByHeadRef(headRef)` finds the Sentinel PR by its deterministic
  head branch; `GitHubPort.pushHead` publishes the trusted commit — a model
  candidate is a locally validated commit, never a model-owned push/publication.
- **Review submission/observation.**
  `requestReview({ prNumber, expectedHead, expectedBase, expectedReviewer,
  operationKey })`
  binds submission to exact identities;
  `observeReview(
  { operationKey, prNumber, head })` resolves by operation key
  and PR/head even when the request response id was lost. `ReviewObservationV1`
  includes `reviewer` — the actual reviewer identity observed — and m01 derives
  `ReviewReceiptV1` from authenticated original evidence only.
- **Merge authorization (`MergeRequestV1`).** The exact-head merge input is
  `{ pullRequestNumber, expectedHead, expectedBase, review }` —
  trusted-controller-only, and `parseMergeRequestV1(input, policy)` is its
  strict runtime validator (exported via `contracts/mod.ts`). It rejects every
  missing/unknown field; the embedded review must be a completed
  `ReviewReceiptV1` (pending/unavailable/malformed are never authorization)
  binding the exact same PR number, head and base, with
  `findingsUncounted ===
  0` and no unresolved P0/P1 (unresolved P2/P3 do not
  block). Repository and reviewer identity are additionally checked against the
  caller-supplied trusted adapter `policy { repository, expectedReviewer }`,
  both strictly validated, so a request can never name another repository or
  select a trusted reviewer. Parsing never grants authority: the receipt is
  identity/cleanliness evidence only, not current CI, protection or authenticity
  evidence — m01 re-observes the authoritative review by exact identifiers,
  verifies trusted resolution authorization, requires effective strict
  server-enforced up-to-date protections with no applicable token bypass, and
  requires candidate ancestry containing `expectedBase` before an expected-head
  merge.
- **Exact-head CAS vs. REST preconditions.**
  `GitHubPort.pushHead(ref, sha,
  expectedRef)` and
  `StateStore.writeRepair/writeRelease(next, expectedHead)` are true
  expected-head compare-and-swap: a mismatch returns `conflict` with the current
  head instead of overwriting. `PullRequestCreateV1.expectedBase` is **not** an
  API atomic base CAS — it is the base head precondition the trusted caller
  observed, re-observed both before and after publication; a PR created after an
  ambiguous response remains reconcilable and can never merge without exact
  current validation. The final merge compares
  `MergeRequestV1.expectedHead`/`expectedBase` against the current exact
  identities (`head_mismatch`/`base_mismatch`), and GitHub REST offers no atomic
  base CAS: effective strict protection rules (branch up-to-date enforcement)
  are what make a moved base block the merge server-side, so a moved base makes
  the candidate outdated and requires current integrated validation plus a fresh
  reviewed head. A `StateWriteResultV1` of `ambiguous` is a distinct
  network-outcome kind (may have been applied) used for post-push
  reconciliation.
- **Merge blocked reasons.** `MergeOutcomeV1` blocked reasons are
  `conflict | checks_pending | checks_failed | protection_required |
  head_mismatch | base_mismatch | review_required`
  — `base_mismatch` covers a moved/mismatched base (candidate no longer descends
  from the exact validated base) and `review_required` covers a
  missing/non-completed/outdated review or ineffective strict protection; none
  of them is an error and none is ever mergeable from the same request.
- **State capabilities.** `StateReadView`, `RepairStateWriter` and
  `ReleaseStateWriter` are separate interfaces; `StateStore` combines them for
  tests, and consumers accept the narrow `Pick`-style capability types — a
  release model never receives repair write capability or vice versa.
  `StateReadResultV1` keeps the operational Git external ref (`ref`) separate
  from the immutable `head`.
- **Promotion.** `DenoReleasePort.promote` returns
  `{ outcome: "promoted", statusCode: 204 } | { outcome: "rejected",
  statusCode } | { outcome: "ambiguous", ... }`;
  `DENO_PROMOTION_REQUIRED_STATUS` is 204.
  `findBuiltCandidate(projectId,
  revision, buildTransactionId)` takes the
  exact build transaction id in addition to the merged SHA (two builds for one
  SHA can never bind the wrong build receipt) and returns
  `found | none | ambiguous` (multiple matching builds is ambiguous, never
  "found"). Build/deployment/health/promotion identities are all
  `DeploymentIdentityV1` — the Git SHA plus the exact Deno deployment id.
  Health/metrics sampling returns explicit samples; missing telemetry is `null`
  in the sample, never interpreted as zero. `MetricsSampleConfigV1` carries the
  exact `identity` plus an explicit `windowStart`/`windowEnd`
  (`windowStart < windowEnd`) so a sample is never a clock-derived guess, and
  every returned `MetricsSampleV1` binds that identity, window and its coverage.
- **Implementation.** `ImplementationPort.runModel` takes a bounded pinned
  request (`model: "gpt-5.6-luna"`, `reasoning: "max"`, `maxDurationMs`,
  `maxOutputChars`, bounded evidence refs, secret-free base) and returns an
  actual-observation receipt
  (`observedModel/observedReasoning/durationMs/
  outputChars`) — never a CLI
  label alone — plus a locally validated candidate `head` (publication is the
  trusted GitHub writer's job), `checkpointSha` and bounded `changedPaths`.
- **Clock.** `Clock.now()` returns the current millisecond epoch; `SystemClock`
  is the production implementation.

## 6. Where records live

| Record                                                                                                                      | Home                                                         |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| RepositoryConfigV1 (+ CommandRegistryV1)                                                                                    | repository config file (Wave C), never in state              |
| WorkRecordV1, BudgetReservationV1, ReleaseRequestV1, ReviewReceiptV1, ReplayResultV1, IncidentSummaryV1, IncidentEvidenceV1 | `sentinel-state/repair` snapshot                             |
| ReleaseRecordV1                                                                                                             | `sentinel-state/release` snapshot                            |
| Incident evidence payloads                                                                                                  | restricted encrypted artifact storage (refs only in records) |

### Git state implementation (`src/state/mod.ts`, foundation-owned)

The production `GitStateStore` (role `repair` | `release`) reads both fixed refs
and writes only its own:

- Fixed refs `refs/heads/sentinel-state/repair` and
  `refs/heads/sentinel-state/release`. The store never imports, switches or
  resets the canonical/target checkout and never creates a local branch: every
  operation runs in a private temporary workdir under the explicitly provided
  scratch directory (no shared index/FETCH_HEAD, so concurrent uses cannot race
  on scratch state).
- One commit per write, containing `manifest.json` (exact keys
  `version/kind/sequence/updatedAt/stateHead`) plus one canonical JSON file per
  record under role-specific collection directories (`incidents/`, `evidence/`,
  `work/`, `reservations/`, `reviews/`, `replays/`, `releaseRequests/` for
  repair; `releases/` for release), named by `sha256(record.id)` — digest
  filenames mean no id can traverse or collide.
- Reads validate the full record tree: manifest schema, exact collection layout,
  exact record keys/schema via the frozen parsers, unique ids, digest filenames
  matching the record id, and manifest `stateHead` against the actual commit
  parent. The returned `head` is the state commit; the snapshot `stateHead`
  stays the separate parent identity.
- Writes are strict expected-head CAS: the snapshot `stateHead` must equal the
  expected head, the expected head must match the fetched ref, and the candidate
  commit is formed by plumbing with that exact parent. The push is a plain
  non-force push; a mismatch is a conflict (reread, never overwrite). Every
  commit message carries a unique trusted write nonce (generated per write,
  never from owner config/env/flag), so two identical same-second candidates can
  never produce the same commit; exactly one caller receives the fresh applied
  authorization.
- A failed push is never retried blindly: the store re-reads the authoritative
  ref and reports applied (response lost but applied), conflict (someone else
  won), ambiguous (unknown), or a typed transport error. Absent refs are
  `ls-remote` success with no match; auth/network failures are typed errors,
  never an empty state. `ls-remote` output is validated exactly: zero matching
  records is truly absent, while malformed, nonmatching or duplicate responses
  are invalid rather than empty. A throwing transport is translated into a
  sanitized typed failure (no exception text, path or URL leaks); a push whose
  response is thrown — or thrown away after success — is reconciled against the
  authoritative ref: applied only when the same unique candidate is current,
  conflict only on a proved competing outcome, otherwise ambiguous. A failed
  verification read after an attempted push is ambiguous, never a false "not
  applied" error. State trees are validated strictly: every file (manifest and
  records) must be a full regular blob (mode `100644`; symlink and executable
  files are rejected) and exactly the canonical JSON bytes this store writes
  (`canonicalStringify(parsed)` + newline), so duplicate JSON keys, reordered
  keys or formatting drift are rejected instead of reparsed.
- Transitions fail closed: prior records are never silently dropped; work
  source/repository/controller SHA/failing revision/source snapshot identity are
  immutable and `done` work is terminal; reservations keep their identity/time
  and settled states never revert (only `ambiguous` → `submitted`, still
  charged, or `ambiguous` → `confirmed_not_submitted` with the proof ref; the
  settlement time never moves backward and equal repeated settlement is
  idempotent); release request identity is immutable and terminal requests
  cannot restart; release record candidate/prior/request identity is immutable
  and accepted/rolled-back/failed releases are terminal. Incident summaries keep
  id/repository/fingerprint/firstSeenAt/failingRevision fixed with
  `count`/`lastSeenAt` nondecreasing, provenance source/endpoint fixed and
  `capturedAt` nondecreasing while severity/context/coverage/evidenceRef stay
  updateable; incident evidence keeps identity and provenance fixed, prior
  artifacts exactly present with new distinct refs appended (duplicate artifact
  refs invalid) and replay metadata may appear and then fill `fixtureDigest`/
  `reproducedAt` once without ever replacing non-null identity, while coverage
  stays updateable; review receipts keep request/reviewer/PR/submittedAt fixed
  with `observedAt` nondecreasing, pending or unavailable receipts may be
  observed into completion, and completed receipts stay immutable; replay
  results are immutable. Release records support same-phase persistence across
  `requested`/`promoting`/`monitoring` (repeated samples, saved intent,
  interrupted-coverage restarts) with per-record `updatedAt` nondecreasing;
  forward phase transitions remain allowed and backward resets forbidden.
  Snapshot sequence increases by exactly one and `updatedAt` never moves
  backward.

## 7. Budget controller API (`src/budget/mod.ts`)

`RollingStartBudget` is the one production model-start admission controller. It
receives an injected `Clock`, the repair state capability
(`StateReadView & RepairStateWriter` — `createRepairStateStore` produces it) and
the trusted complete repository configuration set; it contains no inference
transport, no storage alternative and no generalized policy layer. Every
operation rereads the authoritative repair state; callers never hold a snapshot
between operations.

### reserveModelStart(request)

`request` is only the reserved identity fields
`{ repository, taskId, head, attempt, purpose }` — a caller can never supply the
reservation id, `createdAt` or settled state. The controller reads the clock
itself, derives the id as the SHA-256 of the canonical JSON of
repository/taskId/head/attempt/purpose, and applies one durable
`BudgetReservationV1` (outcome `reserved`) to the repair branch before any start
is granted.

Result variants (exactly one; only `admitted` grants a start):

| Variant       | Meaning                                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admitted`    | one new reservation was applied; carries the durable reservation plus the newly applied state head                                                                      |
| `duplicate`   | an existing reservation with the same derived id **and the exact same logical identity** exists (including a refunded one): reconciliation needed, never a second start |
| `deferred`    | `reason: "cap_limit"` with the exact `retryAt`, or `reason: "clock_regression"` with the time at which the clock catches up                                             |
| `disabled`    | policy missing/mismatched/unowned; `detail` explains which                                                                                                              |
| `conflict`    | expected-head CAS lost; caller rereads rather than retrying                                                                                                             |
| `ambiguous`   | the write may have applied (including a rejected write promise, `currentHead: null`); reread reconciles (never a start from this response)                              |
| `unavailable` | read/write failure, a rejected read promise, malformed/out-of-range state or exhausted sequence; never grants                                                           |
| `invalid`     | bad identity fields, non-positive attempt, or an identity collision (same id under a different identity, or the same identity under a different id)                     |

Rules:

- **One global budget.** All repositories charge the same rolling caps.
  Admission policy is the complete supplied config set: the requested repository
  must be in the set, every config must carry non-null `liveStartLimits` and
  `sessionBound`, caps must be positive safe integers and identical across the
  whole set. Missing, null or mismatched policies return `disabled`; no
  default/fallback caps, no per-repo independent budget. Workflow single-writer
  serialization and one deployed config are caller responsibilities — the
  controller invents no distributed policy negotiation.
- **Charging.** Millisecond rolling intervals `(now - duration, now]`; every
  `reserved`/`submitted`/`ambiguous` reservation charges at its `createdAt`;
  only `confirmed_not_submitted` with a validated restricted `proofRef` is
  refunded. Windows never reset on midnight or process restart. The earliest
  `retryAt` under both caps sorts charged timestamps (each window's cap-th most
  recent charge must fall out), so several excess entries are handled exactly,
  not by assuming one. Timestamp/window and snapshot-sequence arithmetic stays
  inside the safe-integer range: any overflow or invalid arithmetic input is a
  typed failure (`unavailable`) and nothing is written, never an unsafe
  `retryAt` or `NaN`.
- **Identity deduplication.** Exact logical identity
  (repository/taskId/head/attempt/purpose) is compared **before** any duplicate
  classification: the same derived id plus the same logical identity returns
  `duplicate` with the existing state — never a second start permission,
  including refunded reservations. A derived id that belongs to a different
  logical identity (or the same identity under a different id) is an `invalid`
  collision; a genuinely new retry uses its own incremented attempt.
- **Clock regression.** If `now` is behind the durable snapshot `updatedAt` or
  any reservation `createdAt`/`settledAt` (including refunded entries),
  admission is blocked so future state is never lost.
- **Fail closed at the write.** A read error, a rejected read promise (sanitized
  `unavailable`, never an escaped transport exception), malformed state, CAS
  conflict, ambiguous write or persistence failure never grants permission, and
  a reservation write is never retried automatically: after
  `conflict`/`ambiguous` (including a rejected write promise, whose effect may
  have happened) the caller rereads, finds the durable reservation and
  reconciles (`duplicate`).

### settleModelStart(request)

`{ id, outcome, proofRef }` with `outcome` in `submitted`/`ambiguous`/
`confirmed_not_submitted` and a restricted `proofRef` required iff
`confirmed_not_submitted`. The controller reads the clock and state itself,
preserves `createdAt`, and applies:

- `reserved` → any settlement outcome; the settlement time is the trusted now.
- `ambiguous` → `submitted` (stays charged) or `confirmed_not_submitted` (proof
  required); settlement time only moves forward (clock regression blocks).
- Equal already-settled outcome: `idempotent` — no rewrite, no timestamp move,
  no new state commit. Changed settled proof or a contradictory terminal outcome
  (e.g. `submitted` → `confirmed_not_submitted`, or a revert towards `reserved`)
  is `invalid`.
- `submitted`/`confirmed_not_submitted` are immutable terminals; submitted
  remains charged.

The state machine is guarded from both sides: the controller never constructs an
illegal transition, and the repair state store's transition validation rejects
one anyway. There is no model fallback, retry loop or budget bypass for
reviews/continuations — all local starts, including review requests, go through
the same global repair snapshot.

### Exported arithmetic helpers

`earliestRetryAt(reservations, now, limits)` and `isCharged(reservation)` are
the pure rolling-window helpers. `earliestRetryAt` validates every input with
the frozen reservation parser, plus a nonnegative safe-integer `now`, positive
safe-integer caps and `perHour <= perSevenDays`; invalid input or timestamp
overflow throws one fixed sanitized `RangeError` that never echoes a value. The
controller catches it at its boundary, returns `unavailable` and writes nothing
— an unsafe `retryAt` or `NaN` is never produced. Windows are
`(now - duration, now]`, refunded reservations never charge, and the retry time
is the max of each window's cap-th most recent charge plus the window length (a
several-excess-correct sort, never a single-excess guess).

## 8. Fixtures and tests

`tests/fixtures/contracts/valid/*.json` holds one sanitized representative
fixture per record; `tests/fixtures/contracts/invalid/*.json` holds the
fail-closed cases (unknown keys — top-level and nested, digest confusion in both
directions, missing review completion, reviewer mismatch, unresolved
without-authorization, secret-ref URL, free-form intent detail, duplicate
artifact ref, duplicate snapshot ids, bad time, bad count, invalid lifecycle
transitions, invalid coverage, invalid budget settlement, missing replay
limitation, invalid config limits, coercion and enum violations).
`tests/fixtures/contracts/canonical/` pins canonical determinism.
`tests/fixtures/contracts/gateway-index-v1.json` is the single synthetic fixture
for the **proposed** gateway producer index (§11). It is parsed only by the
test-only wire-to-record conversion in `tests/contracts/ports_test.ts`; it is
not a claim that any target implements the endpoint and proves nothing about
live discovery.

`tests/contracts/` exercises the actual exported parsers (never duplicated
validation logic): fixture round-trip reveals parse/serialize stability, every
invalid fixture is rejected with the documented code and path, nested snapshot
records are validated, sparse/cyclic/symbol/accessor canonicalization is
rejected, error messages never echo values, metrics denominator rules hold, the
merge-authorization parser is covered by positive and negative cases (pending/
unavailable/malformed/mismatched reviews, repository and reviewer policy
binding, uncounted findings, unresolved P0/P1), and the minimal fake-port test
pins result-kind discrimination, state capability separation,
ambiguous-vs-conflict outcomes, one-based attempts and global budget conflict
refusal, the fake-port loop smoke skeleton (two deterministic ticks, repair
read/source/replay/review-wait plus an independent release read, unchanged-wait
exit with no model call or write, §10) and the gateway-index fixture mapping
into frozen `IncidentSummaryV1` records (§11). Fakes record calls and return
canned results — no product logic lives in test fakes.

`tests/budget/` covers the budget controller: pure rolling-window arithmetic
(strict `(now - duration, now]` boundaries, overlapping caps, several excess
entries under lowered caps, proof-only refunds, exact safe-integer bound,
sanitized `RangeError` on invalid/overflowing inputs), deterministic controller
semantics on the in-memory capability (exact-identity duplicate/collision
classification, malformed request and settlement boundaries, clock regression,
disabled policies, settlement idempotence and immutable timestamps, rejected
read/write promises, retry/sequence overflow, never admitting on
read/CAS/ambiguity/persistence failure), and real `GitStateStore` cases against
disposable local bare remotes (global cap across repositories with a restarted
store, simultaneous identical and distinct admissions granting exactly one
start, successful push with a lost response, throwing transports, invalid
identity inputs at the real state boundary, and unrelated state preservation).
The duplicate-artifact ref guard is additionally pinned by the direct parser
fixture, an initial-snapshot write rejection and a canned remote-tree read
rejection in `tests/state/`.

`tests/integration/` (Wave C) drives the actual production entrypoints
(`src/main.ts`, `src/release-main.ts`) with fake external transports and
disposable real local Git repositories: the complete repair lifecycle (discovery
→ retained evidence → intended before-failure → model candidate → after-pass
regression → PR → review wait → exact merge → release request), the release
controller through `src/release-main.ts` with the real `DenoReleaseRESTClient`
(receipt binding, 204 promotion plus post-effect identity proof, the 30-minute
window, acceptance, terminal repair completion), the receipt-unavailable default
(no injected resolver → waiting, never a promotion), and gateway
discovery/retention with fail-closed `evidence_expired` — plus compile-time
capability-fence checks pinning the capability separation of §10.

The test boundary is credential-free: `deno task test:local` runs
`test-local.ts`, which executes every toolchain step in child processes with
`clearEnv: true` inheriting only `PATH` and a temporary `HOME`/`DENO_DIR` (no
workstation credentials, no user Deno config). All imports are local; only
built-in `node:assert` is used — no remote test packages, no network.

## 9. Proposed consumer entry points

```ts
// m01-github: normalize transport observations into frozen records.
const receipt: ReviewReceiptV1 = parseReviewReceiptV1(observed);

// m01-github: authorize an exact-head merge against trusted adapter policy
// (repository + expected reviewer come from adapter configuration, never from
// the request or the caller-selected tokens).
const merge: MergeRequestV1 = parseMergeRequestV1(raw, {
  repository,
  expectedReviewer,
});

// m02-evidence: adapter returns normalized records.
const summary: IncidentSummaryV1 = parseIncidentSummaryV1(pageItem);

// m03-replay: build the durable result from port runs.
const result: ReplayResultV1 = parseReplayResultV1(payload);

// m04-repair: parse saved progress, then run model via ImplementationPort.
const snapshot: RepairStateSnapshotV1 = parseRepairStateSnapshotV1(raw);

// m05-release: parse durable release state and drive DenoReleasePort.
const state: ReleaseStateSnapshotV1 = parseReleaseStateSnapshotV1(raw);

// shared: config, registry and budget consumers.
const config: RepositoryConfigV1 = parseRepositoryConfigV1(raw);
const registry: CommandRegistryV1 = parseCommandRegistryV1(raw);
const reservation: BudgetReservationV1 = parseBudgetReservationV1(raw);

// canonical digests for fixture/review fingerprints (unbranded → brand via as*).
const hex = await canonicalStringifySha256(finding);
```

Runtime entrypoints should use the throwing parsers (a bad record must stop the
loop); state readers that fork on unknown content use `tryParse`.

## 10. Runtime entrypoint ownership (Wave C)

The real entrypoints are Wave C-owned and implemented in `src/main.ts` (repair
polling workflow) and `src/release-main.ts` (deterministic release workflow); no
fake stub exists. Both export one capability-injected boundary function — the
trusted host constructs every port/provider from its own secret-bearing wiring,
and the repository never builds a transport, reads an environment variable or
parses a CLI flag:

| Entrypoint                               | Owner                                        | Capabilities received                                                                                                                                                                                      | Never receives                                                                                    |
| ---------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/main.ts` — repair polling workflow  | Wave C primary                               | `StateReadView & RepairStateWriter` (repair snapshot only), the complete trusted repository config set, `Clock`, `GitHubPort`, `IncidentAdapter`, `ReplayPort`, `ImplementationPort`, `RollingStartBudget` | `ReleaseStateWriter` / `ReleaseStateSnapshotV1`, `DenoReleasePort`, release records               |
| `src/release-main.ts` — release workflow | Wave C primary (exclusive release ownership) | `StateReadView & ReleaseStateWriter` (release snapshot only), deploy identity configuration, `DenoReleasePort`, `Clock`                                                                                    | repair write capability, work records, budget reservations, `ImplementationPort`, model admission |

`runRepairEntrypoint(deps, options)` re-validates every supplied
`RepositoryConfigV1` with the frozen parser and resolves the global live-start
agreement via `resolveGlobalLiveStartLimits`: a `conflict` across the repository
set is a host wiring fault that fails closed before the loop starts.
`runReleaseEntrypoint(deps)` re-validates the m05 `ReleaseTargetConfigV1` and,
when no `BuildReceiptResolverV1` is injected, constructs the
`UnavailableBuildReceiptResolver` — the release controller then waits/blocks and
can never promote a build it cannot bind. Executing either module directly
(`deno task repair:run` / `release:run`) fails closed with a static fault: no
capability wiring is shipped, so no live activation is possible until the owner
supplies the trusted host wiring.

The two workflows poll independently; the read-only `StateReadView` is the only
shared surface, and a release consumer never receives repair write capability
(or vice versa), matching the port capabilities in §5. The repair writer never
promotes and never mutates release-state records; the release writer never edits
application code or repair-budget records.

`docs/config.example.json` is the minimal disabled-by-default repository
configuration template (`liveStartLimits: null`, `sessionBound: null`,
`stabilityPolicy: null`, `build.projectId: null`): the trusted host maintains
the real config set and never commits secret literals (the contract carries
restricted `secretRef`s only).

**Model admission.** Only a durable `RollingStartBudget.reserveModelStart(...)`
result of `{ status: "admitted" }` — one new `BudgetReservationV1` applied to
the authoritative repair branch before any start — permits
`ImplementationPort.runModel`. Every other variant (`duplicate`, `deferred`,
`disabled`, `conflict`, `ambiguous`, `unavailable`, `invalid`) never grants a
start, and an ambiguous/conflicting response is reconciled by rereading the
durable reservation. `resolveGlobalLiveStartLimits(configs)` is **cap agreement
only, never admission**: it derives the one agreed global policy
(disabled/enabled/conflict) for configuration and scheduling purposes; an
`enabled` result without a durable `admitted` reservation is never a model
start. The repair entrypoint charges every model invocation — implementation,
continuation, retry and review request — through the same global controller
(§7).

**Wave A fake-loop smoke contract.** `tests/contracts/ports_test.ts` contains
the compiled fake-port loop skeleton: a scripted two-tick sequence over the
canned fakes (repair read → source read → deterministic replay → review
observation, plus an independent release read) that records every call, exits at
an unchanged `review_pending` wait, advances time only by explicit ticks, never
calls a model port and never holds a state writer. It is a contract smoke
skeleton only — not production repair logic, not accepted end-to-end runtime;
the real selection/loop state machine belongs to m04 and the release state
machine to m05. Its deps carry `Pick<StateReadView, "readRepair">` plus
source/review/replay/clock ports with no `ImplementationPort` and no writer
capability, which is exactly the boundary §10 documents for Wave C.

## 11. Proposed gateway producer HTTP contract

**Status: proposed and frozen as a producer/consumer mapping contract — not
implemented by the current target.** At the recorded setup snapshot the gateway
repository (`ubiquity/ai.ubq.fi`, root `development` at
`aafb7ee0598699bb7fb8a72ea133693ed64462da`) exposes the existing super-admin
replay export but has **no unresolved-discovery index**: captures and the
incident outbox expire after 48 hours, the old Sentinel runtime owner remains
active, and no target writes are authorized here. m06-gateway may implement this
schema only after target-ownership reconciliation and owner approval. The
synthetic fixture `tests/fixtures/contracts/gateway-index-v1.json` maps rows
into frozen `IncidentSummaryV1` records through the test-only conversion (§8);
it proves schema mapping only, never live discovery, and no new shared port
interface is added (m02's `IncidentAdapter` returns the existing
`IncidentPageV1`).

### Existing replay export (unmodified)

`GET /admin/sentinel/replay-captures` — super-admin authentication; query
`after_ms >= 0` and `before_ms >= after_ms` must both be supplied explicitly;
page limit `1` is required (the gateway does not support larger pages); optional
`cursor` and `incident_id`; success is
`{ data: [{ manifest, chunks }], cursor }` with encrypted manifest/chunks. The
replay export is reused for artifact retrieval; it is never replaced.

### Proposed endpoint `GET /admin/sentinel/incidents`

Same super-admin authentication as the replay export. No plaintext evidence, key
material or credentials appear in the response. Query parameters are validated
fail-closed: unknown query keys, non-integer/out-of-range values and malformed
values are rejected (never ignored, defaulted or coerced).

| Parameter     | Type                                       | Semantics                                                                                              |
| ------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `limit`       | positive integer, server-enforced `1..100` | page size; the Sentinel adapter requests `1`                                                           |
| `cursor`      | string \| absent                           | opaque continuation of the previous page; absent on the first request                                  |
| `incident_id` | string \| absent                           | exact incident identity filter, in the frozen `incident_id` format given below; `readIncident` uses it |

Success response `200`:

| Field      | Type                 | Semantics                                                                           |
| ---------- | -------------------- | ----------------------------------------------------------------------------------- |
| `data`     | row array            | rows in schema below; empty is a real value only when the scan genuinely found none |
| `cursor`   | string \| null       | next page cursor; `null` when pagination is exhausted                               |
| `coverage` | `IncidentCoverageV1` | coverage of the scan producing this page; it also belongs to each mapped summary    |

A missing/unreachable producer endpoint is a port error (`unavailable`), never
an empty successful page — the adapter can never mistake an outage for "no
unresolved incidents".

### Row schema (exact snake case, unknown keys rejected)

| Field                    | Type                         | Semantics                                                                                                                         |
| ------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `incident_id`            | string                       | stable incident identity in the frozen provider-UUID format below                                                                 |
| `fingerprint`            | 64 hex                       | stable SHA-256 group identity (dedupe) — never a ciphertext digest                                                                |
| `severity`               | `P0` \| `P1` \| `P2` \| `P3` | trusted producer classification                                                                                                   |
| `first_seen_at_ms`       | ms timestamp                 | first observation                                                                                                                 |
| `last_seen_at_ms`        | ms timestamp                 | `>= first_seen_at_ms`                                                                                                             |
| `count`                  | integer `>= 1`               | occurrence count                                                                                                                  |
| `failing_revision`       | 40-hex Git SHA \| null       | exact failing target revision; `null` blocks later replay, never discovery                                                        |
| `error_type`             | string                       | bounded non-empty label                                                                                                           |
| `context`                | object                       | `{ message, location, sample }` — sanitized/bounded, no plaintext secrets (rows conform to the `IncidentSummaryV1` context rules) |
| `provenance`             | object                       | `{ endpoint, captured_at_ms, captured_by }` — see below                                                                           |
| `evidence_ref`           | object \| null               | `{ ref, digest }`; `digest` is the SHA-256 of the encrypted artifact or `null`                                                    |
| `evidence_expires_at_ms` | ms timestamp \| null         | expiry of the referenced capture; `null` when no evidence is referenced                                                           |

`evidence_ref.ref` is a restricted storage reference (opaque name — same
structural rules as `EvidenceRefV1`; never a network URL, filesystem path or
query string to raw evidence). `evidence_ref: null` is allowed and never
fabricated: a row without evidence is an incident whose replay stage is blocked,
not a suppressed discovery. `failing_revision: null` likewise blocks the replay
stage only.

**Incident id format (frozen).** `incident_id` is the gateway's existing
incident identity: lowercase `provider-` followed by a lowercase version-4 UUID,
exactly
`^provider-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`.
This is the `INCIDENT_ID` pattern already enforced by the target's
`src/sentinel_incident_outbox.ts` at the recorded setup snapshot
(`aafb7ee0598699bb7fb8a72ea133693ed64462da`), and the existing replay export
rejects incident ids outside it. The proposed index rows and the `incident_id`
filter reuse that same accepted format unchanged: an out-of-format id (for
example an ad-hoc `sentinel-synth-0001` label) is invalid at the row/filter
boundary — the adapter never coerces, renames or substitutes a fallback id, and
`readIncident` rejects it fail-closed instead of returning an empty page.

**Trusted adapter configuration.** The `IncidentSummaryV1.repository` identity
and `provenance.source: "gateway"` are trusted adapter configuration/constants:
they come from the adapter's own config, never from the response (the wire row
carries only `endpoint`/`captured_at_ms`/`captured_by`; `source` and repository
identity are not row fields). The wire `evidence_expires_at_ms` is consumed by
the evidence stage (mapping into `IncidentEvidenceV1` artifact `expiresAt`); the
summary record itself carries no expiry field.

### `readIncident` procedure (read-only)

1. Request the index with `incident_id=<id>` and `limit=1`, exhausting pages
   until `cursor: null` and coverage complete; never assume a larger page is
   supported.
2. Fetch the referenced capture through the existing authentic replay export
   (`incident_id` plus an explicit safe interval `after_ms >= 0`,
   `before_ms >= after_ms`), exhausting `limit=1` pages.
3. No hidden claim/ack/defer writes: the incident claim/acknowledge/defer POST
   endpoints are never invoked by discovery or evidence reads.

### Artifact identity and integrity

- The replay **manifest fingerprint is an HMAC identity** over the capture —
  never a ciphertext digest. Chunks are decoded in order (encrypted base64url),
  `chunk_count`/`ciphertext_bytes` and the manifest identity are verified, and
  the SHA-256 of the **actual concatenated ciphertext** is the
  `EncryptedArtifactDigest`.
- The deterministic restricted artifact ref names both the incident and the
  capture identity (e.g. `artifact://<namespace>/<incident_id>/<capture-id>`),
  so distinct captures never share a ref.
- Transport reads are bounded: `readArtifact(ref, maxBytes)` returns the
  canonical base64 ciphertext (`EncryptedArtifactV1.ciphertextBase64`), and
  `null` only for a gone/expired artifact (`evidence_expired` blocker) — never
  plaintext, never a fabricated digest.
- The AES-GCM/gzip manifest needed for trusted decryption is preserved as
  restricted associated metadata in the evidence store; no key material exists
  in contract records or public state, and the encrypted-artifact digest is
  never reused as a `FixtureDigest` (brand separation, §2).
- `ReplayMetadataV1` stays `null` until a trusted sanitized regression fixture
  exists; encrypted evidence bytes are never the fixture.

### Retention

The current 48-hour capture/outbox TTL is **not** claimed sufficient: weekly
review waits outlive it, and `evidence_expired` is a typed blocker, never a
reason to invent a fixture. Retention past 48 hours is secured by deterministic
ingestion into trusted bounded restricted storage **before model admission** —
never by asserting the current TTL already meets the contract. Live
owner-approved retention/storage bounds and the target producer seam remain
activation blockers (plan §10).
