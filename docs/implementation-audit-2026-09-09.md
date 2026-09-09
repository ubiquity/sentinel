# Sentinel implementation divergence audit — 2026-09-09 UTC

This is a new point-in-time audit for the exact base `300fc7033fd84a33133b15c3e836961fc7b2672a`
(recorded upstream of `docs/implementation-audit-2026-09-07.md` and
`docs/build-status.md`, which are preserved unchanged). It is an implementation
divergence audit, not a replacement plan, a progress ledger, or any form of
production acceptance receipt.

## Inspected identity

- Repository: `/Users/nv/repos/ubiquity/sentinel`
- Worktree (exact): `/Users/nv/repos/ubiquity/sentinel/.codex-worktrees/master-plan-wave-c-audit-20260909-ab8713c2f80`
- Branch (exact): `codex/master-plan-wave-c-audit-20260909-ab8713c2f80`
- HEAD (exact): `300fc7033fd84a33133b15c3e836961fc7b2672a`
- Parent: `dde125febf4ef31f31764804f01f2934a4a15d00` (integration of hardening
  commit `7ede714d52e86132fe241ff03e07dd1f86931dc0`); HEAD itself changes only
  `docs/build-status.md`, `docs/implementation-audit-2026-09-07.md`, and two
  lines of `test-local.ts`.
- Working tree: clean (`git status`: nothing to commit, no untracked files in
  this lane). No commit or push was made by this audit.
- Canonical integration lane honored: `/Users/nv/repos/ubiquity/sentinel/.codex-worktrees/master-plan-gfa795549e5`
  on `codex/master-plan-gfa795549e5`; nothing outside this lane was written.

Read in full before editing: the canonical lane `AGENTS.md`, `MASTER-PLAN.md`
(262 lines), `docs/lifecycle.txt`, `docs/design-rationale.md`, the prior audit
`docs/implementation-audit-2026-09-07.md` (382 lines), and the
`docs/build-status.md` ledger. Also inspected: `deno.json`; both entrypoints
`src/main.ts`, `src/release-main.ts`; host assembly
`src/host/{host,providers,github,repair,release,run}.ts`; provider boundary
`src/repair/codex-transport.ts`; runner seams `src/repair/model-port.ts`,
`src/repair/failed-command-loop.ts`, `src/repair/loop.ts` (relevant sections),
`src/replay/{port,runtime}.ts`; gateway evidence `src/adapters/gateway/{incident-adapter,store,replay-composition}.ts`;
release `src/release/{config,port,resolver,controller}.ts`; contracts
`src/contracts/{ports,repository-config}.ts`, `src/state/mod.ts`,
`src/budget/mod.ts`; `tests/integration/helpers.ts`; and
`.github/workflows/{repair,release,ci}.yml`.

## Requirement and evidence matrix

| Master-plan surface | Local deterministic evidence at this HEAD | Remaining divergence |
| --- | --- | --- |
| §4 one repair writer, one deterministic release writer | Role split is structural: `StateReadView` vs `RepairStateWriter` vs `ReleaseStateWriter` (`src/contracts/ports.ts:596,603,610`); state branches `sentinel-state/repair` and `sentinel-state/release` (`src/state/mod.ts:93-94`); repair entrypoint accepts no release writer and no Deno release port (`src/main.ts:11-24,51-79`); release entrypoint accepts no repair writer, budget or model port (`src/release-main.ts:11-25,55-83`); `src/host/run.ts:44-62` invokes the two host factories separately. | Split is verified in-process only. Nothing schedules the composed paths; no live exclusive writers, no ownership transfer, no verification that the embedded prototype's writer is drained (`MASTER-PLAN.md §10`). |
| §4 / Wave C actual scheduled entrypoints | `repair.yml` schedules `7,22,37,52 * * * *` with a non-cancelling `sentinel-repair` group and a 120-minute timeout (`.github/workflows/repair.yml:17-18,24-26,34`); `release.yml` schedules `*/5 * * * *` with a non-cancelling `sentinel-release` group (`.github/workflows/release.yml:20,26-28`). Both entrypoint modules import cleanly and their injected-lifecycle tests pass. | Both workflows still call the direct tasks (`.github/workflows/repair.yml:41` → `deno task repair:run`; `release.yml:39` → `deno task release:run`, `deno.json:12-13`), and both entrypoints deliberately throw on direct execution (`src/main.ts:157-161`, `src/release-main.ts:195-199`) with the static missing-trusted-capability fault. No trusted host wiring module is executed by any workflow; `ci.yml:31` runs only `test:local`. |
| §6 / §9.1 captured request → sanitized fixture → replay | Gateway adapter → encrypted retained store → authenticated decryption → structural sanitizer → deterministic fixture resolver is exercised as `GatewayReplayComposition` (`src/adapters/gateway/replay-composition.ts`, `src/replay/port.ts`); before/after limitation handling refuses limited proof (`src/repair/loop.ts:1380-1386,1683-1693`); the direct entrypoint stays untouched without the wrapper (`src/adapters/gateway/incident-adapter.ts:227` still emits `replay: null`). The recorded local harness receipt at the preceding product source passed `683/683` (`docs/build-status.md:1193`). | The composition is an injected capability only: no trusted host constructs it from authorized credentials/configuration, there is no permanent target application before-failure/after-pass fixture committed in this graph, and the recorded fixtures still carry `fixture_redacted` type limitations. The target m06 regression work lives in the separate ai.ubq.fi repository and is not an ancestor here. |
| §5 / §9.4 rolling budget, model, review | Durable `RollingStartBudget.reserveModelStart` over repair state (`src/budget/mod.ts:158,173`); nullable per-repository hour/seven-day caps and a global agreement resolver (`src/contracts/repository-config.ts:41,122,465-487`); reservations precede model work in the loop (`src/repair/loop.ts:1899,2569`); model port pins gpt-5.6-luna with max reasoning and its default verifier returns `unavailable` before any session opens (`src/repair/model-port.ts:3,94-98,322,327-336`); strict review normalization requires a completed observation with bounded findings (`src/github/review-normalize.ts:7-30,138-140`). | No production session factory, receipt verifier, or review service transport is wired; the default rollbacks are what the workflow would hit. Live start caps remain unset by design (`null` = inference not enabled), and no actual provider receipt has been verified. |
| §7 exact merge and build receipt | Merge requires the exact expected head and rejects a differing current head (`src/github/impl.ts:468-471,558-582`). The concrete `GithubBuildReceiptResolver` binds repository/run/attempt/workflow/SHA/project and its host factory re-validates every binding (`src/host/release.ts:95-110,155-167,187-263`); `UnavailableBuildReceiptResolver` refuses every request (`src/release/resolver.ts:55`). | The production default is the unavailable resolver, so no release can bind a build receipt (`src/release-main.ts:106`); nothing authenticates or follows a hosted receipt in this repository, and no current-head Codex review, aggregate publication or accepted target PR exists. |
| §7 / §9.6 release identity, promotion, rollback | Controller persists promotion intent, requires Deno 204, and verifies post-effect identity (`src/release/port.ts:315-363`, `src/release/controller.ts:491-567`); 30-minute window at 30-second sampling is the enforced constant window (`src/release/config.ts:28-33,379-391`). Local scripted-transport tests cover ambiguous promotion, lost monitoring and exact rollback. | All release evidence is against scripted/injected transports and temporary Git. No hosted build receipt, no exclusive target promotion handover (the target's automatic promotion path remains), no deployed runtime, no isolated real rollback drill, no owner-approved stability thresholds applied. |
| §6 / §9.7 retention | Local restricted store writes `expiresAt = retainedAt + retentionMaxAgeMs` and purges expired entries; source expiry is a separate never-extended manifest value (`src/adapters/gateway/store.ts:22-23,44-45,72-84`); expiry/coverage tests pass in the local harness. | Producer capture expiry and local retention values are synthetic test values; owner-approved production retention/storage bounds and key assembly remain unresolved. No continuous live ingestion is proven. |
| §8 m06 target publication/ownership | Sentinel-side evidence modules (`incident-adapter`, `replay-composition`, `store`) and the build-receipt resolver are locally typed and tested. | The m06 gateway work is in a separate repository/lane, unmerged and unpublished here; target ownership reconciliation, exact approved target base and the build/promotion cutover remain pending (`MASTER-PLAN.md §8, §10`). |
| §1 two-delivery / live-observation outcome | The recorded composed-lifecycle local test drives discovery → redacted replay boundary → two sequential implementations during a review wait → exact-head review/merge → release receipt → promotion → 60 samples → closure with injected transports. | No two distinct autonomous production deliveries, no continued eligible selection evidence, no six-hour observation window. Local test totals and synthetic fixtures are not live delivery proof (`MASTER-PLAN.md §9`). |

## Local vs hosted/production evidence boundary

All evidence above is local and deterministic: type checks, the credential-free
harness (`deno task test:local`), focused suites, and recorded receipts for the
exact preceding product source. Nothing here is hosted review, publication,
deployment, live write, ownership transfer, or production acceptance. There is
no GitHub remote record for Sentinel in this repository, no GitHub App/Deno
token/credential material, no deployed runtime, and no target-side mutation. No
model call, GitHub write, publication, promotion, rollback or activation was
performed by this audit.

## Fail-closed activation boundary and unresolved owner choices

The direct workflow tasks remain fail-closed by construction, and this audit
explicitly preserves that: trusted capability wiring (state stores, auth
providers, transports, receipt verifiers, release resolver) is absent here, so
`deno task repair:run` / `release:run` exit non-zero with the static fault and
no external effect is possible. No credentials, environment variables, CLI
flags, fallback models, fallback revisions, guessed budgets/thresholds, or
workflow activation is proposed or added; the owner supplies those only at
explicitly authorized activation (`MASTER-PLAN.md §10`).

Open owner choices that must be settled before any activation: repository
name/visibility and publication authority; GitHub App/target admin/Deno token
scope; global live-start caps and session/receipt policy; evidence-retention and
storage bound plus stability thresholds/minimum samples; exact old Sentinel
writer/drain and promotion-ownership handover; and confirmed clean-review
output contract with target build/promotion behavior.

## Ordered next actions

1. Settle the named owner choices above (publication identity, credential
   scope, live limits, retention/stability values, target ownership handover
   and review/build contract) before any workflow activation; no activation is
   authorized by this assignment.
2. Wire one trusted host composition behind the scheduled workflows (repair
   and release) from those settled capabilities, then re-run the fail-closed
   direct-execution checks to confirm the boundary still holds.
3. Produce the permanent target-side sanitized before-failure/after-pass
   fixture through the real capture → composition path and bind it into the
   target CI, then free an exact integrated candidate for the acceptance
   review.
4. Obtain a fresh exact-head Codex acceptance review (reviews are not reused
   for different bytes), fix any substantive P0/P1, and publish the aggregate
   Sentinel PR.
5. After handover, run one isolated real Deno release/rollback drill, then
   enable target repairs and record two distinct autonomous deliveries plus
   the six-hour observation window.
