/**
 * Deterministic release controller: the exclusive release ownership state
 * machine.
 *
 * The controller consumes `StateReadView` (repair requests + release records)
 * and `ReleaseStateWriter` (release records only) plus `DenoReleasePort`, the
 * trusted build-receipt resolver capability and `Clock`. It never touches
 * repair/budget/code state, never uses a model, and every release record it
 * writes is re-parseable by the frozen parser (records are built through
 * parseReleaseRecordV1).
 *
 * Sequence per release:
 * 1. Resolve the exact build receipt (trusted resolver keyed by the request);
 *    absent/ambiguous/unavailable waits/blocks without promotion.
 * 2. Verify exactly one matched build on the platform.
 * 3. Attest the exact healthy prior identity on the managed domain and record
 *    candidate + prior (phase `requested`).
 * 4. Persist promote intent (phase `promoting`), then promote and require
 *    HTTP 204 plus post-effect managed identity proof.
 * 5. Monitor with persisted 30-second window slots; a missed slot or an
 *    unverifiable health observation restarts the window (interrupted
 *    continuity is never reconstructed).
 * 6. Evaluate the owner policy: a threshold breach is objective failure and
 *    rolls back; missing/insufficient evidence is failed acceptance without
 *    rollback.
 * 7. Rollback re-observes actual candidate ownership, then restores the exact
 *    recorded prior and proves restoration; a conflicting unrelated newer
 *    deployment blocks instead of rolling back.
 *
 * Requests already accepted or rolled back stay terminal (the state store
 * refuses to mutate terminal records).
 */

import type { Clock } from "../contracts/ports.ts";
import type {
  DenoReleasePort,
  HealthSampleConfigV1,
  HealthSampleV1,
  PortResultV1,
  ReleaseStateWriter,
  StateReadView,
} from "../contracts/ports.ts";
import { portOk } from "../contracts/ports.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { StabilityPolicyV1 } from "../contracts/repository-config.ts";
import {
  type AcceptanceResultV1,
  parseReleaseRecordV1,
  type ReleaseErrorV1,
  type ReleaseIntentV1,
  type ReleasePhaseV1,
  type ReleaseReceiptV1,
  type ReleaseRecordV1,
} from "../contracts/release.ts";
import type {
  ReleaseRequestV1,
  ReleaseTargetEnvironmentV1,
} from "../contracts/release.ts";
import type {
  DeploymentIdentityV1,
  MetricsSampleV1,
  RepositoryIdentityV1,
} from "../contracts/shared.ts";
import type { ReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import {
  RELEASE_EXPECTED_SAMPLES,
  RELEASE_MAX_SLOTS_PER_RUN,
  RELEASE_SAMPLE_INTERVAL_MS,
  validateStabilityPolicy,
} from "./config.ts";
import type { ReleaseTargetConfigV1 } from "./config.ts";
import {
  buildAcceptanceResult,
  evaluateAcceptance,
  nextAlignedWindowStart,
  slotMissed,
} from "./acceptance.ts";
import type { BuildReceiptResolverV1 } from "./resolver.ts";

export type ReleaseCycleResultV1 =
  | { status: "idle"; warnings: string[] }
  | { status: "waiting"; detail: string; warnings: string[] }
  | {
    status: "advanced";
    recordId: string;
    phase: ReleasePhaseV1;
    warnings: string[];
  }
  | {
    status: "persisted";
    recordId: string;
    phase: ReleasePhaseV1;
    warnings: string[];
  }
  | { status: "conflict"; recordId: string | null; warnings: string[] }
  | {
    status: "blocked";
    recordId: string | null;
    detail: string;
    warnings: string[];
  };

export interface ReleaseControllerOptions {
  /** The exact target repository this controller owns. */
  repository: RepositoryIdentityV1;
  /** The exact target environment (production/isolated). */
  environment: ReleaseTargetEnvironmentV1;
  /** m05 trusted configuration (identity headers, bounds). */
  target: ReleaseTargetConfigV1;
  /** Enabled owner stability policy (validated at construction). */
  policy: StabilityPolicyV1;
  stateRead: StateReadView;
  stateWrite: ReleaseStateWriter;
  deno: DenoReleasePort;
  resolver: BuildReceiptResolverV1;
  clock: Clock;
}

interface LoadedContextV1 {
  /** All matching open requests in deterministic order. */
  requests: ReleaseRequestV1[];
  /** Matching records in non-terminal phases (0 or 1 valid; more conflicts). */
  active: ReleaseRecordV1[];
  /** Matching terminal records. */
  terminal: ReleaseRecordV1[];
  releaseHead: GitSha | null;
}

const ERROR_RULES: Record<string, { detail: string; recovered: boolean }> = {
  promotion_not_applied: {
    detail: "promotion did not take effect",
    recovered: true,
  },
  unrelated_newer_deployment: {
    detail: "an unrelated newer deployment is current",
    recovered: false,
  },
  acceptance_insufficient: {
    detail: "acceptance evidence is insufficient",
    recovered: false,
  },
};

export class ReleaseController {
  private readonly repository: RepositoryIdentityV1;
  private readonly environment: ReleaseTargetEnvironmentV1;
  private readonly target: ReleaseTargetConfigV1;
  private readonly policy: StabilityPolicyV1;
  private readonly stateRead: StateReadView;
  private readonly stateWrite: ReleaseStateWriter;
  private readonly deno: DenoReleasePort;
  private readonly resolver: BuildReceiptResolverV1;
  private readonly clock: Clock;
  /** Exact expected release-state head for this run's CAS writes. */
  private expectedHead: GitSha | null = null;

  constructor(options: ReleaseControllerOptions) {
    const check = validateStabilityPolicy(options.policy);
    if (!check.ok) {
      // Construction-time config fault: static detail, never echoed values.
      throw new Error(`release controller config rejected: ${check.detail}`);
    }
    this.repository = options.repository;
    this.environment = options.environment;
    this.target = options.target;
    this.policy = options.policy;
    this.stateRead = options.stateRead;
    this.stateWrite = options.stateWrite;
    this.deno = options.deno;
    this.resolver = options.resolver;
    this.clock = options.clock;
  }

  async run(): Promise<PortResultV1<ReleaseCycleResultV1>> {
    const context = await this.loadContext();
    if (context === null) {
      return portOk({
        status: "blocked",
        recordId: null,
        detail: "release state is unavailable",
        warnings: [],
      });
    }
    if (context.active.length > 1) {
      return portOk({
        status: "blocked",
        recordId: null,
        detail: "multiple concurrent releases target the same environment",
        warnings: [],
      });
    }
    if (context.active.length === 1) {
      return this.continueRecord(context.active[0], context);
    }
    const next = this.firstEligibleRequest(context);
    if (next === null) return portOk({ status: "idle", warnings: [] });
    return this.beginRequest(next, context);
  }

  // -------------------------------------------------------------------------
  // State loading and request selection.
  // -------------------------------------------------------------------------

  private async loadContext(): Promise<LoadedContextV1 | null> {
    const release = await this.stateRead.readRelease();
    if (!release.ok) return null;
    const repair = await this.stateRead.readRepair();
    if (!repair.ok) return null;
    const releaseSnapshot: ReleaseStateSnapshotV1 =
      release.value.status === "found" ? release.value.snapshot : {
        version: "v1",
        kind: "release_state_snapshot",
        stateHead: null,
        sequence: 0,
        updatedAt: this.clock.now(),
        releases: [],
      };
    const repairSnapshot = repair.value.status === "found"
      ? repair.value.snapshot
      : null;
    const requests = (repairSnapshot?.releaseRequests ?? [])
      .filter((request) =>
        request.status === "open" &&
        sameRepository(request.target.repository, this.repository) &&
        request.target.environment === this.environment
      )
      .sort((a, b) =>
        a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      );

    const matching = releaseSnapshot.releases.filter((record) =>
      sameRepository(record.repository, this.repository) &&
      record.environment === this.environment
    );
    this.expectedHead = release.value.status === "found"
      ? release.value.head
      : null;
    return {
      requests,
      active: matching.filter((record) => !isTerminalPhase(record.phase)),
      terminal: matching.filter((record) => isTerminalPhase(record.phase)),
      releaseHead: this.expectedHead,
    };
  }

  private firstEligibleRequest(
    context: LoadedContextV1,
  ): ReleaseRequestV1 | null {
    const taken = new Set(
      context.terminal.map((record) => record.requestId).concat(
        context.active.map((record) => record.requestId),
      ),
    );
    for (const request of context.requests) {
      if (!taken.has(request.id)) return request;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Step A: resolve receipt, verify build, attest prior, create the record.
  // -------------------------------------------------------------------------

  private async beginRequest(
    request: ReleaseRequestV1,
    context: LoadedContextV1,
  ): Promise<PortResultV1<ReleaseCycleResultV1>> {
    const resolution = await this.resolver.resolve(request);
    if (!resolution.ok) {
      return portOk({
        status: "waiting",
        detail: "build receipt is unavailable",
        warnings: [],
      });
    }
    if (resolution.value.status !== "found") {
      return portOk({
        status: "waiting",
        detail: resolution.value.status === "absent"
          ? "build receipt is absent"
          : "build receipt is ambiguous",
        warnings: [],
      });
    }
    const receipt = resolution.value.receipt;
    if (receipt.identity.gitSha !== request.revision) {
      return portOk({
        status: "blocked",
        recordId: null,
        detail: "build receipt identity does not match the request revision",
        warnings: [],
      });
    }

    const candidate = await this.deno.findBuiltCandidate(
      this.target.projectId,
      request.revision,
      receipt.buildTransactionId,
      receipt.identity.revisionId,
    );
    if (!candidate.ok) {
      return portOk({
        status: "blocked",
        recordId: null,
        detail: "candidate build could not be verified",
        warnings: [],
      });
    }
    if (candidate.value.status === "none") {
      return portOk({
        status: "waiting",
        detail: "candidate build is not visible yet",
        warnings: [],
      });
    }
    if (candidate.value.status === "ambiguous") {
      return portOk({
        status: "waiting",
        detail: "candidate build binding is ambiguous",
        warnings: [],
      });
    }
    const build = candidate.value.build;
    if (!sameIdentity(build.identity, receipt.identity)) {
      return portOk({
        status: "blocked",
        recordId: null,
        detail: "platform build identity does not match the receipt",
        warnings: [],
      });
    }

    const prior = await this.attestPrior();
    if (prior.status !== "ok") return prior.result;

    const now = this.clock.now();
    const record = parseReleaseRecordV1({
      version: "v1",
      kind: "release_record",
      repository: this.repository,
      environment: this.environment,
      id: `release-${request.id}`,
      requestId: request.id,
      requestRevision: request.revision,
      candidate: {
        identity: build.identity,
        buildTransactionId: receipt.buildTransactionId,
      },
      prior: {
        identity: prior.identity,
        verifiedHealthyAt: prior.verifiedAt,
      },
      phase: "requested",
      intent: null,
      observed: {
        identity: null,
        domain: this.target.acceptance.domain,
        verified: false,
        at: null,
      },
      monitoring: {
        startedAt: null,
        samples: 0,
        continuous: false,
        lastSampleAt: null,
      },
      acceptance: null,
      receipts: { promote: null, rollback: null, error: null },
      createdAt: now,
      updatedAt: now,
    });

    const written = await this.writeSnapshot(context, record);
    if (!written) {
      return portOk({ status: "conflict", recordId: null, warnings: [] });
    }
    return portOk({
      status: "advanced",
      recordId: record.id,
      phase: "requested",
      warnings: [],
    });
  }

  /**
   * Attests the exact healthy prior: managed-domain identity plus platform
   * corroboration. The attested identity is the only prior an
   * accepted/rolled-back record may reference.
   */
  private async attestPrior(): Promise<
    | { status: "ok"; identity: DeploymentIdentityV1; verifiedAt: number }
    | { status: "result"; result: PortResultV1<ReleaseCycleResultV1> }
  > {
    const health = await this.deno.sampleHealth(this.identityHealthConfig());
    if (!health.ok) {
      return {
        status: "result",
        result: this.blocked(null, "managed health check is unavailable"),
      };
    }
    if (health.value.identity === null) {
      return {
        status: "result",
        result: portOk({
          warnings: [],

          status: "waiting",
          detail: "current deployment identity is not observable",
        }),
      };
    }
    if (
      health.value.status !== "healthy" ||
      health.value.httpStatus !== 200 ||
      health.value.bodyMarkerPresent !== true ||
      health.value.headersMatch !== true
    ) {
      return {
        status: "result",
        result: this.blocked(
          null,
          "current deployment is not verified healthy",
        ),
      };
    }
    const platform = await this.deno.readCurrentDeployment(
      this.target.projectId,
    );
    if (!platform.ok) {
      return {
        status: "result",
        result: this.blocked(
          null,
          "current platform deployment is unavailable",
        ),
      };
    }
    if (platform.value.status === "not_deployed") {
      return {
        status: "result",
        result: this.blocked(
          null,
          "platform reports no deployment for the managed domain",
        ),
      };
    }
    if (
      platform.value.status === "live" &&
      platform.value.identity !== null &&
      !sameIdentity(platform.value.identity, health.value.identity)
    ) {
      return {
        status: "result",
        result: this.blocked(
          null,
          "platform identity conflicts with the observed deployment",
        ),
      };
    }
    return {
      status: "ok",
      identity: health.value.identity,
      verifiedAt: health.value.at,
    };
  }

  // -------------------------------------------------------------------------
  // Step B: continue one active record by phase.
  // -------------------------------------------------------------------------

  private async continueRecord(
    record: ReleaseRecordV1,
    context: LoadedContextV1,
  ): Promise<PortResultV1<ReleaseCycleResultV1>> {
    switch (record.phase) {
      case "requested":
        return await this.promoteRecord(record, context);
      case "promoting":
        return await this.reconcilePromotion(record, context);
      case "monitoring":
        return await this.monitorRecord(record, context);
      default:
        return this.blocked(
          record.id,
          "release record is in an unexpected phase",
        );
    }
  }

  /**
   * Requested → promoting: re-observe the exact prior, persist the promote
   * intent, then promote and require 204 plus post-effect identity proof.
   */
  private async promoteRecord(
    record: ReleaseRecordV1,
    context: LoadedContextV1,
  ): Promise<PortResultV1<ReleaseCycleResultV1>> {
    const observed = await this.observeManaged();
    if (observed.status === "error" || observed.sample.identity === null) {
      return this.blocked(record.id, "current deployment is unobservable");
    }
    if (!sameIdentity(observed.sample.identity, record.prior.identity)) {
      return this.blocked(
        record.id,
        "current deployment conflicts with the recorded prior",
      );
    }
    if (record.intent !== null) {
      return this.reconcilePromotion(
        { ...record, phase: "promoting" },
        context,
      );
    }

    const intent: ReleaseIntentV1 = {
      action: "promote",
      key: `promote/${record.id}/${record.candidate.identity.revisionId}`,
      persistedAt: this.clock.now(),
    };
    const intentRecord = parseReleaseRecordV1({
      ...record,
      phase: "promoting",
      intent,
      updatedAt: this.clock.now(),
    });
    const intentWrite = await this.writeSnapshot(context, intentRecord);
    if (!intentWrite) {
      return portOk({ status: "conflict", recordId: record.id, warnings: [] });
    }

    const outcome = await this.deno.promote({
      projectId: this.target.projectId,
      identity: record.candidate.identity,
    });
    if (!outcome.ok) {
      return this.blocked(record.id, "promotion request failed");
    }
    if (outcome.value.outcome !== "promoted") {
      return this.persistPromoteReceipt(
        record,
        context,
        {
          action: "promote",
          ok: false,
          statusCode: outcome.value.statusCode,
          observedIdentity: null,
          observedDomain: this.target.acceptance.domain,
          at: this.clock.now(),
          detail: outcome.value.outcome === "rejected"
            ? "promotion was rejected"
            : "promotion outcome is ambiguous",
        },
      );
    }

    // HTTP 204: post-effect identity proof on the managed domain.
    const proof = await this.proveManaged(record.candidate.identity);
    if (
      proof.status === "error" ||
      proof.sample.identity === null ||
      proof.sample.status !== "healthy"
    ) {
      return this.persistPromoteReceipt(
        record,
        context,
        {
          action: "promote",
          ok: false,
          statusCode: 204,
          observedIdentity: proof.status === "error"
            ? null
            : proof.sample.identity,
          observedDomain: this.target.acceptance.domain,
          at: this.clock.now(),
          detail: "post-effect identity proof not yet observed",
        },
      );
    }

    // Verified: finalize promotion and open the monitor window.
    const finalized = parseReleaseRecordV1({
      ...record,
      phase: "monitoring",
      intent,
      observed: {
        identity: record.candidate.identity,
        domain: this.target.acceptance.domain,
        verified: true,
        at: proof.sample.at,
      },
      monitoring: {
        startedAt: proof.sample.at,
        samples: 0,
        continuous: true,
        lastSampleAt: null,
      },
      receipts: {
        promote: {
          action: "promote",
          ok: true,
          statusCode: 204,
          observedIdentity: record.candidate.identity,
          observedDomain: this.target.acceptance.domain,
          at: this.clock.now(),
          detail: null,
        },
        rollback: null,
        error: null,
      },
      updatedAt: this.clock.now(),
    });
    const write = await this.writeSnapshot(context, finalized);
    if (!write) {
      return portOk({ status: "conflict", recordId: record.id, warnings: [] });
    }
    return portOk({
      status: "advanced",
      recordId: record.id,
      phase: "monitoring",
      warnings: [],
    });
  }

  /**
   * Promoting reconciliation against the exact observed deployment. A lost
   * promotion response with an observed candidate is reconciliation, never a
   * repeated promotion; an observed prior on two consecutive observations
   * after a concluded attempt is a failed promotion; any other identity is an
   * unrelated-deployment conflict.
   */
  private async reconcilePromotion(
    record: ReleaseRecordV1,
    context: LoadedContextV1,
  ): Promise<PortResultV1<ReleaseCycleResultV1>> {
    const observed = await this.observeManaged();
    if (observed.status === "error" || observed.sample.identity === null) {
      return this.blocked(record.id, "promotion cannot be reconciled");
    }
    const identity = observed.sample.identity;
    if (sameIdentity(identity, record.candidate.identity)) {
      const finalized = parseReleaseRecordV1({
        ...record,
        phase: "monitoring",
        observed: {
          identity: record.candidate.identity,
          domain: this.target.acceptance.domain,
          verified: true,
          at: observed.sample.at,
        },
        monitoring: {
          startedAt: observed.sample.at,
          samples: 0,
          continuous: true,
          lastSampleAt: null,
        },
        receipts: {
          ...record.receipts,
          promote: {
            action: "promote",
            ok: true,
            statusCode: 204,
            observedIdentity: record.candidate.identity,
            observedDomain: this.target.acceptance.domain,
            at: this.clock.now(),
            detail: null,
          },
        },
        updatedAt: this.clock.now(),
      });
      const write = await this.writeSnapshot(context, finalized);
      if (!write) {
        return portOk({
          status: "conflict",
          recordId: record.id,
          warnings: [],
        });
      }
      return portOk({
        status: "advanced",
        recordId: record.id,
        phase: "monitoring",
        warnings: [],
      });
    }
    if (sameIdentity(identity, record.prior.identity)) {
      const priorObserved = record.receipts.promote !== null &&
        record.receipts.promote.observedIdentity !== null &&
        sameIdentity(
          record.receipts.promote.observedIdentity,
          record.prior.identity,
        );
      if (priorObserved) {
        // Second consecutive prior observation after a concluded attempt:
        // the promotion did not apply. Never a blind retry.
        return this.failRecord(
          record,
          context,
          identity,
          observed.sample.at,
          "promotion_not_applied",
        );
      }
      return this.persistPromoteReceipt(
        record,
        context,
        {
          action: "promote",
          ok: false,
          statusCode: record.receipts.promote?.statusCode ?? null,
          observedIdentity: identity,
          observedDomain: this.target.acceptance.domain,
          at: this.clock.now(),
          detail: "promotion not observed on the managed domain",
        },
      );
    }
    // An unrelated identity is current: the promotion was never applied and
    // another writer deployed. Never clobber it.
    return this.failRecord(
      record,
      context,
      identity,
      observed.sample.at,
      "unrelated_newer_deployment",
    );
  }

  private persistPromoteReceipt(
    record: ReleaseRecordV1,
    context: LoadedContextV1,
    receipt: ReleaseReceiptV1,
  ): Promise<PortResultV1<ReleaseCycleResultV1>> {
    const updated = parseReleaseRecordV1({
      ...record,
      phase: "promoting",
      intent: record.intent ?? {
        action: "promote",
        key: `promote/${record.id}/${record.candidate.identity.revisionId}`,
        persistedAt: this.clock.now(),
      },
      observed: receipt.observedIdentity === null ? record.observed : {
        identity: receipt.observedIdentity,
        domain: this.target.acceptance.domain,
        verified: false,
        at: this.clock.now(),
      },
      receipts: { ...record.receipts, promote: receipt },
      updatedAt: this.clock.now(),
    });
    return this.persistAndReport(updated, context, "promoting");
  }

  private async failRecord(
    record: ReleaseRecordV1,
    context: LoadedContextV1,
    identity: DeploymentIdentityV1,
    observedAt: number,
    kind: string,
  ): Promise<PortResultV1<ReleaseCycleResultV1>> {
    const failed = parseReleaseRecordV1({
      ...record,
      phase: "failed",
      observed: {
        identity,
        domain: this.target.acceptance.domain,
        verified: true,
        at: observedAt,
      },
      receipts: {
        ...record.receipts,
        error: makeError(this.clock.now(), kind),
      },
      updatedAt: this.clock.now(),
    });
    const write = await this.writeSnapshot(context, failed);
    if (!write) {
      return portOk({ status: "conflict", recordId: record.id, warnings: [] });
    }
    return portOk({
      status: "advanced",
      recordId: record.id,
      phase: "failed",
      warnings: [],
    });
  }

  // -------------------------------------------------------------------------
  // Step C: monitoring — health identity, persisted slots, acceptance.
  // -------------------------------------------------------------------------

  private async monitorRecord(
    record: ReleaseRecordV1,
    context: LoadedContextV1,
  ): Promise<PortResultV1<ReleaseCycleResultV1>> {
    if (record.intent !== null && record.intent.action === "rollback") {
      return this.rollbackRecord(record, context);
    }
    if (record.monitoring.startedAt === null) {
      return this.blocked(record.id, "monitoring window has no start");
    }

    // Managed identity observation every tick. A healthy managed sample is
    // body marker + managed headers + exact identity (port-level `healthy`);
    // any missing piece is an interrupted monitor (reset, never fabricate) —
    // an observable mismatch is handled below; degraded/unhealthy evidence
    // never advances the window.
    const observation = await this.observeManaged();
    if (
      observation.status === "error" ||
      observation.sample.identity === null ||
      observation.sample.status !== "healthy"
    ) {
      return this.restartMonitor(record, context);
    }
    const identity = observation.sample.identity;
    if (!sameIdentity(identity, record.candidate.identity)) {
      if (sameIdentity(identity, record.prior.identity)) {
        // The candidate was never/again not current: already restored.
        return this.finalizeRolledBack(record, context, {
          action: "rollback",
          ok: true,
          statusCode: null,
          observedIdentity: record.prior.identity,
          observedDomain: this.target.acceptance.domain,
          at: this.clock.now(),
          detail: "deployment already served the prior identity",
        });
      }
      return this.blocked(
        record.id,
        "candidate ownership conflicts with an unrelated deployment",
      );
    }

    // Custom-domain probe after the managed identity passed. 200 with exact
    // identity passes; 200 mismatch is a hard identity failure; a VERIFIED
    // Cloudflare 403 challenge warns only; every other outcome (unverified
    // 403, other non-200, unobservable gateway) blocks acceptance — custom
    // delivery can never be accepted while the gateway cannot be verified.
    const warnings: string[] = [];
    const custom = await this.probeCustom(record.candidate.identity);
    if (custom?.status === "hard-fail") {
      return this.persistRollbackIntent(record, context, warnings);
    }
    if (custom?.status === "warned") warnings.push(...custom.warnings);
    if (custom?.status === "blocked") {
      return this.blocked(record.id, custom.detail);
    }

    // Candidate window slots, strictly from persisted state. All due slots
    // since the last persisted sample are collected in one run; every slot
    // keeps its exact persisted window. When the observation is late by more
    // than one interval (an unobserved monitoring gap), continuity restarts:
    // historical slots are never accepted as if sampled while the monitor was
    // absent. A slot whose telemetry is incomplete/unreadable is likewise an
    // interrupted monitor and is never reconstructed.
    const startedAt = record.monitoring.startedAt;
    const now = this.clock.now();
    const collected = record.monitoring.samples;
    const dueSlots = Math.floor(
      (now - this.target.logsLagMs - startedAt) / RELEASE_SAMPLE_INTERVAL_MS,
    ) - collected;
    if (dueSlots <= 0) {
      return portOk({
        status: "waiting",
        detail: "next sample slot is not due",
        warnings,
      });
    }
    if (
      slotMissed(
        startedAt,
        RELEASE_SAMPLE_INTERVAL_MS,
        collected,
        now,
        this.target.logsLagMs,
      )
    ) {
      return this.restartMonitor(record, context);
    }

    const baselineStart = record.prior.verifiedHealthyAt -
      this.policy.baselineWindowMs;
    const baseline = [...(record.acceptance?.baseline ?? [])];
    const samples: MetricsSampleV1[] = [...(record.acceptance?.samples ?? [])];
    // The baseline cap applies to this invocation, not to the accumulated
    // persisted baseline. A run with several overdue candidate slots must not
    // bypass the per-run sampling bound through the outer loop.
    let baselineCollectedThisRun = 0;
    for (let i = 0; i < dueSlots; i++) {
      const slotIndex = collected + i;
      const windowStart = startedAt + slotIndex * RELEASE_SAMPLE_INTERVAL_MS;
      const windowEnd = windowStart + RELEASE_SAMPLE_INTERVAL_MS;
      const sample = await this.deno.sampleMetrics({
        baseUrl: this.target.managedBaseUrl,
        metricsPath: this.target.acceptance.metricsPath,
        identity: record.candidate.identity,
        windowStart,
        windowEnd,
        domain: this.target.acceptance.domain,
      });
      if (!sample.ok || !completeSample(sample.value)) {
        // Unreadable/missing telemetry in a window slot is an interrupted
        // monitor: restart, never reconstruct.
        return this.restartMonitor(record, context);
      }
      samples.push(sample.value);
      // Historical baseline slots for the recorded prior (bounded per run);
      // an unreadable baseline slot is re-queried on a later run, never
      // reconstructed.
      while (
        baseline.length < this.policy.baselineWindowMs /
            RELEASE_SAMPLE_INTERVAL_MS &&
        baselineCollectedThisRun < RELEASE_MAX_SLOTS_PER_RUN
      ) {
        const slotIndexB = baseline.length;
        const windowStartB = baselineStart +
          slotIndexB * RELEASE_SAMPLE_INTERVAL_MS;
        const windowEndB = windowStartB + RELEASE_SAMPLE_INTERVAL_MS;
        if (windowEndB + this.target.logsLagMs > now) break;
        const baselineSample = await this.deno.sampleMetrics({
          baseUrl: this.target.managedBaseUrl,
          metricsPath: this.target.acceptance.metricsPath,
          identity: record.prior.identity,
          windowStart: windowStartB,
          windowEnd: windowEndB,
          domain: this.target.acceptance.domain,
        });
        if (!baselineSample.ok || !completeSample(baselineSample.value)) break;
        baseline.push(baselineSample.value);
        baselineCollectedThisRun++;
      }
    }
    if (baseline.length === 0 && samples.length >= 1) {
      // Candidate telemetry was observed but no baseline evidence for the
      // recorded prior exists: an acceptance document cannot be constructed
      // (the frozen parser requires baseline evidence), so the missing
      // baseline is a persisted explicit insufficient-evidence failure —
      // never a thrown exception, never a fabricated baseline.
      return this.failBaselineInsufficient(record, context, warnings);
    }
    // One durable write per run: the run's slots (and the completed baseline
    // evidence) are persisted together; a crashed run simply restarts its
    // window from persisted state instead of reconstructing anything.
    const latest = parseReleaseRecordV1({
      ...record,
      monitoring: {
        startedAt,
        samples: collected + dueSlots,
        continuous: true,
        lastSampleAt: now,
      },
      acceptance: buildDiagnosticAcceptance(
        record.candidate.identity,
        this.policy,
        baseline,
        samples,
      ),
      updatedAt: now,
    });
    const write = await this.writeSnapshot(context, latest);
    if (!write) {
      return portOk({ status: "conflict", recordId: record.id, warnings: [] });
    }

    if (latest.monitoring.samples >= RELEASE_EXPECTED_SAMPLES) {
      return this.evaluateWindow(latest, context, warnings);
    }
    return portOk({
      status: "persisted",
      recordId: record.id,
      phase: "monitoring",
      warnings,
    });
  }

  private restartMonitor(
    record: ReleaseRecordV1,
    context: LoadedContextV1,
  ): Promise<PortResultV1<ReleaseCycleResultV1>> {
    const startedAt = nextAlignedWindowStart(
      RELEASE_SAMPLE_INTERVAL_MS,
      this.clock.now(),
    );
    const updated = parseReleaseRecordV1({
      ...record,
      monitoring: {
        startedAt,
        samples: 0,
        continuous: true,
        lastSampleAt: null,
      },
      acceptance: null,
      updatedAt: this.clock.now(),
    });
    return this.persistAndReport(updated, context, "monitoring");
  }

  private async evaluateWindow(
    record: ReleaseRecordV1,
    context: LoadedContextV1,
    warnings: string[],
  ): Promise<PortResultV1<ReleaseCycleResultV1>> {
    const acceptance = record.acceptance;
    if (acceptance === null || acceptance.samples.length < 1) {
      return this.restartMonitor(record, context);
    }
    const evaluation = evaluateAcceptance(
      this.policy,
      acceptance.baseline,
      acceptance.samples,
    );
    if (evaluation.passed) {
      const finalAcceptance: AcceptanceResultV1 = {
        ...acceptance,
        continuous: true,
        thresholdResults: evaluation.thresholds,
        passed: true,
      };
      const accepted = parseReleaseRecordV1({
        ...record,
        phase: "accepted",
        observed: {
          identity: record.candidate.identity,
          domain: this.target.acceptance.domain,
          verified: true,
          at: this.clock.now(),
        },
        monitoring: { ...record.monitoring, continuous: true },
        acceptance: finalAcceptance,
        updatedAt: this.clock.now(),
      });
      const write = await this.writeSnapshot(context, accepted);
      if (!write) {
        return portOk({
          status: "conflict",
          recordId: record.id,
          warnings: [],
        });
      }
      return portOk({
        status: "advanced",
        recordId: record.id,
        phase: "accepted",
        warnings: [],
      });
    }
    if (evaluation.objectiveFailure) {
      return this.persistRollbackIntent(record, context, warnings);
    }
    return this.failInsufficient(record, context, evaluation, warnings);
  }

  private async failInsufficient(
    record: ReleaseRecordV1,
    context: LoadedContextV1,
    evaluation: ReturnType<typeof evaluateAcceptance>,
    warnings: string[],
  ): Promise<PortResultV1<ReleaseCycleResultV1>> {
    const acceptance = record.acceptance;
    const finalAcceptance: AcceptanceResultV1 | null = acceptance === null
      ? null
      : {
        ...acceptance,
        continuous: true,
        thresholdResults: evaluation.thresholds,
        passed: false,
      };
    const failed = parseReleaseRecordV1({
      ...record,
      phase: "failed",
      acceptance: finalAcceptance,
      receipts: {
        ...record.receipts,
        error: makeError(this.clock.now(), "acceptance_insufficient"),
      },
      updatedAt: this.clock.now(),
    });
    const write = await this.writeSnapshot(context, failed);
    if (!write) {
      return portOk({ status: "conflict", recordId: record.id, warnings: [] });
    }
    return portOk({
      status: "advanced",
      recordId: record.id,
      phase: "failed",
      warnings,
    });
  }

  /**
   * Baseline evidence is entirely absent while candidate telemetry was
   * observed: the frozen acceptance contract requires baseline evidence, so
   * the missing baseline is persisted as an explicit
   * `acceptance_insufficient` failure (no rollback — there is no objective
   * candidate failure). Also never throws: a missing baseline must not
   * repeatedly crash the release controller.
   */
  private async failBaselineInsufficient(
    record: ReleaseRecordV1,
    context: LoadedContextV1,
    warnings: string[],
  ): Promise<PortResultV1<ReleaseCycleResultV1>> {
    const failed = parseReleaseRecordV1({
      ...record,
      phase: "failed",
      acceptance: null,
      receipts: {
        ...record.receipts,
        error: makeError(this.clock.now(), "acceptance_insufficient"),
      },
      updatedAt: this.clock.now(),
    });
    const write = await this.writeSnapshot(context, failed);
    if (!write) {
      return portOk({ status: "conflict", recordId: record.id, warnings: [] });
    }
    return portOk({
      status: "advanced",
      recordId: record.id,
      phase: "failed",
      warnings,
    });
  }

  // -------------------------------------------------------------------------
  // Step D: rollback — reobserve ownership, restore prior, prove restoration.
  // -------------------------------------------------------------------------

  private async persistRollbackIntent(
    record: ReleaseRecordV1,
    context: LoadedContextV1,
    warnings: string[],
  ): Promise<PortResultV1<ReleaseCycleResultV1>> {
    const intent: ReleaseIntentV1 = {
      action: "rollback",
      key: `rollback/${record.id}/${record.prior.identity.revisionId}`,
      persistedAt: this.clock.now(),
    };
    const updated = parseReleaseRecordV1({
      ...record,
      intent,
      updatedAt: this.clock.now(),
    });
    const write = await this.writeSnapshot(context, updated);
    if (!write) {
      return portOk({ status: "conflict", recordId: record.id, warnings: [] });
    }
    void warnings;
    return this.rollbackRecord(updated, context);
  }

  private async rollbackRecord(
    record: ReleaseRecordV1,
    context: LoadedContextV1,
  ): Promise<PortResultV1<ReleaseCycleResultV1>> {
    // Reobserve actual candidate ownership before every rollback attempt.
    const observed = await this.observeManaged();
    if (observed.status === "error" || observed.sample.identity === null) {
      return this.blocked(record.id, "rollback ownership cannot be observed");
    }
    const identity = observed.sample.identity;
    if (sameIdentity(identity, record.prior.identity)) {
      return this.finalizeRolledBack(record, context, {
        action: "rollback",
        ok: true,
        statusCode: null,
        observedIdentity: record.prior.identity,
        observedDomain: this.target.acceptance.domain,
        at: this.clock.now(),
        detail: "deployment already served the prior identity",
      });
    }
    if (!sameIdentity(identity, record.candidate.identity)) {
      // An unrelated newer deployment is current: block, never roll it back.
      const failed = parseReleaseRecordV1({
        ...record,
        phase: "failed",
        receipts: {
          ...record.receipts,
          error: makeError(this.clock.now(), "unrelated_newer_deployment"),
        },
        updatedAt: this.clock.now(),
      });
      const write = await this.writeSnapshot(context, failed);
      if (!write) {
        return portOk({
          status: "conflict",
          recordId: record.id,
          warnings: [],
        });
      }
      return portOk({
        status: "advanced",
        recordId: record.id,
        phase: "failed",
        warnings: [],
      });
    }

    const outcome = await this.deno.promote({
      projectId: this.target.projectId,
      identity: record.prior.identity,
    });
    if (!outcome.ok) {
      return this.blocked(record.id, "rollback request failed");
    }
    if (outcome.value.outcome !== "promoted") {
      return this.persistRollbackReceipt(record, context, {
        action: "rollback",
        ok: false,
        statusCode: outcome.value.statusCode,
        observedIdentity: identity,
        observedDomain: this.target.acceptance.domain,
        at: this.clock.now(),
        detail: outcome.value.outcome === "rejected"
          ? "rollback was rejected"
          : "rollback outcome is ambiguous",
      });
    }
    // 204: prove restoration on the managed domain.
    const proof = await this.proveManaged(record.prior.identity);
    if (
      proof.status === "error" ||
      proof.sample.identity === null ||
      proof.sample.status !== "healthy"
    ) {
      return this.persistRollbackReceipt(record, context, {
        action: "rollback",
        ok: false,
        statusCode: 204,
        observedIdentity: proof.status === "error"
          ? null
          : proof.sample.identity,
        observedDomain: this.target.acceptance.domain,
        at: this.clock.now(),
        detail: "restoration proof not yet observed",
      });
    }
    return this.finalizeRolledBack(record, context, {
      action: "rollback",
      ok: true,
      statusCode: 204,
      observedIdentity: record.prior.identity,
      observedDomain: this.target.acceptance.domain,
      at: this.clock.now(),
      detail: null,
    });
  }

  private persistRollbackReceipt(
    record: ReleaseRecordV1,
    context: LoadedContextV1,
    receipt: ReleaseReceiptV1,
  ): Promise<PortResultV1<ReleaseCycleResultV1>> {
    const updated = parseReleaseRecordV1({
      ...record,
      receipts: { ...record.receipts, rollback: receipt },
      updatedAt: this.clock.now(),
    });
    return this.persistAndReport(updated, context, "monitoring");
  }

  private async finalizeRolledBack(
    record: ReleaseRecordV1,
    context: LoadedContextV1,
    receipt: ReleaseReceiptV1,
  ): Promise<PortResultV1<ReleaseCycleResultV1>> {
    const restored = parseReleaseRecordV1({
      ...record,
      phase: "rolled_back",
      observed: {
        identity: record.prior.identity,
        domain: this.target.acceptance.domain,
        verified: true,
        at: this.clock.now(),
      },
      receipts: { ...record.receipts, rollback: receipt },
      updatedAt: this.clock.now(),
    });
    const write = await this.writeSnapshot(context, restored);
    if (!write) {
      return portOk({ status: "conflict", recordId: record.id, warnings: [] });
    }
    return portOk({
      status: "advanced",
      recordId: record.id,
      phase: "rolled_back",
      warnings: [],
    });
  }

  // -------------------------------------------------------------------------
  // Health probes.
  // -------------------------------------------------------------------------

  /** Identity-only observation: static headers, exact identity in the sample. */
  private identityHealthConfig(): HealthSampleConfigV1 {
    return {
      baseUrl: this.target.managedBaseUrl,
      healthPath: this.target.acceptance.healthPath,
      managedBodyMarker: this.target.acceptance.managedBodyMarker,
      managedHeaders: [...this.target.acceptance.managedHeaders],
      domain: null,
    };
  }

  /** Identity proof: expected identity headers must match exactly. */
  private proofHealthConfig(
    expected: DeploymentIdentityV1,
  ): HealthSampleConfigV1 {
    return {
      baseUrl: this.target.managedBaseUrl,
      healthPath: this.target.acceptance.healthPath,
      managedBodyMarker: this.target.acceptance.managedBodyMarker,
      managedHeaders: [
        ...this.target.acceptance.managedHeaders,
        {
          name: this.target.identityHeaders.gitSha,
          value: expected.gitSha,
        },
        {
          name: this.target.identityHeaders.revisionId,
          value: expected.revisionId,
        },
      ],
      domain: null,
    };
  }

  private async observeManaged(): Promise<
    { status: "ok"; sample: HealthSampleV1 } | { status: "error" }
  > {
    const result = await this.deno.sampleHealth(this.identityHealthConfig());
    if (!result.ok) return { status: "error" };
    return { status: "ok", sample: result.value };
  }

  private async proveManaged(
    expected: DeploymentIdentityV1,
  ): Promise<
    { status: "ok"; sample: HealthSampleV1 } | { status: "error" }
  > {
    const result = await this.deno.sampleHealth(
      this.proofHealthConfig(expected),
    );
    if (!result.ok) return { status: "error" };
    return { status: "ok", sample: result.value };
  }

  /**
   * Custom-domain probe after the managed identity passed. 200 with exact
   * identity is clean; a 200 without a fully healthy body/header validation,
   * or with a different identity, is a hard identity failure; a VERIFIED
   * Cloudflare 403 challenge (the target's identified warning exception) is a
   * warning only; every other failure (unverified 403, other non-200,
   * unobservable gateway) blocks acceptance.
   */
  private async probeCustom(
    expected: DeploymentIdentityV1,
  ): Promise<
    | { status: "ok" }
    | { status: "hard-fail" }
    | { status: "warned"; warnings: string[] }
    | { status: "blocked"; detail: string }
    | null
  > {
    if (this.target.customBaseUrl === null) return null;
    const result = await this.deno.sampleHealth({
      baseUrl: this.target.customBaseUrl,
      healthPath: this.target.acceptance.healthPath,
      managedBodyMarker: this.target.acceptance.managedBodyMarker,
      managedHeaders: [
        ...this.target.acceptance.managedHeaders,
        {
          name: this.target.identityHeaders.gitSha,
          value: expected.gitSha,
        },
        {
          name: this.target.identityHeaders.revisionId,
          value: expected.revisionId,
        },
      ],
      domain: this.target.acceptance.domain,
    });
    if (!result.ok) {
      return {
        status: "blocked",
        detail: "custom gateway probe is unavailable",
      };
    }
    const sample = result.value;
    if (sample.httpStatus === 200) {
      if (
        sample.status !== "healthy" || sample.identity === null ||
        !sameIdentity(sample.identity, expected)
      ) {
        return { status: "hard-fail" };
      }
      return { status: "ok" };
    }
    if (sample.httpStatus === 403 && sample.headersMatch === true) {
      // The target's identified exception: a verified Cloudflare Bot Fight
      // Mode challenge on the gateway runner, never a deployment mismatch.
      return {
        status: "warned",
        warnings: [
          "custom gateway returns a verified Cloudflare-identified 403",
        ],
      };
    }
    return {
      status: "blocked",
      detail: "custom gateway identity cannot be verified",
    };
  }

  // -------------------------------------------------------------------------
  // State writes: strict expected-head CAS via the release writer.
  // -------------------------------------------------------------------------

  private async writeSnapshot(
    context: LoadedContextV1,
    updated: ReleaseRecordV1,
  ): Promise<boolean> {
    const read = await this.stateRead.readRelease();
    if (!read.ok) return false;
    if (read.value.status !== "found") {
      if (context.releaseHead !== null) return false;
    } else if (read.value.head !== this.expectedHead) {
      return false;
    }
    const priorSnapshot: ReleaseStateSnapshotV1 = read.value.status === "found"
      ? read.value.snapshot
      : {
        version: "v1",
        kind: "release_state_snapshot",
        stateHead: null,
        sequence: 0,
        updatedAt: this.clock.now(),
        releases: [],
      };
    const nextRecords = priorSnapshot.releases
      .filter((record) => record.id !== updated.id)
      .concat([updated]);
    const next: ReleaseStateSnapshotV1 = {
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: read.value.status === "found" ? read.value.head : null,
      sequence: priorSnapshot.sequence + 1,
      updatedAt: this.clock.now(),
      releases: nextRecords,
    };
    const expectedHead = read.value.status === "found" ? read.value.head : null;
    const write = await this.stateWrite.writeRelease(next, expectedHead);
    if (!write.ok || write.value.status !== "applied") return false;
    this.expectedHead = write.value.head;
    return true;
  }

  private async persistAndReport(
    updated: ReleaseRecordV1,
    context: LoadedContextV1,
    phase: ReleasePhaseV1,
  ): Promise<PortResultV1<ReleaseCycleResultV1>> {
    const write = await this.writeSnapshot(context, updated);
    if (!write) {
      return portOk({ status: "conflict", recordId: updated.id, warnings: [] });
    }
    return portOk({
      status: "persisted",
      recordId: updated.id,
      phase,
      warnings: [],
    });
  }

  private blocked(
    recordId: string | null,
    detail: string,
  ): PortResultV1<ReleaseCycleResultV1> {
    return portOk({ status: "blocked", recordId, detail, warnings: [] });
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function sameIdentity(
  a: DeploymentIdentityV1,
  b: DeploymentIdentityV1,
): boolean {
  return a.gitSha === b.gitSha && a.revisionId === b.revisionId;
}

function sameRepository(
  a: RepositoryIdentityV1,
  b: RepositoryIdentityV1,
): boolean {
  return a.owner === b.owner && a.name === b.name &&
    a.installationId === b.installationId;
}

function isTerminalPhase(phase: ReleasePhaseV1): boolean {
  return phase === "accepted" || phase === "rolled_back" || phase === "failed";
}

function completeSample(sample: MetricsSampleV1): boolean {
  return sample.coverage.status === "complete" &&
    sample.requestCount !== null;
}

function buildDiagnosticAcceptance(
  identity: DeploymentIdentityV1,
  policy: StabilityPolicyV1,
  baseline: MetricsSampleV1[],
  samples: MetricsSampleV1[],
): AcceptanceResultV1 | null {
  if (samples.length === 0) return null;
  const evaluation = evaluateAcceptance(policy, baseline, samples);
  return buildAcceptanceResult(
    identity,
    baseline,
    samples,
    evaluation,
  );
}

function makeError(at: number, kind: string): ReleaseErrorV1 {
  const rule = ERROR_RULES[kind] ?? {
    detail: "release recorded a failure",
    recovered: false,
  };
  return {
    at,
    kind,
    detail: rule.detail,
    recovered: rule.recovered,
  };
}
