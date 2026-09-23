/**
 * Owner-authorized development installation: the pure planning and
 * serialization boundary only. These tests build parsed release snapshots with
 * the real contract parsers and assert the fixed one-shot decisions, the exact
 * intended snapshot movement and the canonical state-file bytes. No store,
 * network, Git write, model, credential or paid call is touched.
 */
import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { parseGitHubCooldownV1 } from "../../src/contracts/github-cooldown.ts";
import type { GitHubCooldownV1 } from "../../src/contracts/github-cooldown.ts";
import {
  HOSTED_RUNTIME_ID,
  parseHostedExecutionIntentV1,
  parseHostedNotStartedProofV1,
  parseHostedReleaseRecordV1,
  parseHostedRunProofV1,
  parseHostedRuntimeRecordV1,
} from "../../src/contracts/hosted-supervisor.ts";
import type {
  HostedExecutionPurposeV1,
  HostedNotStartedProofV1,
  HostedReleaseRecordV1,
  HostedRunProofV1,
  HostedRuntimeRecordV1,
} from "../../src/contracts/hosted-supervisor.ts";
import { parseReleaseRequestV1 } from "../../src/contracts/release.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  buildOwnerDevelopmentInstallSnapshot,
  OWNER_DEVELOPMENT_INSTALL_ADVANCE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_AGGREGATE_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_AGGREGATE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_APP_IDENTITY_REVISION,
  OWNER_DEVELOPMENT_INSTALL_CADENCE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_CANDIDATE_AUTH_REVISION,
  OWNER_DEVELOPMENT_INSTALL_DELIVERED_ROUND2_REVISION,
  OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_REVISION,
  OWNER_DEVELOPMENT_INSTALL_FINDINGS_REVISION,
  OWNER_DEVELOPMENT_INSTALL_FOREIGN_AUTH_REVISION,
  OWNER_DEVELOPMENT_INSTALL_GUARD_REVISION,
  OWNER_DEVELOPMENT_INSTALL_HISTORY_REVISION,
  OWNER_DEVELOPMENT_INSTALL_LEDGER_REVISION,
  OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_MULTI_TARGET_REVISION,
  OWNER_DEVELOPMENT_INSTALL_ORIGINAL_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_ORIGINAL_REVISION,
  OWNER_DEVELOPMENT_INSTALL_PRESERVE_SCOPE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_READER_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_READER_REVISION,
  OWNER_DEVELOPMENT_INSTALL_REASON_CODE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_RECEIPT_REVISION,
  OWNER_DEVELOPMENT_INSTALL_RECOVERY_REVISION,
  OWNER_DEVELOPMENT_INSTALL_RELEASED_REVISION,
  OWNER_DEVELOPMENT_INSTALL_RESERVE_MODEL_REVISION,
  OWNER_DEVELOPMENT_INSTALL_RETIRE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_REVISION,
  OWNER_DEVELOPMENT_INSTALL_REVIEWER_REVISION,
  OWNER_DEVELOPMENT_INSTALL_ROUND8_REVISION,
  OWNER_DEVELOPMENT_INSTALL_SCOPE_GATE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_RECOVERY_REVISION,
  OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_REVISION,
  OWNER_DEVELOPMENT_INSTALL_TRIGGER_REVISION,
  ownerDevelopmentInstallCommitMessage,
  ownerDevelopmentInstallFiles,
  planOwnerDevelopmentInstall,
} from "../../src/host/owner-development-install.ts";

const T0 = 1_700_000_000_000;
const NOW = T0 + 10_000;
const LAUNCHER = "f".repeat(40) as GitSha;
const STATE_HEAD = "a".repeat(40) as GitSha;
const PRIOR_STATE_HEAD = "b".repeat(40) as GitSha;
const UNRELATED = "e".repeat(40) as GitSha;
const DIGEST = "d".repeat(64);

const ORIGINAL = OWNER_DEVELOPMENT_INSTALL_ORIGINAL_REVISION;
const READER = OWNER_DEVELOPMENT_INSTALL_READER_REVISION;
const AGGREGATE = OWNER_DEVELOPMENT_INSTALL_AGGREGATE_REVISION;
const RECOVERY = OWNER_DEVELOPMENT_INSTALL_RECOVERY_REVISION;
const REVIEW_STEP = OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_REVISION;
const REVIEWER = OWNER_DEVELOPMENT_INSTALL_REVIEWER_REVISION;
const EXIT_CONTRACT = OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_REVISION;
const ROUND8 = OWNER_DEVELOPMENT_INSTALL_ROUND8_REVISION;
const FINDINGS = OWNER_DEVELOPMENT_INSTALL_FINDINGS_REVISION;
const HISTORY = OWNER_DEVELOPMENT_INSTALL_HISTORY_REVISION;
const RECEIPT = OWNER_DEVELOPMENT_INSTALL_RECEIPT_REVISION;
const LEDGER = OWNER_DEVELOPMENT_INSTALL_LEDGER_REVISION;
const SETTLEMENT = OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_REVISION;
const RELEASED = OWNER_DEVELOPMENT_INSTALL_RELEASED_REVISION;
const TRIGGER = OWNER_DEVELOPMENT_INSTALL_TRIGGER_REVISION;
const ADVANCE = OWNER_DEVELOPMENT_INSTALL_ADVANCE_REVISION;
const CADENCE = OWNER_DEVELOPMENT_INSTALL_CADENCE_REVISION;
const GUARD = OWNER_DEVELOPMENT_INSTALL_GUARD_REVISION;
const RETIRE = OWNER_DEVELOPMENT_INSTALL_RETIRE_REVISION;
const DELIVERED_ROUND2 = OWNER_DEVELOPMENT_INSTALL_DELIVERED_ROUND2_REVISION;
const APP_IDENTITY = OWNER_DEVELOPMENT_INSTALL_APP_IDENTITY_REVISION;
const MODEL_ROUTE = OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_REVISION;
const RESERVE_MODEL = OWNER_DEVELOPMENT_INSTALL_RESERVE_MODEL_REVISION;
const MULTI_TARGET = OWNER_DEVELOPMENT_INSTALL_MULTI_TARGET_REVISION;
const SCOPE_GATE = OWNER_DEVELOPMENT_INSTALL_SCOPE_GATE_REVISION;
const CANDIDATE_AUTH = OWNER_DEVELOPMENT_INSTALL_CANDIDATE_AUTH_REVISION;
const PRESERVE_SCOPE = OWNER_DEVELOPMENT_INSTALL_PRESERVE_SCOPE_REVISION;
const FOREIGN_AUTH = OWNER_DEVELOPMENT_INSTALL_FOREIGN_AUTH_REVISION;
const REASON_CODE = OWNER_DEVELOPMENT_INSTALL_REASON_CODE_REVISION;
const SETTLEMENT_RECOVERY =
  OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_RECOVERY_REVISION;
// The quiet-reasoning pins stay test-local exact literals: this suite must also
// compile against pre-rung production source, where the newly exported
// constants do not exist, so the expected red is a semantic plan mismatch and
// never a missing import.
const QUIET_REASONING = "db16f8af810ee24f434938a3e9dd17c04c3e8084" as GitSha;
const QUIET_REASONING_GENERATION = 35;
// The base-fetch pins stay test-local exact literals for the same reason: this
// suite must compile against pre-rung production source, so the expected red is
// a semantic plan mismatch and never a missing import.
const BASE_FETCH = "ae4629faeb75a80c1badf1ff37a58c8be00adf99" as GitSha;
const BASE_FETCH_GENERATION = 36;
// The review-model pins stay test-local exact literals for the same reason: this
// suite must compile against pre-rung production source, so the expected red is
// a semantic plan mismatch and never a missing import.
const REVIEW_MODEL = "59940aece2d051b79c8e2e8ab7c611a0d45600b2" as GitSha;
const REVIEW_MODEL_GENERATION = 37;
// The successor install pin stays a test-local exact literal for the same
// reason: this suite must compile against pre-rung production source, so the
// expected red is a semantic plan mismatch and never a missing import.
const SUCCESSOR_REVISION = "3b6d3736e353ccfdb6da2902bb5be4184335803d" as GitSha;
const SUCCESSOR_GENERATION = 38;
// The publish-gate install pin stays a test-local exact literal for the same
// reason: this suite must compile against pre-rung production source, so the
// expected red is a semantic plan mismatch and never a missing import.
const PUBLISH_GATE_REVISION =
  "b022ec2fd554254aa7f0e9333d7faf2b09a99a68" as GitSha;
const PUBLISH_GATE_GENERATION = 39;
// The closing-keyword install pin stays a test-local exact literal for the
// same reason: this suite must compile against pre-rung production source, so
// the expected red is a semantic plan mismatch and never a missing import.
const CLOSING_KEYWORD_REVISION =
  "5e2a828420150f46631ea4b0f96a989307b74bdb" as GitSha;
const CLOSING_KEYWORD_GENERATION = 40;
// The candidate-loss install pin stays a test-local exact literal for the same
// reason: this suite must compile against pre-rung production source, so the
// expected red is a semantic plan mismatch and never a missing import.
const CANDIDATE_LOSS_REVISION =
  "09d2efbe962dec3e2f64ed45e76bc05ecbac0ab5" as GitSha;
const CANDIDATE_LOSS_GENERATION = 41;
// The closed-PR install pin stays a test-local exact literal for the same
// reason: this suite must compile against pre-rung production source, so the
// expected red is a semantic plan mismatch and never a missing import.
const CLOSED_PR_REVISION = "58ae6135a01a0887e8f167b117c7d69420649dc1" as GitSha;
const CLOSED_PR_GENERATION = 42;
// The closed-PR head install pin stays a test-local exact literal for the same
// reason: this suite must compile against pre-rung production source, so the
// expected red is a semantic plan mismatch and never a missing import.
const CLOSED_PR_HEAD_REVISION =
  "a683d27e95a661e2cf7fba410f4a141257a659f3" as GitSha;
const CLOSED_PR_HEAD_GENERATION = 43;
// The assign-first install pin stays a test-local exact literal for the same
// reason: this suite must compile against pre-rung production source, so the
// expected red is a semantic plan mismatch and never a missing import.
const ASSIGN_FIRST_REVISION =
  "b58cce6d05d29ed493b60ae610b9950f3496386c" as GitSha;
const ASSIGN_FIRST_GENERATION = 44;
// The review-phase PR install pin stays a test-local exact literal for the
// same reason: this suite must compile against pre-rung production source, so
// the expected red is a semantic plan mismatch and never a missing import.
const REVIEW_PHASE_PR_REVISION =
  "529c2d3b81cf66f66d46d6c4cb1a573b3b4ba603" as GitSha;
const REVIEW_PHASE_PR_GENERATION = 45;

function hostedProof(input: {
  runId: number;
  purpose: HostedExecutionPurposeV1;
  releaseId: string | null;
  revision: GitSha;
  generation: number;
  outcome: "healthy" | "failed";
}): HostedRunProofV1 {
  const failed = input.outcome === "failed";
  return parseHostedRunProofV1({
    execution: parseHostedExecutionIntentV1({
      id: `${input.runId}:1:repair`,
      runId: input.runId,
      runAttempt: 1,
      launcherSha: LAUNCHER,
      purpose: input.purpose,
      revision: input.revision,
      generation: input.generation,
      releaseId: input.releaseId,
      createdAt: T0,
    }),
    workflowId: 357012162,
    workflowPath: ".github/workflows/supervisor.yml",
    repository: "ubiquity/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    jobId: 9,
    startedAt: T0 + 1000,
    finishedAt: T0 + 2000,
    observedAt: T0 + 3000,
    outcome: input.outcome,
    startupReady: !failed,
    settled: true,
    baseSha: failed ? null : input.revision,
    terminalAt: failed ? null : T0 + 1500,
    logDigest: DIGEST,
  });
}

function healthyProof(
  revision: GitSha,
  generation: number,
  runId = 31,
): HostedRunProofV1 {
  return hostedProof({
    runId,
    purpose: "ordinary",
    releaseId: null,
    revision,
    generation,
    outcome: "healthy",
  });
}

function failedProof(
  revision: GitSha,
  generation: number,
  runId = 32,
): HostedRunProofV1 {
  return hostedProof({
    runId,
    purpose: "ordinary",
    releaseId: null,
    revision,
    generation,
    outcome: "failed",
  });
}

function notStartedProof(
  revision: GitSha,
  generation: number,
): HostedNotStartedProofV1 {
  return parseHostedNotStartedProofV1({
    execution: parseHostedExecutionIntentV1({
      id: "33:1:repair",
      runId: 33,
      runAttempt: 1,
      launcherSha: LAUNCHER,
      purpose: "ordinary",
      revision,
      generation,
      releaseId: null,
      createdAt: T0,
    }),
    workflowId: 357012162,
    workflowPath: ".github/workflows/supervisor.yml",
    repository: "ubiquity/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    jobId: 9,
    finishedAt: T0 + 2000,
    observedAt: T0 + 3000,
    outcome: "not_started",
    evidenceDigest: DIGEST,
  });
}

function executionIntent(
  revision: GitSha,
  generation: number,
): HostedRuntimeRecordV1["execution"] {
  return parseHostedExecutionIntentV1({
    id: "34:1:repair",
    runId: 34,
    runAttempt: 1,
    launcherSha: LAUNCHER,
    purpose: "ordinary",
    revision,
    generation,
    releaseId: null,
    createdAt: T0,
  });
}

function runtimeRecord(input: {
  revision: GitSha;
  generation: number;
  healthyProof?: HostedRunProofV1 | null;
  executionProof?: HostedRuntimeRecordV1["lastExecutionProof"];
  execution?: HostedRuntimeRecordV1["execution"];
}): HostedRuntimeRecordV1 {
  return parseHostedRuntimeRecordV1({
    version: "v1",
    kind: "hosted_runtime",
    id: HOSTED_RUNTIME_ID,
    activeRevision: input.revision,
    generation: input.generation,
    lastHealthyProof: input.healthyProof ?? null,
    lastExecutionProof: input.executionProof ?? null,
    nextOrdinaryAt: T0,
    execution: input.execution ?? null,
    createdAt: T0,
    updatedAt: T0 + 3000,
  });
}

function cooldown(retryNotBefore: number | null): GitHubCooldownV1 {
  return parseGitHubCooldownV1({
    installationId: 0,
    retryNotBefore,
    observedAt: T0,
    observationId: DIGEST,
    secondaryBackoff: 0,
  });
}

function releaseSnapshot(input: {
  runtime?: HostedRuntimeRecordV1 | null;
  hostedReleases?: HostedReleaseRecordV1[];
  cooldowns?: GitHubCooldownV1[];
  sequence?: number;
}): ReleaseStateSnapshotV1 {
  return parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: PRIOR_STATE_HEAD,
    sequence: input.sequence ?? 10,
    updatedAt: T0 + 3000,
    releases: [],
    hostedRuntimes: input.runtime === undefined || input.runtime === null
      ? []
      : [input.runtime],
    hostedReleases: input.hostedReleases ?? [],
    githubCooldowns: input.cooldowns ?? [],
  });
}

function releaseRequest() {
  return parseReleaseRequestV1({
    version: "v1",
    kind: "release_request",
    id: "release-1",
    target: {
      repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
      environment: "production",
    },
    revision: AGGREGATE,
    source: {
      pullRequest: 1,
      reviewRequestId: "review-request-1",
      reviewReceiptId: "review-receipt-1",
      head: AGGREGATE,
      base: ORIGINAL,
    },
    status: "open",
    failureReason: null,
    createdAt: T0 - 3000,
  });
}

function requestedRelease(): HostedReleaseRecordV1 {
  return parseHostedReleaseRecordV1({
    version: "v1",
    kind: "hosted_release",
    id: "release-1",
    request: releaseRequest(),
    priorRevision: ORIGINAL,
    phase: "requested",
    priorProof: null,
    candidateProof: null,
    rollbackProof: null,
    pointerIntent: null,
    createdAt: T0 - 2000,
    updatedAt: T0,
  });
}

function acceptedRelease(): HostedReleaseRecordV1 {
  return parseHostedReleaseRecordV1({
    version: "v1",
    kind: "hosted_release",
    id: "release-1",
    request: releaseRequest(),
    priorRevision: ORIGINAL,
    phase: "accepted",
    priorProof: hostedProof({
      runId: 41,
      purpose: "prior",
      releaseId: "release-1",
      revision: ORIGINAL,
      generation: OWNER_DEVELOPMENT_INSTALL_ORIGINAL_GENERATION,
      outcome: "healthy",
    }),
    candidateProof: hostedProof({
      runId: 42,
      purpose: "candidate",
      releaseId: "release-1",
      revision: AGGREGATE,
      generation: OWNER_DEVELOPMENT_INSTALL_AGGREGATE_GENERATION,
      outcome: "healthy",
    }),
    rollbackProof: null,
    pointerIntent: null,
    createdAt: T0 - 2000,
    updatedAt: T0 + 3000,
  });
}

async function rawSha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

Deno.test(
  "owner development install plan: original generation 5 installs the reader only with its exact healthy proof",
  () => {
    const proof = healthyProof(ORIGINAL, 5, 51);
    const ready = releaseSnapshot({
      runtime: runtimeRecord({
        revision: ORIGINAL,
        generation: 5,
        healthyProof: proof,
        executionProof: proof,
      }),
    });
    const plan = planOwnerDevelopmentInstall(ready, NOW);
    assert.equal(plan.status, "install");
    if (plan.status !== "install") throw new Error("expected install");
    assert.equal(plan.move.action, "install");
    assert.equal(plan.move.priorRevision, ORIGINAL);
    assert.equal(plan.move.priorGeneration, 5);
    assert.equal(plan.move.nextRevision, READER);
    assert.equal(plan.move.nextGeneration, 6);
    assert.equal(
      plan.move.nextGeneration,
      OWNER_DEVELOPMENT_INSTALL_READER_GENERATION,
    );
    assert.equal(plan.move.nextGeneration, plan.move.priorGeneration + 1);
    assert.equal(
      canonicalStringify(plan.move.priorHealthyProof),
      canonicalStringify(proof),
    );

    // Missing, unrelated and stale healthy proofs are zero-write waits.
    const waits = [
      releaseSnapshot({
        runtime: runtimeRecord({ revision: ORIGINAL, generation: 5 }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: ORIGINAL,
          generation: 5,
          healthyProof: healthyProof(READER, 6, 52),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: ORIGINAL,
          generation: 5,
          healthyProof: healthyProof(ORIGINAL, 4, 53),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: ORIGINAL,
          generation: 5,
          healthyProof: healthyProof(UNRELATED, 5, 54),
        }),
      }),
    ];
    for (const state of waits) {
      assert.equal(planOwnerDevelopmentInstall(state, NOW).status, "waiting");
    }
  },
);

Deno.test(
  "owner development install plan: in-flight execution, active release and active cooldown wait",
  () => {
    const proof = healthyProof(ORIGINAL, 5, 55);
    const runtime = runtimeRecord({
      revision: ORIGINAL,
      generation: 5,
      healthyProof: proof,
      executionProof: proof,
    });
    const inFlight = releaseSnapshot({
      runtime: runtimeRecord({
        revision: ORIGINAL,
        generation: 5,
        healthyProof: proof,
        executionProof: proof,
        execution: executionIntent(ORIGINAL, 5),
      }),
    });
    assert.equal(planOwnerDevelopmentInstall(inFlight, NOW).status, "waiting");

    const activeRelease = releaseSnapshot({
      runtime,
      hostedReleases: [requestedRelease()],
    });
    assert.equal(
      planOwnerDevelopmentInstall(activeRelease, NOW).status,
      "waiting",
    );

    const activeCooldown = releaseSnapshot({
      runtime,
      cooldowns: [cooldown(NOW + 60_000)],
    });
    assert.equal(
      planOwnerDevelopmentInstall(activeCooldown, NOW).status,
      "waiting",
    );

    // An expired cooldown is history, not a recurring global stop.
    const expiredCooldown = releaseSnapshot({
      runtime,
      cooldowns: [cooldown(NOW - 1)],
    });
    assert.equal(
      planOwnerDevelopmentInstall(expiredCooldown, NOW).status,
      "install",
    );
  },
);

Deno.test(
  "owner development install plan: reader generation 6 installs the aggregate only after its exact fresh healthy proof",
  () => {
    const proof = healthyProof(READER, 6, 56);
    const ready = releaseSnapshot({
      runtime: runtimeRecord({
        revision: READER,
        generation: 6,
        healthyProof: proof,
        executionProof: proof,
      }),
      hostedReleases: [acceptedRelease()],
    });
    const plan = planOwnerDevelopmentInstall(ready, NOW);
    assert.equal(plan.status, "install");
    if (plan.status !== "install") throw new Error("expected install");
    assert.equal(plan.move.priorRevision, READER);
    assert.equal(plan.move.priorGeneration, 6);
    assert.equal(plan.move.nextRevision, AGGREGATE);
    assert.equal(plan.move.nextGeneration, 7);

    const waits = [
      releaseSnapshot({
        runtime: runtimeRecord({ revision: READER, generation: 6 }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: READER,
          generation: 6,
          healthyProof: healthyProof(READER, 5, 57),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: READER,
          generation: 6,
          healthyProof: healthyProof(ORIGINAL, 5, 58),
        }),
      }),
    ];
    for (const state of waits) {
      assert.equal(planOwnerDevelopmentInstall(state, NOW).status, "waiting");
    }
  },
);

Deno.test(
  "owner development install plan: an exact failed candidate rolls back once only to its fixed recorded prior",
  () => {
    const originalHealthy = healthyProof(ORIGINAL, 5, 61);
    const readerHealthy = healthyProof(READER, 6, 62);

    const readerFailed = releaseSnapshot({
      runtime: runtimeRecord({
        revision: READER,
        generation: 6,
        healthyProof: originalHealthy,
        executionProof: failedProof(READER, 6, 63),
      }),
    });
    const readerPlan = planOwnerDevelopmentInstall(readerFailed, NOW);
    assert.equal(readerPlan.status, "rollback");
    if (readerPlan.status !== "rollback") throw new Error("expected rollback");
    assert.equal(readerPlan.move.priorRevision, READER);
    assert.equal(readerPlan.move.priorGeneration, 6);
    assert.equal(readerPlan.move.nextRevision, ORIGINAL);
    assert.equal(readerPlan.move.nextGeneration, 7);
    assert.equal(
      canonicalStringify(readerPlan.move.priorHealthyProof),
      canonicalStringify(originalHealthy),
    );

    const aggregateFailed = releaseSnapshot({
      runtime: runtimeRecord({
        revision: AGGREGATE,
        generation: 7,
        healthyProof: readerHealthy,
        executionProof: failedProof(AGGREGATE, 7, 64),
      }),
    });
    const aggregatePlan = planOwnerDevelopmentInstall(aggregateFailed, NOW);
    assert.equal(aggregatePlan.status, "rollback");
    if (aggregatePlan.status !== "rollback") {
      throw new Error("expected rollback");
    }
    assert.equal(aggregatePlan.move.nextRevision, READER);
    assert.equal(aggregatePlan.move.nextGeneration, 8);
    assert.equal(
      canonicalStringify(aggregatePlan.move.priorHealthyProof),
      canonicalStringify(readerHealthy),
    );

    // Failures that do not bind the exact pointer, a missing recorded prior
    // and a no-execution settlement never roll back.
    const waits = [
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: READER,
          generation: 6,
          healthyProof: originalHealthy,
          executionProof: failedProof(READER, 5, 65),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: READER,
          generation: 6,
          healthyProof: originalHealthy,
          executionProof: failedProof(UNRELATED, 6, 66),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: READER,
          generation: 6,
          executionProof: failedProof(READER, 6, 67),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: READER,
          generation: 6,
          healthyProof: originalHealthy,
          executionProof: notStartedProof(READER, 6),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: UNRELATED,
          generation: 9,
          executionProof: failedProof(UNRELATED, 9, 68),
        }),
      }),
    ];
    for (const state of waits) {
      const plan = planOwnerDevelopmentInstall(state, NOW);
      assert.notEqual(plan.status, "rollback");
    }
    assert.equal(
      planOwnerDevelopmentInstall(waits[0], NOW).status,
      "waiting",
    );
    assert.equal(
      planOwnerDevelopmentInstall(waits[1], NOW).status,
      "waiting",
    );
    assert.equal(
      planOwnerDevelopmentInstall(waits[2], NOW).status,
      "waiting",
    );
    assert.equal(
      planOwnerDevelopmentInstall(waits[3], NOW).status,
      "waiting",
    );
    assert.equal(
      planOwnerDevelopmentInstall(waits[4], NOW).status,
      "no_change",
    );
  },
);

Deno.test(
  "owner development install plan: completed and unrelated pointers do nothing",
  () => {
    const originalHealthy = healthyProof(ORIGINAL, 5, 71);
    const readerHealthy = healthyProof(READER, 6, 72);
    const aggregateHealthy = healthyProof(AGGREGATE, 7, 73);

    // Post-rollback targets never reattempt installation.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: ORIGINAL,
            generation: 7,
            healthyProof: originalHealthy,
          }),
        }),
        NOW,
      ).status,
      "no_change",
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: READER,
            generation: 8,
            healthyProof: readerHealthy,
          }),
        }),
        NOW,
      ).status,
      "no_change",
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: AGGREGATE,
            generation: 7,
            healthyProof: aggregateHealthy,
          }),
        }),
        NOW,
      ).status,
      "install",
      "the aggregate healthy proof authorizes the review recovery install",
    );
    // The review recovery healthy proof authorizes the review-step install.
    const recoveryHealthy = healthyProof(RECOVERY, 8, 75);
    const reviewStepPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: RECOVERY,
          generation: 8,
          healthyProof: recoveryHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(reviewStepPlan.status, "install");
    if (reviewStepPlan.status !== "install") {
      throw new Error("expected install");
    }
    assert.equal(reviewStepPlan.move.nextRevision, REVIEW_STEP);
    assert.equal(reviewStepPlan.move.nextGeneration, 9);
    // The review-step healthy proof authorizes the reviewer provenance install.
    const reviewStepHealthy = healthyProof(REVIEW_STEP, 9, 78);
    const reviewerPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REVIEW_STEP,
          generation: 9,
          healthyProof: reviewStepHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(reviewerPlan.status, "install");
    if (reviewerPlan.status !== "install") throw new Error("expected install");
    assert.equal(reviewerPlan.move.nextRevision, REVIEWER);
    assert.equal(reviewerPlan.move.nextGeneration, 10);
    // The reviewer healthy proof authorizes the exit-contract install.
    const reviewerHealthy = healthyProof(REVIEWER, 10, 79);
    const exitPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REVIEWER,
          generation: 10,
          healthyProof: reviewerHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(exitPlan.status, "install");
    if (exitPlan.status !== "install") throw new Error("expected install");
    assert.equal(exitPlan.move.nextRevision, EXIT_CONTRACT);
    assert.equal(exitPlan.move.nextGeneration, 11);
    // The exit-contract healthy proof authorizes the corrected-grant install.
    const exitHealthy = healthyProof(EXIT_CONTRACT, 11, 81);
    const round8Plan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: EXIT_CONTRACT,
          generation: 11,
          healthyProof: exitHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(round8Plan.status, "install");
    if (round8Plan.status !== "install") throw new Error("expected install");
    assert.equal(round8Plan.move.nextRevision, ROUND8);
    assert.equal(round8Plan.move.nextGeneration, 12);
    // The corrected-grant healthy proof authorizes the findings install.
    const round8Healthy = healthyProof(ROUND8, 12, 83);
    const findingsPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: ROUND8,
          generation: 12,
          healthyProof: round8Healthy,
        }),
      }),
      NOW,
    );
    assert.equal(findingsPlan.status, "install");
    if (findingsPlan.status !== "install") throw new Error("expected install");
    assert.equal(findingsPlan.move.nextRevision, FINDINGS);
    assert.equal(findingsPlan.move.nextGeneration, 13);
    // The findings healthy proof authorizes the rejection-history install.
    const findingsHealthy = healthyProof(FINDINGS, 13, 84);
    const historyPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: FINDINGS,
          generation: 13,
          healthyProof: findingsHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(historyPlan.status, "install");
    if (historyPlan.status !== "install") throw new Error("expected install");
    assert.equal(historyPlan.move.nextRevision, HISTORY);
    assert.equal(historyPlan.move.nextGeneration, 14);
    // The rejection-history healthy proof authorizes the receipt install.
    const historyHealthy = healthyProof(HISTORY, 14, 85);
    const receiptPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: HISTORY,
          generation: 14,
          healthyProof: historyHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(receiptPlan.status, "install");
    if (receiptPlan.status !== "install") throw new Error("expected install");
    assert.equal(receiptPlan.move.nextRevision, RECEIPT);
    assert.equal(receiptPlan.move.nextGeneration, 15);
    // The receipt-submission healthy proof authorizes the ledger install.
    const receiptHealthy = healthyProof(RECEIPT, 15, 86);
    const ledgerPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: RECEIPT,
          generation: 15,
          healthyProof: receiptHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(ledgerPlan.status, "install");
    if (ledgerPlan.status !== "install") throw new Error("expected install");
    assert.equal(ledgerPlan.move.nextRevision, LEDGER);
    assert.equal(ledgerPlan.move.nextGeneration, 16);
    // The ledger healthy proof authorizes the settlement install, and the
    // settlement generation is the fixed end of the chain.
    const ledgerHealthy = healthyProof(LEDGER, 16, 87);
    const settlementPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: LEDGER,
          generation: 16,
          healthyProof: ledgerHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(settlementPlan.status, "install");
    if (settlementPlan.status !== "install") {
      throw new Error("expected install");
    }
    assert.equal(settlementPlan.move.nextRevision, SETTLEMENT);
    assert.equal(settlementPlan.move.nextGeneration, 17);
    const settlementHealthy = healthyProof(SETTLEMENT, 17, 88);
    const triggerPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: SETTLEMENT,
          generation: 17,
          healthyProof: settlementHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(triggerPlan.status, "install");
    if (triggerPlan.status !== "install") throw new Error("expected install");
    assert.equal(triggerPlan.move.nextRevision, TRIGGER);
    assert.equal(triggerPlan.move.nextGeneration, 19);
    // The released generation the promotion accepted installs the same trigger.
    const releasedPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: RELEASED,
          generation: 18,
          healthyProof: healthyProof(RELEASED, 18, 89),
        }),
      }),
      NOW,
    );
    assert.equal(releasedPlan.status, "install");
    if (releasedPlan.status !== "install") throw new Error("expected install");
    assert.equal(releasedPlan.move.nextRevision, TRIGGER);
    assert.equal(releasedPlan.move.nextGeneration, 19);
    // The trigger healthy proof authorizes the base-advance install.
    const triggerHealthy = healthyProof(TRIGGER, 19, 90);
    const advancePlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: TRIGGER,
          generation: 19,
          healthyProof: triggerHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(advancePlan.status, "install");
    if (advancePlan.status !== "install") throw new Error("expected install");
    assert.equal(advancePlan.move.nextRevision, ADVANCE);
    assert.equal(advancePlan.move.nextGeneration, 20);
    // The base-advance healthy proof authorizes the cadence install.
    const advanceHealthy = healthyProof(ADVANCE, 20, 91);
    const cadencePlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: ADVANCE,
          generation: 20,
          healthyProof: advanceHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(cadencePlan.status, "install");
    if (cadencePlan.status !== "install") throw new Error("expected install");
    assert.equal(cadencePlan.move.nextRevision, CADENCE);
    assert.equal(cadencePlan.move.nextGeneration, 21);
    // The cadence healthy proof authorizes the guard install.
    const cadenceHealthy = healthyProof(CADENCE, 21, 92);
    const guardPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CADENCE,
          generation: 21,
          healthyProof: cadenceHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(guardPlan.status, "install");
    if (guardPlan.status !== "install") throw new Error("expected install");
    assert.equal(guardPlan.move.nextRevision, GUARD);
    assert.equal(guardPlan.move.nextGeneration, 22);
    // The guard healthy proof authorizes the retirement install.
    const guardHealthy = healthyProof(GUARD, 22, 93);
    const retirePlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: GUARD,
          generation: 22,
          healthyProof: guardHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(retirePlan.status, "install");
    if (retirePlan.status !== "install") throw new Error("expected install");
    assert.equal(retirePlan.move.nextRevision, RETIRE);
    assert.equal(retirePlan.move.nextGeneration, 23);
    // The retirement generation itself is a no-op (its install already ran).
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: RETIRE,
            generation: 23,
            healthyProof: healthyProof(RETIRE, 23, 94),
          }),
        }),
        NOW,
      ).status,
      "no_change",
    );
    // The delivered round-2 revision past the retirement link authorizes the
    // App identity install; its own healthy proof is the authority.
    const appPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: DELIVERED_ROUND2,
          generation: 24,
          healthyProof: healthyProof(DELIVERED_ROUND2, 24, 95),
        }),
      }),
      NOW,
    );
    assert.equal(appPlan.status, "install");
    if (appPlan.status !== "install") throw new Error("expected install");
    assert.equal(appPlan.move.nextRevision, APP_IDENTITY);
    assert.equal(appPlan.move.nextGeneration, 25);
    // The App identity healthy proof authorizes the model-route install.
    const routePlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: APP_IDENTITY,
          generation: 25,
          healthyProof: healthyProof(APP_IDENTITY, 25, 96),
        }),
      }),
      NOW,
    );
    assert.equal(routePlan.status, "install");
    if (routePlan.status !== "install") throw new Error("expected install");
    assert.equal(routePlan.move.nextRevision, MODEL_ROUTE);
    assert.equal(routePlan.move.nextGeneration, 26);
    // The model-route healthy proof authorizes the reserve-model install.
    const reservePlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: MODEL_ROUTE,
          generation: 26,
          healthyProof: healthyProof(MODEL_ROUTE, 26, 97),
        }),
      }),
      NOW,
    );
    assert.equal(reservePlan.status, "install");
    if (reservePlan.status !== "install") throw new Error("expected install");
    assert.equal(reservePlan.move.nextRevision, RESERVE_MODEL);
    assert.equal(reservePlan.move.nextGeneration, 27);
    // The reserve-model healthy proof authorizes the multi-target install.
    const multiTargetPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: RESERVE_MODEL,
          generation: 27,
          healthyProof: healthyProof(RESERVE_MODEL, 27, 98),
        }),
      }),
      NOW,
    );
    assert.equal(multiTargetPlan.status, "install");
    if (multiTargetPlan.status !== "install") {
      throw new Error("expected install");
    }
    assert.equal(multiTargetPlan.move.nextRevision, MULTI_TARGET);
    assert.equal(multiTargetPlan.move.nextGeneration, 28);
    // The multi-target healthy proof authorizes the scope-gate install.
    const scopeGatePlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: MULTI_TARGET,
          generation: 28,
          healthyProof: healthyProof(MULTI_TARGET, 28, 99),
        }),
      }),
      NOW,
    );
    assert.equal(scopeGatePlan.status, "install");
    if (scopeGatePlan.status !== "install") {
      throw new Error("expected install");
    }
    assert.equal(scopeGatePlan.move.nextRevision, SCOPE_GATE);
    assert.equal(scopeGatePlan.move.nextGeneration, 29);
    // The scope-gate healthy proof authorizes the target-scoped auth install.
    const authPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: SCOPE_GATE,
          generation: 29,
          healthyProof: healthyProof(SCOPE_GATE, 29, 100),
        }),
      }),
      NOW,
    );
    assert.equal(authPlan.status, "install");
    if (authPlan.status !== "install") throw new Error("expected install");
    assert.equal(authPlan.move.nextRevision, CANDIDATE_AUTH);
    assert.equal(authPlan.move.nextGeneration, 30);
    // The candidate-auth healthy proof authorizes the preservation-scope
    // install.
    const preservePlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CANDIDATE_AUTH,
          generation: 30,
          healthyProof: healthyProof(CANDIDATE_AUTH, 30, 101),
        }),
      }),
      NOW,
    );
    assert.equal(preservePlan.status, "install");
    if (preservePlan.status !== "install") throw new Error("expected install");
    assert.equal(preservePlan.move.nextRevision, PRESERVE_SCOPE);
    assert.equal(preservePlan.move.nextGeneration, 31);
    // The preserve-scope healthy proof authorizes the foreign-auth install.
    const auth2Plan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: PRESERVE_SCOPE,
          generation: 31,
          healthyProof: healthyProof(PRESERVE_SCOPE, 31, 102),
        }),
      }),
      NOW,
    );
    assert.equal(auth2Plan.status, "install");
    if (auth2Plan.status !== "install") throw new Error("expected install");
    assert.equal(auth2Plan.move.nextRevision, FOREIGN_AUTH);
    assert.equal(auth2Plan.move.nextGeneration, 32);
    // The foreign-auth healthy proof authorizes the reason-code install.
    const reasonPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: FOREIGN_AUTH,
          generation: 32,
          healthyProof: healthyProof(FOREIGN_AUTH, 32, 103),
        }),
      }),
      NOW,
    );
    assert.equal(reasonPlan.status, "install");
    if (reasonPlan.status !== "install") throw new Error("expected install");
    assert.equal(reasonPlan.move.nextRevision, REASON_CODE);
    assert.equal(reasonPlan.move.nextGeneration, 33);
    // The reason-code healthy proof authorizes the settlement recovery install
    // to the fixed owner-approved pin.
    const reasonSettled = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REASON_CODE,
          generation: 33,
          healthyProof: healthyProof(REASON_CODE, 33, 104),
        }),
      }),
      NOW,
    );
    assert.equal(reasonSettled.status, "install");
    if (reasonSettled.status !== "install") throw new Error("expected install");
    assert.equal(reasonSettled.move.nextRevision, SETTLEMENT_RECOVERY);
    assert.equal(reasonSettled.move.nextGeneration, 34);
    // The settlement recovery healthy proof authorizes the fixed
    // quiet-reasoning install, the last link of the chain.
    const quietPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: SETTLEMENT_RECOVERY,
          generation: 34,
          healthyProof: healthyProof(SETTLEMENT_RECOVERY, 34, 105),
        }),
      }),
      NOW,
    );
    assert.equal(quietPlan.status, "install");
    if (quietPlan.status !== "install") throw new Error("expected install");
    assert.equal(quietPlan.move.nextRevision, QUIET_REASONING);
    assert.equal(quietPlan.move.nextGeneration, QUIET_REASONING_GENERATION);
    const exitFailed = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: EXIT_CONTRACT,
          generation: 11,
          healthyProof: reviewerHealthy,
          executionProof: failedProof(EXIT_CONTRACT, 11, 82),
        }),
      }),
      NOW,
    );
    assert.equal(exitFailed.status, "rollback");
    if (exitFailed.status !== "rollback") throw new Error("expected rollback");
    assert.equal(exitFailed.move.nextRevision, REVIEWER);
    assert.equal(exitFailed.move.nextGeneration, 12);
    // A failed reviewer candidate rolls back once to the exact review-step
    // revision, authorized by its recorded healthy proof.
    const reviewerFailed = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REVIEWER,
          generation: 10,
          healthyProof: reviewStepHealthy,
          executionProof: failedProof(REVIEWER, 10, 80),
        }),
      }),
      NOW,
    );
    assert.equal(reviewerFailed.status, "rollback");
    if (reviewerFailed.status !== "rollback") {
      throw new Error("expected rollback");
    }
    assert.equal(reviewerFailed.move.nextRevision, REVIEW_STEP);
    assert.equal(reviewerFailed.move.nextGeneration, 11);
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({ revision: REVIEWER, generation: 10 }),
        }),
        NOW,
      ).status,
      "waiting",
    );
    // A failed review-step candidate rolls back once to the exact review
    // recovery revision, authorized by its recorded healthy proof.
    const reviewStepFailed = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REVIEW_STEP,
          generation: 9,
          healthyProof: recoveryHealthy,
          executionProof: failedProof(REVIEW_STEP, 9, 79),
        }),
      }),
      NOW,
    );
    assert.equal(reviewStepFailed.status, "rollback");
    if (reviewStepFailed.status !== "rollback") {
      throw new Error("expected rollback");
    }
    assert.equal(reviewStepFailed.move.nextRevision, RECOVERY);
    assert.equal(reviewStepFailed.move.nextGeneration, 10);
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({ revision: REVIEW_STEP, generation: 9 }),
        }),
        NOW,
      ).status,
      "waiting",
    );
    // A failed review recovery candidate rolls back once, to the exact
    // aggregate revision, authorized by its recorded healthy proof.
    const recoveryFailed = releaseSnapshot({
      runtime: runtimeRecord({
        revision: RECOVERY,
        generation: 8,
        healthyProof: aggregateHealthy,
        executionProof: failedProof(RECOVERY, 8, 76),
      }),
    });
    const recoveryRollback = planOwnerDevelopmentInstall(recoveryFailed, NOW);
    assert.equal(recoveryRollback.status, "rollback");
    if (recoveryRollback.status !== "rollback") {
      throw new Error("expected rollback");
    }
    assert.equal(recoveryRollback.move.priorRevision, RECOVERY);
    assert.equal(recoveryRollback.move.nextRevision, AGGREGATE);
    assert.equal(recoveryRollback.move.nextGeneration, 9);
    assert.equal(
      canonicalStringify(recoveryRollback.move.priorHealthyProof),
      canonicalStringify(aggregateHealthy),
    );
    // Without the recorded aggregate healthy proof the rollback waits.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: RECOVERY,
            generation: 8,
            executionProof: failedProof(RECOVERY, 8, 77),
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );
    // A review recovery pointer without any proof yet is an ordinary wait for
    // the verification execution's healthy proof.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({ revision: RECOVERY, generation: 8 }),
        }),
        NOW,
      ).status,
      "waiting",
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: UNRELATED,
            generation: 9,
            healthyProof: healthyProof(UNRELATED, 9, 74),
          }),
        }),
        NOW,
      ).status,
      "no_change",
    );

    // No hosted runtime is the supervisor's own seeding work, not this gate.
    assert.equal(
      planOwnerDevelopmentInstall(releaseSnapshot({}), NOW).status,
      "waiting",
    );

    // An active hosted release waits even when the final revision is healthy.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: AGGREGATE,
            generation: 7,
            healthyProof: aggregateHealthy,
          }),
          hostedReleases: [requestedRelease()],
        }),
        NOW,
      ).status,
      "waiting",
    );
  },
);

Deno.test(
  "owner install: settlement recovery revision preserves install and rollback gates",
  () => {
    const reasonHealthy = healthyProof(REASON_CODE, 33, 111);
    // The fixed owner-approved pin: only the recorded generation 33 healthy
    // proof authorizes exactly one move to the settlement recovery revision.
    assert.equal(
      SETTLEMENT_RECOVERY,
      "83a7cd8162d808887a27ad733c64db6e3a7c77ac",
    );
    const fixed = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REASON_CODE,
          generation: 33,
          healthyProof: reasonHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(fixed.status, "install");
    if (fixed.status !== "install") throw new Error("expected install");
    assert.equal(fixed.move.priorRevision, REASON_CODE);
    assert.equal(fixed.move.priorGeneration, 33);
    assert.equal(fixed.move.nextRevision, SETTLEMENT_RECOVERY);
    assert.equal(fixed.move.nextGeneration, 34);
    assert.equal(
      canonicalStringify(fixed.move.priorHealthyProof),
      canonicalStringify(reasonHealthy),
    );

    // A healthy proof bound to another revision or generation never
    // authorizes the fixed pin.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: REASON_CODE,
            generation: 33,
            healthyProof: healthyProof(SETTLEMENT_RECOVERY, 33, 112),
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: REASON_CODE,
            generation: 33,
            healthyProof: healthyProof(REASON_CODE, 34, 113),
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );

    // An in-flight execution, a non-terminal release and an active cooldown
    // each keep the pin a zero-write wait.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: REASON_CODE,
            generation: 33,
            healthyProof: reasonHealthy,
            execution: executionIntent(REASON_CODE, 33),
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: REASON_CODE,
            generation: 33,
            healthyProof: reasonHealthy,
          }),
          hostedReleases: [requestedRelease()],
        }),
        NOW,
      ).status,
      "waiting",
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: REASON_CODE,
            generation: 33,
            healthyProof: reasonHealthy,
          }),
          cooldowns: [cooldown(NOW + 1)],
        }),
        NOW,
      ).status,
      "waiting",
    );

    // The installed generation 34 pointer is stable only with its own bound
    // healthy proof; that proof authorizes the fixed quiet-reasoning install
    // to generation 35.
    const settlementHealthy = healthyProof(SETTLEMENT_RECOVERY, 34, 114);
    const quietInstall = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: SETTLEMENT_RECOVERY,
          generation: 34,
          healthyProof: settlementHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(quietInstall.status, "install");
    if (quietInstall.status !== "install") throw new Error("expected install");
    assert.equal(quietInstall.move.priorRevision, SETTLEMENT_RECOVERY);
    assert.equal(quietInstall.move.priorGeneration, 34);
    assert.equal(quietInstall.move.nextRevision, QUIET_REASONING);
    assert.equal(quietInstall.move.nextGeneration, QUIET_REASONING_GENERATION);
    assert.equal(
      canonicalStringify(quietInstall.move.priorHealthyProof),
      canonicalStringify(settlementHealthy),
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: SETTLEMENT_RECOVERY,
            generation: 34,
            healthyProof: reasonHealthy,
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );

    // A failed generation 34 candidate settles exactly once by rolling back to
    // the genuine prior revision with a monotonic generation 35.
    const failedSettlement = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: SETTLEMENT_RECOVERY,
          generation: 34,
          healthyProof: reasonHealthy,
          executionProof: failedProof(SETTLEMENT_RECOVERY, 34, 115),
        }),
      }),
      NOW,
    );
    assert.equal(failedSettlement.status, "rollback");
    if (failedSettlement.status !== "rollback") {
      throw new Error("expected rollback");
    }
    assert.equal(failedSettlement.move.priorRevision, SETTLEMENT_RECOVERY);
    assert.equal(failedSettlement.move.priorGeneration, 34);
    assert.equal(failedSettlement.move.nextRevision, REASON_CODE);
    assert.equal(failedSettlement.move.nextGeneration, 35);
    assert.equal(
      canonicalStringify(failedSettlement.move.priorHealthyProof),
      canonicalStringify(reasonHealthy),
    );
    // Without the recorded reason-code healthy proof the rollback waits.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: SETTLEMENT_RECOVERY,
            generation: 34,
            executionProof: failedProof(SETTLEMENT_RECOVERY, 34, 116),
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );
  },
);

Deno.test(
  "owner install: quiet reasoning revision preserves install and rollback gates",
  () => {
    const settlementHealthy = healthyProof(SETTLEMENT_RECOVERY, 34, 121);
    // The fixed owner-approved pin: only the recorded generation 34 healthy
    // proof authorizes exactly one move to the quiet reasoning revision.
    const install = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: SETTLEMENT_RECOVERY,
          generation: 34,
          healthyProof: settlementHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(install.status, "install");
    if (install.status !== "install") throw new Error("expected install");
    assert.equal(install.move.action, "install");
    assert.equal(install.move.priorRevision, SETTLEMENT_RECOVERY);
    assert.equal(install.move.priorGeneration, 34);
    assert.equal(install.move.nextRevision, QUIET_REASONING);
    assert.equal(install.move.nextGeneration, QUIET_REASONING_GENERATION);
    assert.equal(install.move.nextGeneration, install.move.priorGeneration + 1);
    assert.equal(
      canonicalStringify(install.move.priorHealthyProof),
      canonicalStringify(settlementHealthy),
    );

    // A healthy proof bound to another revision or generation, and no
    // recorded proof at all, never authorize the fixed pin.
    for (
      const healthy of [
        healthyProof(QUIET_REASONING, 34, 122),
        healthyProof(SETTLEMENT_RECOVERY, 35, 123),
        null,
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: runtimeRecord({
              revision: SETTLEMENT_RECOVERY,
              generation: 34,
              healthyProof: healthy,
            }),
          }),
          NOW,
        ).status,
        "waiting",
      );
    }

    // An in-flight execution, a non-terminal release and an active cooldown
    // each keep the pin a zero-write wait.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: SETTLEMENT_RECOVERY,
            generation: 34,
            healthyProof: settlementHealthy,
            execution: executionIntent(SETTLEMENT_RECOVERY, 34),
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: SETTLEMENT_RECOVERY,
            generation: 34,
            healthyProof: settlementHealthy,
          }),
          hostedReleases: [requestedRelease()],
        }),
        NOW,
      ).status,
      "waiting",
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: SETTLEMENT_RECOVERY,
            generation: 34,
            healthyProof: settlementHealthy,
          }),
          cooldowns: [cooldown(NOW + 1)],
        }),
        NOW,
      ).status,
      "waiting",
    );

    // The installed generation 35 pointer is stable only with its own bound
    // healthy proof; that proof authorizes the fixed base fetch install to
    // generation 36.
    const quietHealthy = healthyProof(QUIET_REASONING, 35, 124);
    const baseFetchInstall = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: QUIET_REASONING,
          generation: QUIET_REASONING_GENERATION,
          healthyProof: quietHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(baseFetchInstall.status, "install");
    if (baseFetchInstall.status !== "install") {
      throw new Error("expected install");
    }
    assert.equal(baseFetchInstall.move.priorRevision, QUIET_REASONING);
    assert.equal(
      baseFetchInstall.move.priorGeneration,
      QUIET_REASONING_GENERATION,
    );
    assert.equal(baseFetchInstall.move.nextRevision, BASE_FETCH);
    assert.equal(baseFetchInstall.move.nextGeneration, BASE_FETCH_GENERATION);
    assert.equal(
      canonicalStringify(baseFetchInstall.move.priorHealthyProof),
      canonicalStringify(quietHealthy),
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: QUIET_REASONING,
            generation: QUIET_REASONING_GENERATION,
            healthyProof: settlementHealthy,
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );

    // A failed generation 35 candidate settles exactly once by rolling back
    // to the exact previously proven generation 34 revision with a monotonic
    // generation 36, authorized by its recorded healthy proof.
    const failed = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: QUIET_REASONING,
          generation: QUIET_REASONING_GENERATION,
          healthyProof: settlementHealthy,
          executionProof: failedProof(
            QUIET_REASONING,
            QUIET_REASONING_GENERATION,
            125,
          ),
        }),
      }),
      NOW,
    );
    assert.equal(failed.status, "rollback");
    if (failed.status !== "rollback") throw new Error("expected rollback");
    assert.equal(failed.move.action, "rollback");
    assert.equal(failed.move.priorRevision, QUIET_REASONING);
    assert.equal(failed.move.priorGeneration, QUIET_REASONING_GENERATION);
    assert.equal(failed.move.nextRevision, SETTLEMENT_RECOVERY);
    assert.equal(failed.move.nextGeneration, 36);
    assert.equal(failed.move.nextGeneration, failed.move.priorGeneration + 1);
    assert.equal(
      canonicalStringify(failed.move.priorHealthyProof),
      canonicalStringify(settlementHealthy),
    );

    // A failure that does not bind the exact pointer, a no-execution
    // settlement and a missing recorded prior never roll back.
    const waits = [
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: QUIET_REASONING,
          generation: QUIET_REASONING_GENERATION,
          healthyProof: settlementHealthy,
          executionProof: failedProof(QUIET_REASONING, 34, 126),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: QUIET_REASONING,
          generation: QUIET_REASONING_GENERATION,
          healthyProof: settlementHealthy,
          executionProof: notStartedProof(
            QUIET_REASONING,
            QUIET_REASONING_GENERATION,
          ),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: QUIET_REASONING,
          generation: QUIET_REASONING_GENERATION,
          executionProof: failedProof(
            QUIET_REASONING,
            QUIET_REASONING_GENERATION,
            127,
          ),
        }),
      }),
    ];
    for (const state of waits) {
      const plan = planOwnerDevelopmentInstall(state, NOW);
      assert.notEqual(plan.status, "rollback");
      assert.equal(plan.status, "waiting");
    }

    // The post-rollback generation 36 pointer is terminal: it is outside the
    // one-shot chain and never reattempts either movement.
    for (
      const healthy of [
        healthyProof(SETTLEMENT_RECOVERY, 36, 128),
        null,
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: runtimeRecord({
              revision: SETTLEMENT_RECOVERY,
              generation: 36,
              healthyProof: healthy,
            }),
          }),
          NOW,
        ).status,
        "no_change",
      );
    }
  },
);

Deno.test(
  "owner install: base fetch revision preserves install and rollback gates",
  () => {
    const quietHealthy = healthyProof(QUIET_REASONING, 35, 131);
    // The fixed owner-approved pin: only the recorded generation 35 healthy
    // proof authorizes exactly one move to the base fetch revision.
    const install = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: QUIET_REASONING,
          generation: QUIET_REASONING_GENERATION,
          healthyProof: quietHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(install.status, "install");
    if (install.status !== "install") throw new Error("expected install");
    assert.equal(install.move.action, "install");
    assert.equal(install.move.priorRevision, QUIET_REASONING);
    assert.equal(install.move.priorGeneration, QUIET_REASONING_GENERATION);
    assert.equal(install.move.nextRevision, BASE_FETCH);
    assert.equal(install.move.nextGeneration, BASE_FETCH_GENERATION);
    assert.equal(install.move.nextGeneration, install.move.priorGeneration + 1);
    assert.equal(
      canonicalStringify(install.move.priorHealthyProof),
      canonicalStringify(quietHealthy),
    );

    // A healthy proof bound to another revision or generation, and no
    // recorded proof at all, never authorize the fixed pin.
    for (
      const healthy of [
        healthyProof(BASE_FETCH, 35, 132),
        healthyProof(QUIET_REASONING, 36, 133),
        null,
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: runtimeRecord({
              revision: QUIET_REASONING,
              generation: QUIET_REASONING_GENERATION,
              healthyProof: healthy,
            }),
          }),
          NOW,
        ).status,
        "waiting",
      );
    }

    // An in-flight execution, a non-terminal release and an active cooldown
    // each keep the pin a zero-write wait.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: QUIET_REASONING,
            generation: QUIET_REASONING_GENERATION,
            healthyProof: quietHealthy,
            execution: executionIntent(
              QUIET_REASONING,
              QUIET_REASONING_GENERATION,
            ),
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: QUIET_REASONING,
            generation: QUIET_REASONING_GENERATION,
            healthyProof: quietHealthy,
          }),
          hostedReleases: [requestedRelease()],
        }),
        NOW,
      ).status,
      "waiting",
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: QUIET_REASONING,
            generation: QUIET_REASONING_GENERATION,
            healthyProof: quietHealthy,
          }),
          cooldowns: [cooldown(NOW + 1)],
        }),
        NOW,
      ).status,
      "waiting",
    );

    // The installed generation 36 pointer is stable only with its own bound
    // healthy proof; that proof authorizes the fixed review model install to
    // generation 37.
    const baseFetchHealthy = healthyProof(BASE_FETCH, 36, 134);
    const reviewModelInstall = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: BASE_FETCH,
          generation: BASE_FETCH_GENERATION,
          healthyProof: baseFetchHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(reviewModelInstall.status, "install");
    if (reviewModelInstall.status !== "install") {
      throw new Error("expected install");
    }
    assert.equal(reviewModelInstall.move.priorRevision, BASE_FETCH);
    assert.equal(
      reviewModelInstall.move.priorGeneration,
      BASE_FETCH_GENERATION,
    );
    assert.equal(reviewModelInstall.move.nextRevision, REVIEW_MODEL);
    assert.equal(
      reviewModelInstall.move.nextGeneration,
      REVIEW_MODEL_GENERATION,
    );
    assert.equal(
      canonicalStringify(reviewModelInstall.move.priorHealthyProof),
      canonicalStringify(baseFetchHealthy),
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: BASE_FETCH,
            generation: BASE_FETCH_GENERATION,
            healthyProof: quietHealthy,
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );

    // A failed generation 36 candidate settles exactly once by rolling back
    // to the exact previously proven generation 35 revision with a monotonic
    // generation 37, authorized by its recorded healthy proof.
    const failed = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: BASE_FETCH,
          generation: BASE_FETCH_GENERATION,
          healthyProof: quietHealthy,
          executionProof: failedProof(BASE_FETCH, BASE_FETCH_GENERATION, 135),
        }),
      }),
      NOW,
    );
    assert.equal(failed.status, "rollback");
    if (failed.status !== "rollback") throw new Error("expected rollback");
    assert.equal(failed.move.action, "rollback");
    assert.equal(failed.move.priorRevision, BASE_FETCH);
    assert.equal(failed.move.priorGeneration, BASE_FETCH_GENERATION);
    assert.equal(failed.move.nextRevision, QUIET_REASONING);
    assert.equal(failed.move.nextGeneration, 37);
    assert.equal(failed.move.nextGeneration, failed.move.priorGeneration + 1);
    assert.equal(
      canonicalStringify(failed.move.priorHealthyProof),
      canonicalStringify(quietHealthy),
    );

    // A failure that does not bind the exact pointer, a no-execution
    // settlement and a missing recorded prior never roll back.
    const waits = [
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: BASE_FETCH,
          generation: BASE_FETCH_GENERATION,
          healthyProof: quietHealthy,
          executionProof: failedProof(BASE_FETCH, 35, 136),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: BASE_FETCH,
          generation: BASE_FETCH_GENERATION,
          healthyProof: quietHealthy,
          executionProof: notStartedProof(BASE_FETCH, BASE_FETCH_GENERATION),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: BASE_FETCH,
          generation: BASE_FETCH_GENERATION,
          executionProof: failedProof(BASE_FETCH, BASE_FETCH_GENERATION, 137),
        }),
      }),
    ];
    for (const state of waits) {
      const plan = planOwnerDevelopmentInstall(state, NOW);
      assert.notEqual(plan.status, "rollback");
      assert.equal(plan.status, "waiting");
    }

    // The post-rollback generation 37 pointer is terminal: it is outside the
    // one-shot chain and never reattempts either movement.
    for (
      const healthy of [
        healthyProof(QUIET_REASONING, 37, 138),
        null,
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: runtimeRecord({
              revision: QUIET_REASONING,
              generation: 37,
              healthyProof: healthy,
            }),
          }),
          NOW,
        ).status,
        "no_change",
      );
    }
  },
);

Deno.test(
  "owner install: review model revision preserves install and rollback gates",
  () => {
    const baseFetchHealthy = healthyProof(BASE_FETCH, 36, 141);
    // The fixed owner-approved pin: only the recorded generation 36 healthy
    // proof authorizes exactly one move to the review model revision.
    const install = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: BASE_FETCH,
          generation: BASE_FETCH_GENERATION,
          healthyProof: baseFetchHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(install.status, "install");
    if (install.status !== "install") throw new Error("expected install");
    assert.equal(install.move.action, "install");
    assert.equal(install.move.priorRevision, BASE_FETCH);
    assert.equal(install.move.priorGeneration, BASE_FETCH_GENERATION);
    assert.equal(install.move.nextRevision, REVIEW_MODEL);
    assert.equal(install.move.nextGeneration, REVIEW_MODEL_GENERATION);
    assert.equal(install.move.nextGeneration, install.move.priorGeneration + 1);
    assert.equal(
      canonicalStringify(install.move.priorHealthyProof),
      canonicalStringify(baseFetchHealthy),
    );

    // A healthy proof bound to another revision or generation, and no
    // recorded proof at all, never authorize the fixed pin.
    for (
      const healthy of [
        healthyProof(REVIEW_MODEL, 36, 142),
        healthyProof(BASE_FETCH, 37, 143),
        null,
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: runtimeRecord({
              revision: BASE_FETCH,
              generation: BASE_FETCH_GENERATION,
              healthyProof: healthy,
            }),
          }),
          NOW,
        ).status,
        "waiting",
      );
    }

    // An in-flight execution, a non-terminal release and an active cooldown
    // each keep the pin a zero-write wait.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: BASE_FETCH,
            generation: BASE_FETCH_GENERATION,
            healthyProof: baseFetchHealthy,
            execution: executionIntent(BASE_FETCH, BASE_FETCH_GENERATION),
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: BASE_FETCH,
            generation: BASE_FETCH_GENERATION,
            healthyProof: baseFetchHealthy,
          }),
          hostedReleases: [requestedRelease()],
        }),
        NOW,
      ).status,
      "waiting",
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: BASE_FETCH,
            generation: BASE_FETCH_GENERATION,
            healthyProof: baseFetchHealthy,
          }),
          cooldowns: [cooldown(NOW + 1)],
        }),
        NOW,
      ).status,
      "waiting",
    );

    // The review model generation 37 healthy proof authorizes exactly one
    // move to the fixed owner-approved successor runtime revision.
    const reviewModelHealthy = healthyProof(REVIEW_MODEL, 37, 144);
    const successorInstall = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REVIEW_MODEL,
          generation: REVIEW_MODEL_GENERATION,
          healthyProof: reviewModelHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(successorInstall.status, "install");
    if (successorInstall.status !== "install") {
      throw new Error("expected successor install");
    }
    assert.equal(successorInstall.move.action, "install");
    assert.equal(successorInstall.move.priorRevision, REVIEW_MODEL);
    assert.equal(
      successorInstall.move.priorGeneration,
      REVIEW_MODEL_GENERATION,
    );
    assert.equal(successorInstall.move.nextRevision, SUCCESSOR_REVISION);
    assert.equal(successorInstall.move.nextGeneration, SUCCESSOR_GENERATION);
    assert.equal(
      successorInstall.move.nextGeneration,
      successorInstall.move.priorGeneration + 1,
    );
    assert.equal(
      canonicalStringify(successorInstall.move.priorHealthyProof),
      canonicalStringify(reviewModelHealthy),
    );

    // A healthy proof bound to another revision or generation, and no
    // recorded proof at all, never authorize the successor pin.
    for (
      const healthy of [
        baseFetchHealthy,
        healthyProof(SUCCESSOR_REVISION, 37, 149),
        healthyProof(REVIEW_MODEL, 38, 150),
        null,
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: runtimeRecord({
              revision: REVIEW_MODEL,
              generation: REVIEW_MODEL_GENERATION,
              healthyProof: healthy,
            }),
          }),
          NOW,
        ).status,
        "waiting",
      );
    }

    // An in-flight execution of the authorized successor install stays a
    // zero-write wait.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: REVIEW_MODEL,
            generation: REVIEW_MODEL_GENERATION,
            healthyProof: reviewModelHealthy,
            execution: executionIntent(REVIEW_MODEL, REVIEW_MODEL_GENERATION),
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );

    // The installed successor generation 38 pointer is stable only with its
    // own bound healthy proof, and that exact proof authorizes exactly one
    // move to the fixed owner-approved successor runtime revision.
    const successorHealthy = healthyProof(SUCCESSOR_REVISION, 38, 151);
    const publishGateInstall = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: SUCCESSOR_REVISION,
          generation: SUCCESSOR_GENERATION,
          healthyProof: successorHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(publishGateInstall.status, "install");
    if (publishGateInstall.status !== "install") {
      throw new Error("expected publish gate install");
    }
    assert.equal(publishGateInstall.move.action, "install");
    assert.equal(publishGateInstall.move.priorRevision, SUCCESSOR_REVISION);
    assert.equal(
      publishGateInstall.move.priorGeneration,
      SUCCESSOR_GENERATION,
    );
    assert.equal(publishGateInstall.move.nextRevision, PUBLISH_GATE_REVISION);
    assert.equal(
      publishGateInstall.move.nextGeneration,
      PUBLISH_GATE_GENERATION,
    );
    assert.equal(
      publishGateInstall.move.nextGeneration,
      publishGateInstall.move.priorGeneration + 1,
    );
    assert.equal(
      canonicalStringify(publishGateInstall.move.priorHealthyProof),
      canonicalStringify(successorHealthy),
    );
    for (
      const healthy of [
        reviewModelHealthy,
        healthyProof(SUCCESSOR_REVISION, 39, 152),
        null,
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: runtimeRecord({
              revision: SUCCESSOR_REVISION,
              generation: SUCCESSOR_GENERATION,
              healthyProof: healthy,
            }),
          }),
          NOW,
        ).status,
        "waiting",
      );
    }

    // The installed publish-gate generation 39 pointer is stable only with
    // its own bound healthy proof, and that exact proof authorizes exactly one
    // move to the fixed owner-approved successor runtime revision.
    const publishGateHealthy = healthyProof(PUBLISH_GATE_REVISION, 39, 157);
    const closingKeywordInstall = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: PUBLISH_GATE_REVISION,
          generation: PUBLISH_GATE_GENERATION,
          healthyProof: publishGateHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(closingKeywordInstall.status, "install");
    if (closingKeywordInstall.status !== "install") {
      throw new Error("expected closing keyword install");
    }
    assert.equal(closingKeywordInstall.move.action, "install");
    assert.equal(
      closingKeywordInstall.move.priorRevision,
      PUBLISH_GATE_REVISION,
    );
    assert.equal(
      closingKeywordInstall.move.priorGeneration,
      PUBLISH_GATE_GENERATION,
    );
    assert.equal(
      closingKeywordInstall.move.nextRevision,
      CLOSING_KEYWORD_REVISION,
    );
    assert.equal(
      closingKeywordInstall.move.nextGeneration,
      CLOSING_KEYWORD_GENERATION,
    );
    assert.equal(
      closingKeywordInstall.move.nextGeneration,
      closingKeywordInstall.move.priorGeneration + 1,
    );
    assert.equal(
      canonicalStringify(closingKeywordInstall.move.priorHealthyProof),
      canonicalStringify(publishGateHealthy),
    );
    for (
      const healthy of [
        successorHealthy,
        healthyProof(PUBLISH_GATE_REVISION, 38, 158),
        null,
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: runtimeRecord({
              revision: PUBLISH_GATE_REVISION,
              generation: PUBLISH_GATE_GENERATION,
              healthyProof: healthy,
            }),
          }),
          NOW,
        ).status,
        "waiting",
      );
    }

    // The installed closing-keyword generation 40 pointer is stable only with
    // its own bound healthy proof, and that exact proof authorizes exactly one
    // move to the fixed owner-approved successor runtime revision.
    const closingKeywordHealthy = healthyProof(
      CLOSING_KEYWORD_REVISION,
      40,
      163,
    );
    const candidateLossInstall = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CLOSING_KEYWORD_REVISION,
          generation: CLOSING_KEYWORD_GENERATION,
          healthyProof: closingKeywordHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(candidateLossInstall.status, "install");
    if (candidateLossInstall.status !== "install") {
      throw new Error("expected candidate loss install");
    }
    assert.equal(candidateLossInstall.move.action, "install");
    assert.equal(
      candidateLossInstall.move.priorRevision,
      CLOSING_KEYWORD_REVISION,
    );
    assert.equal(
      candidateLossInstall.move.priorGeneration,
      CLOSING_KEYWORD_GENERATION,
    );
    assert.equal(
      candidateLossInstall.move.nextRevision,
      CANDIDATE_LOSS_REVISION,
    );
    assert.equal(
      candidateLossInstall.move.nextGeneration,
      CANDIDATE_LOSS_GENERATION,
    );
    assert.equal(
      candidateLossInstall.move.nextGeneration,
      candidateLossInstall.move.priorGeneration + 1,
    );
    assert.equal(
      canonicalStringify(candidateLossInstall.move.priorHealthyProof),
      canonicalStringify(closingKeywordHealthy),
    );
    for (
      const healthy of [
        publishGateHealthy,
        healthyProof(CLOSING_KEYWORD_REVISION, 39, 164),
        null,
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: runtimeRecord({
              revision: CLOSING_KEYWORD_REVISION,
              generation: CLOSING_KEYWORD_GENERATION,
              healthyProof: healthy,
            }),
          }),
          NOW,
        ).status,
        "waiting",
      );
    }

    // The installed candidate-loss generation 41 pointer is stable only with
    // its own bound healthy proof, and that exact proof authorizes exactly one
    // move to the fixed owner-approved successor runtime revision.
    const candidateLossHealthy = healthyProof(CANDIDATE_LOSS_REVISION, 41, 168);
    const closedPrInstall = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CANDIDATE_LOSS_REVISION,
          generation: CANDIDATE_LOSS_GENERATION,
          healthyProof: candidateLossHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(closedPrInstall.status, "install");
    if (closedPrInstall.status !== "install") {
      throw new Error("expected closed PR install");
    }
    assert.equal(closedPrInstall.move.action, "install");
    assert.equal(
      closedPrInstall.move.priorRevision,
      CANDIDATE_LOSS_REVISION,
    );
    assert.equal(
      closedPrInstall.move.priorGeneration,
      CANDIDATE_LOSS_GENERATION,
    );
    assert.equal(closedPrInstall.move.nextRevision, CLOSED_PR_REVISION);
    assert.equal(closedPrInstall.move.nextGeneration, CLOSED_PR_GENERATION);
    assert.equal(
      closedPrInstall.move.nextGeneration,
      closedPrInstall.move.priorGeneration + 1,
    );
    assert.equal(
      canonicalStringify(closedPrInstall.move.priorHealthyProof),
      canonicalStringify(candidateLossHealthy),
    );
    for (
      const healthy of [
        closingKeywordHealthy,
        healthyProof(CANDIDATE_LOSS_REVISION, 40, 169),
        null,
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: runtimeRecord({
              revision: CANDIDATE_LOSS_REVISION,
              generation: CANDIDATE_LOSS_GENERATION,
              healthyProof: healthy,
            }),
          }),
          NOW,
        ).status,
        "waiting",
      );
    }

    // The installed closed-PR generation 42 pointer is stable only with its
    // own bound healthy proof, and that exact proof authorizes exactly one
    // move to the fixed owner-approved successor runtime revision.
    const closedPrHealthy = healthyProof(CLOSED_PR_REVISION, 42, 173);
    const closedPrHeadInstall = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CLOSED_PR_REVISION,
          generation: CLOSED_PR_GENERATION,
          healthyProof: closedPrHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(closedPrHeadInstall.status, "install");
    if (closedPrHeadInstall.status !== "install") {
      throw new Error("expected closed PR head install");
    }
    assert.equal(closedPrHeadInstall.move.action, "install");
    assert.equal(closedPrHeadInstall.move.priorRevision, CLOSED_PR_REVISION);
    assert.equal(
      closedPrHeadInstall.move.priorGeneration,
      CLOSED_PR_GENERATION,
    );
    assert.equal(
      closedPrHeadInstall.move.nextRevision,
      CLOSED_PR_HEAD_REVISION,
    );
    assert.equal(
      closedPrHeadInstall.move.nextGeneration,
      CLOSED_PR_HEAD_GENERATION,
    );
    assert.equal(
      closedPrHeadInstall.move.nextGeneration,
      closedPrHeadInstall.move.priorGeneration + 1,
    );
    assert.equal(
      canonicalStringify(closedPrHeadInstall.move.priorHealthyProof),
      canonicalStringify(closedPrHealthy),
    );
    for (
      const healthy of [
        candidateLossHealthy,
        healthyProof(CLOSED_PR_REVISION, 41, 174),
        null,
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: runtimeRecord({
              revision: CLOSED_PR_REVISION,
              generation: CLOSED_PR_GENERATION,
              healthyProof: healthy,
            }),
          }),
          NOW,
        ).status,
        "waiting",
      );
    }

    // The installed closed-PR head generation 43 pointer is stable only with
    // its own bound healthy proof, and that exact proof authorizes exactly one
    // move to the fixed owner-approved successor runtime revision.
    const closedPrHeadHealthy = healthyProof(
      CLOSED_PR_HEAD_REVISION,
      43,
      178,
    );
    const assignFirstInstall = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CLOSED_PR_HEAD_REVISION,
          generation: CLOSED_PR_HEAD_GENERATION,
          healthyProof: closedPrHeadHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(assignFirstInstall.status, "install");
    if (assignFirstInstall.status !== "install") {
      throw new Error("expected assign first install");
    }
    assert.equal(assignFirstInstall.move.action, "install");
    assert.equal(
      assignFirstInstall.move.priorRevision,
      CLOSED_PR_HEAD_REVISION,
    );
    assert.equal(
      assignFirstInstall.move.priorGeneration,
      CLOSED_PR_HEAD_GENERATION,
    );
    assert.equal(assignFirstInstall.move.nextRevision, ASSIGN_FIRST_REVISION);
    assert.equal(
      assignFirstInstall.move.nextGeneration,
      ASSIGN_FIRST_GENERATION,
    );
    assert.equal(
      assignFirstInstall.move.nextGeneration,
      assignFirstInstall.move.priorGeneration + 1,
    );
    assert.equal(
      canonicalStringify(assignFirstInstall.move.priorHealthyProof),
      canonicalStringify(closedPrHeadHealthy),
    );
    for (
      const healthy of [
        closedPrHealthy,
        healthyProof(CLOSED_PR_HEAD_REVISION, 42, 179),
        null,
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: runtimeRecord({
              revision: CLOSED_PR_HEAD_REVISION,
              generation: CLOSED_PR_HEAD_GENERATION,
              healthyProof: healthy,
            }),
          }),
          NOW,
        ).status,
        "waiting",
      );
    }

    // The installed assign-first generation 44 pointer is stable only with its
    // own bound healthy proof, and that exact proof authorizes exactly one
    // move to the fixed owner-approved successor runtime revision.
    const assignFirstHealthy = healthyProof(ASSIGN_FIRST_REVISION, 44, 183);
    const reviewPhaseInstall = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: ASSIGN_FIRST_REVISION,
          generation: ASSIGN_FIRST_GENERATION,
          healthyProof: assignFirstHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(reviewPhaseInstall.status, "install");
    if (reviewPhaseInstall.status !== "install") {
      throw new Error("expected review-phase PR install");
    }
    assert.equal(reviewPhaseInstall.move.action, "install");
    assert.equal(
      reviewPhaseInstall.move.priorRevision,
      ASSIGN_FIRST_REVISION,
    );
    assert.equal(
      reviewPhaseInstall.move.priorGeneration,
      ASSIGN_FIRST_GENERATION,
    );
    assert.equal(
      reviewPhaseInstall.move.nextRevision,
      REVIEW_PHASE_PR_REVISION,
    );
    assert.equal(
      reviewPhaseInstall.move.nextGeneration,
      REVIEW_PHASE_PR_GENERATION,
    );
    assert.equal(
      reviewPhaseInstall.move.nextGeneration,
      reviewPhaseInstall.move.priorGeneration + 1,
    );
    assert.equal(
      canonicalStringify(reviewPhaseInstall.move.priorHealthyProof),
      canonicalStringify(assignFirstHealthy),
    );
    for (
      const healthy of [
        closedPrHeadHealthy,
        healthyProof(ASSIGN_FIRST_REVISION, 43, 184),
        null,
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: runtimeRecord({
              revision: ASSIGN_FIRST_REVISION,
              generation: ASSIGN_FIRST_GENERATION,
              healthyProof: healthy,
            }),
          }),
          NOW,
        ).status,
        "waiting",
      );
    }

    // The installed review-phase PR generation 45 pointer is stable only with
    // its own bound healthy proof, and that stable pointer is terminal.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: REVIEW_PHASE_PR_REVISION,
            generation: REVIEW_PHASE_PR_GENERATION,
            healthyProof: healthyProof(REVIEW_PHASE_PR_REVISION, 45, 188),
          }),
        }),
        NOW,
      ).status,
      "no_change",
    );
    for (
      const healthy of [
        assignFirstHealthy,
        healthyProof(REVIEW_PHASE_PR_REVISION, 44, 189),
        null,
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: runtimeRecord({
              revision: REVIEW_PHASE_PR_REVISION,
              generation: REVIEW_PHASE_PR_GENERATION,
              healthyProof: healthy,
            }),
          }),
          NOW,
        ).status,
        "waiting",
      );
    }

    // A failed review-phase PR generation 45 candidate settles exactly once by
    // rolling back only to the exact previously proven assign-first revision
    // with a monotonic generation 46, authorized by its retained healthy
    // proof.
    const failedReviewPhase = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REVIEW_PHASE_PR_REVISION,
          generation: REVIEW_PHASE_PR_GENERATION,
          healthyProof: assignFirstHealthy,
          executionProof: failedProof(REVIEW_PHASE_PR_REVISION, 45, 190),
        }),
      }),
      NOW,
    );
    assert.equal(failedReviewPhase.status, "rollback");
    if (failedReviewPhase.status !== "rollback") {
      throw new Error("expected review-phase PR rollback");
    }
    assert.equal(failedReviewPhase.move.action, "rollback");
    assert.equal(
      failedReviewPhase.move.priorRevision,
      REVIEW_PHASE_PR_REVISION,
    );
    assert.equal(
      failedReviewPhase.move.priorGeneration,
      REVIEW_PHASE_PR_GENERATION,
    );
    assert.equal(
      failedReviewPhase.move.nextRevision,
      ASSIGN_FIRST_REVISION,
    );
    assert.equal(failedReviewPhase.move.nextGeneration, 46);
    assert.equal(
      canonicalStringify(failedReviewPhase.move.priorHealthyProof),
      canonicalStringify(assignFirstHealthy),
    );

    // A review-phase PR failure that does not bind the exact pointer or a
    // missing retained prior never rolls back.
    const reviewPhaseWaits = [
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REVIEW_PHASE_PR_REVISION,
          generation: REVIEW_PHASE_PR_GENERATION,
          healthyProof: assignFirstHealthy,
          executionProof: failedProof(REVIEW_PHASE_PR_REVISION, 44, 191),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REVIEW_PHASE_PR_REVISION,
          generation: REVIEW_PHASE_PR_GENERATION,
          executionProof: failedProof(REVIEW_PHASE_PR_REVISION, 45, 192),
        }),
      }),
    ];
    for (const state of reviewPhaseWaits) {
      const plan = planOwnerDevelopmentInstall(state, NOW);
      assert.notEqual(plan.status, "rollback");
      assert.equal(plan.status, "waiting");
    }

    // A failed assign-first generation 44 candidate settles exactly once by
    // rolling back only to the exact previously proven closed-PR head revision
    // with a monotonic generation 45, authorized by its retained healthy
    // proof.
    const failedAssignFirst = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: ASSIGN_FIRST_REVISION,
          generation: ASSIGN_FIRST_GENERATION,
          healthyProof: closedPrHeadHealthy,
          executionProof: failedProof(ASSIGN_FIRST_REVISION, 44, 185),
        }),
      }),
      NOW,
    );
    assert.equal(failedAssignFirst.status, "rollback");
    if (failedAssignFirst.status !== "rollback") {
      throw new Error("expected assign first rollback");
    }
    assert.equal(failedAssignFirst.move.action, "rollback");
    assert.equal(
      failedAssignFirst.move.priorRevision,
      ASSIGN_FIRST_REVISION,
    );
    assert.equal(
      failedAssignFirst.move.priorGeneration,
      ASSIGN_FIRST_GENERATION,
    );
    assert.equal(
      failedAssignFirst.move.nextRevision,
      CLOSED_PR_HEAD_REVISION,
    );
    assert.equal(failedAssignFirst.move.nextGeneration, 45);
    assert.equal(
      canonicalStringify(failedAssignFirst.move.priorHealthyProof),
      canonicalStringify(closedPrHeadHealthy),
    );

    // An assign-first failure that does not bind the exact pointer or a
    // missing retained prior never rolls back.
    const assignFirstWaits = [
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: ASSIGN_FIRST_REVISION,
          generation: ASSIGN_FIRST_GENERATION,
          healthyProof: closedPrHeadHealthy,
          executionProof: failedProof(ASSIGN_FIRST_REVISION, 43, 186),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: ASSIGN_FIRST_REVISION,
          generation: ASSIGN_FIRST_GENERATION,
          executionProof: failedProof(ASSIGN_FIRST_REVISION, 44, 187),
        }),
      }),
    ];
    for (const state of assignFirstWaits) {
      const plan = planOwnerDevelopmentInstall(state, NOW);
      assert.notEqual(plan.status, "rollback");
      assert.equal(plan.status, "waiting");
    }

    // A failed closed-PR head generation 43 candidate settles exactly once by
    // rolling back only to the exact previously proven closed-PR revision
    // with a monotonic generation 44, authorized by its retained healthy
    // proof.
    const failedClosedPrHead = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CLOSED_PR_HEAD_REVISION,
          generation: CLOSED_PR_HEAD_GENERATION,
          healthyProof: closedPrHealthy,
          executionProof: failedProof(CLOSED_PR_HEAD_REVISION, 43, 180),
        }),
      }),
      NOW,
    );
    assert.equal(failedClosedPrHead.status, "rollback");
    if (failedClosedPrHead.status !== "rollback") {
      throw new Error("expected closed PR head rollback");
    }
    assert.equal(failedClosedPrHead.move.action, "rollback");
    assert.equal(
      failedClosedPrHead.move.priorRevision,
      CLOSED_PR_HEAD_REVISION,
    );
    assert.equal(
      failedClosedPrHead.move.priorGeneration,
      CLOSED_PR_HEAD_GENERATION,
    );
    assert.equal(failedClosedPrHead.move.nextRevision, CLOSED_PR_REVISION);
    assert.equal(failedClosedPrHead.move.nextGeneration, 44);
    assert.equal(
      canonicalStringify(failedClosedPrHead.move.priorHealthyProof),
      canonicalStringify(closedPrHealthy),
    );

    // A closed-PR head failure that does not bind the exact pointer or a
    // missing retained prior never rolls back.
    const closedPrHeadWaits = [
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CLOSED_PR_HEAD_REVISION,
          generation: CLOSED_PR_HEAD_GENERATION,
          healthyProof: closedPrHealthy,
          executionProof: failedProof(CLOSED_PR_HEAD_REVISION, 42, 181),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CLOSED_PR_HEAD_REVISION,
          generation: CLOSED_PR_HEAD_GENERATION,
          executionProof: failedProof(CLOSED_PR_HEAD_REVISION, 43, 182),
        }),
      }),
    ];
    for (const state of closedPrHeadWaits) {
      const plan = planOwnerDevelopmentInstall(state, NOW);
      assert.notEqual(plan.status, "rollback");
      assert.equal(plan.status, "waiting");
    }

    // A failed closed-PR generation 42 candidate settles exactly once by
    // rolling back only to the exact previously proven candidate-loss
    // revision with a monotonic generation 43, authorized by its retained
    // healthy proof.
    const failedClosedPr = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CLOSED_PR_REVISION,
          generation: CLOSED_PR_GENERATION,
          healthyProof: candidateLossHealthy,
          executionProof: failedProof(CLOSED_PR_REVISION, 42, 175),
        }),
      }),
      NOW,
    );
    assert.equal(failedClosedPr.status, "rollback");
    if (failedClosedPr.status !== "rollback") {
      throw new Error("expected closed PR rollback");
    }
    assert.equal(failedClosedPr.move.action, "rollback");
    assert.equal(failedClosedPr.move.priorRevision, CLOSED_PR_REVISION);
    assert.equal(failedClosedPr.move.priorGeneration, CLOSED_PR_GENERATION);
    assert.equal(
      failedClosedPr.move.nextRevision,
      CANDIDATE_LOSS_REVISION,
    );
    assert.equal(failedClosedPr.move.nextGeneration, 43);
    assert.equal(
      failedClosedPr.move.nextGeneration,
      failedClosedPr.move.priorGeneration + 1,
    );
    assert.equal(
      canonicalStringify(failedClosedPr.move.priorHealthyProof),
      canonicalStringify(candidateLossHealthy),
    );

    // A closed-PR failure that does not bind the exact pointer or a missing
    // retained prior never rolls back.
    const closedPrWaits = [
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CLOSED_PR_REVISION,
          generation: CLOSED_PR_GENERATION,
          healthyProof: candidateLossHealthy,
          executionProof: failedProof(CLOSED_PR_REVISION, 41, 176),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CLOSED_PR_REVISION,
          generation: CLOSED_PR_GENERATION,
          executionProof: failedProof(CLOSED_PR_REVISION, 42, 177),
        }),
      }),
    ];
    for (const state of closedPrWaits) {
      const plan = planOwnerDevelopmentInstall(state, NOW);
      assert.notEqual(plan.status, "rollback");
      assert.equal(plan.status, "waiting");
    }

    // A failed candidate-loss generation 41 candidate settles exactly once by
    // rolling back only to the exact previously proven closing-keyword
    // revision with a monotonic generation 42, authorized by its retained
    // healthy proof.
    const failedCandidateLoss = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CANDIDATE_LOSS_REVISION,
          generation: CANDIDATE_LOSS_GENERATION,
          healthyProof: closingKeywordHealthy,
          executionProof: failedProof(CANDIDATE_LOSS_REVISION, 41, 170),
        }),
      }),
      NOW,
    );
    assert.equal(failedCandidateLoss.status, "rollback");
    if (failedCandidateLoss.status !== "rollback") {
      throw new Error("expected candidate loss rollback");
    }
    assert.equal(failedCandidateLoss.move.action, "rollback");
    assert.equal(
      failedCandidateLoss.move.priorRevision,
      CANDIDATE_LOSS_REVISION,
    );
    assert.equal(
      failedCandidateLoss.move.priorGeneration,
      CANDIDATE_LOSS_GENERATION,
    );
    assert.equal(
      failedCandidateLoss.move.nextRevision,
      CLOSING_KEYWORD_REVISION,
    );
    assert.equal(failedCandidateLoss.move.nextGeneration, 42);
    assert.equal(
      failedCandidateLoss.move.nextGeneration,
      failedCandidateLoss.move.priorGeneration + 1,
    );
    assert.equal(
      canonicalStringify(failedCandidateLoss.move.priorHealthyProof),
      canonicalStringify(closingKeywordHealthy),
    );

    // A candidate-loss failure that does not bind the exact pointer or a
    // missing retained prior never rolls back.
    const candidateLossWaits = [
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CANDIDATE_LOSS_REVISION,
          generation: CANDIDATE_LOSS_GENERATION,
          healthyProof: closingKeywordHealthy,
          executionProof: failedProof(CANDIDATE_LOSS_REVISION, 40, 171),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CANDIDATE_LOSS_REVISION,
          generation: CANDIDATE_LOSS_GENERATION,
          executionProof: failedProof(CANDIDATE_LOSS_REVISION, 41, 172),
        }),
      }),
    ];
    for (const state of candidateLossWaits) {
      const plan = planOwnerDevelopmentInstall(state, NOW);
      assert.notEqual(plan.status, "rollback");
      assert.equal(plan.status, "waiting");
    }

    // A failed closing-keyword generation 40 candidate settles exactly once by
    // rolling back only to the exact previously proven publish-gate revision
    // with a monotonic generation 41, authorized by its retained healthy
    // proof.
    const failedClosingKeyword = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CLOSING_KEYWORD_REVISION,
          generation: CLOSING_KEYWORD_GENERATION,
          healthyProof: publishGateHealthy,
          executionProof: failedProof(CLOSING_KEYWORD_REVISION, 40, 165),
        }),
      }),
      NOW,
    );
    assert.equal(failedClosingKeyword.status, "rollback");
    if (failedClosingKeyword.status !== "rollback") {
      throw new Error("expected closing keyword rollback");
    }
    assert.equal(failedClosingKeyword.move.action, "rollback");
    assert.equal(
      failedClosingKeyword.move.priorRevision,
      CLOSING_KEYWORD_REVISION,
    );
    assert.equal(
      failedClosingKeyword.move.priorGeneration,
      CLOSING_KEYWORD_GENERATION,
    );
    assert.equal(
      failedClosingKeyword.move.nextRevision,
      PUBLISH_GATE_REVISION,
    );
    assert.equal(failedClosingKeyword.move.nextGeneration, 41);
    assert.equal(
      failedClosingKeyword.move.nextGeneration,
      failedClosingKeyword.move.priorGeneration + 1,
    );
    assert.equal(
      canonicalStringify(failedClosingKeyword.move.priorHealthyProof),
      canonicalStringify(publishGateHealthy),
    );

    // A closing-keyword failure that does not bind the exact pointer or a
    // missing retained prior never rolls back.
    const closingKeywordWaits = [
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CLOSING_KEYWORD_REVISION,
          generation: CLOSING_KEYWORD_GENERATION,
          healthyProof: publishGateHealthy,
          executionProof: failedProof(CLOSING_KEYWORD_REVISION, 39, 166),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CLOSING_KEYWORD_REVISION,
          generation: CLOSING_KEYWORD_GENERATION,
          executionProof: failedProof(CLOSING_KEYWORD_REVISION, 40, 167),
        }),
      }),
    ];
    for (const state of closingKeywordWaits) {
      const plan = planOwnerDevelopmentInstall(state, NOW);
      assert.notEqual(plan.status, "rollback");
      assert.equal(plan.status, "waiting");
    }

    // A failed publish-gate generation 39 candidate settles exactly once by
    // rolling back only to the exact previously proven successor revision
    // with a monotonic generation 40, authorized by its retained healthy
    // proof.
    const failedPublishGate = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: PUBLISH_GATE_REVISION,
          generation: PUBLISH_GATE_GENERATION,
          healthyProof: successorHealthy,
          executionProof: failedProof(PUBLISH_GATE_REVISION, 39, 159),
        }),
      }),
      NOW,
    );
    assert.equal(failedPublishGate.status, "rollback");
    if (failedPublishGate.status !== "rollback") {
      throw new Error("expected publish gate rollback");
    }
    assert.equal(failedPublishGate.move.action, "rollback");
    assert.equal(failedPublishGate.move.priorRevision, PUBLISH_GATE_REVISION);
    assert.equal(
      failedPublishGate.move.priorGeneration,
      PUBLISH_GATE_GENERATION,
    );
    assert.equal(failedPublishGate.move.nextRevision, SUCCESSOR_REVISION);
    assert.equal(failedPublishGate.move.nextGeneration, 40);
    assert.equal(
      failedPublishGate.move.nextGeneration,
      failedPublishGate.move.priorGeneration + 1,
    );
    assert.equal(
      canonicalStringify(failedPublishGate.move.priorHealthyProof),
      canonicalStringify(successorHealthy),
    );

    // A publish-gate failure that does not bind the exact pointer and a
    // missing retained prior never roll back.
    const publishGateWaits = [
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: PUBLISH_GATE_REVISION,
          generation: PUBLISH_GATE_GENERATION,
          healthyProof: successorHealthy,
          executionProof: failedProof(PUBLISH_GATE_REVISION, 38, 160),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: PUBLISH_GATE_REVISION,
          generation: PUBLISH_GATE_GENERATION,
          executionProof: failedProof(PUBLISH_GATE_REVISION, 39, 161),
        }),
      }),
    ];
    for (const state of publishGateWaits) {
      const plan = planOwnerDevelopmentInstall(state, NOW);
      assert.notEqual(plan.status, "rollback");
      assert.equal(plan.status, "waiting");
    }

    // The post-rollback successor generation 40 pointer is terminal: it is
    // outside the one-shot chain and never reattempts either movement.
    for (
      const healthy of [
        healthyProof(SUCCESSOR_REVISION, 40, 162),
        null,
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: runtimeRecord({
              revision: SUCCESSOR_REVISION,
              generation: 40,
              healthyProof: healthy,
            }),
          }),
          NOW,
        ).status,
        "no_change",
      );
    }

    // A failed generation 38 successor candidate settles exactly once by
    // rolling back only to the exact previously proven review model revision
    // with a monotonic generation 39, authorized by its retained healthy
    // proof.
    const failedSuccessor = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: SUCCESSOR_REVISION,
          generation: SUCCESSOR_GENERATION,
          healthyProof: reviewModelHealthy,
          executionProof: failedProof(SUCCESSOR_REVISION, 38, 153),
        }),
      }),
      NOW,
    );
    assert.equal(failedSuccessor.status, "rollback");
    if (failedSuccessor.status !== "rollback") {
      throw new Error("expected successor rollback");
    }
    assert.equal(failedSuccessor.move.action, "rollback");
    assert.equal(failedSuccessor.move.priorRevision, SUCCESSOR_REVISION);
    assert.equal(failedSuccessor.move.priorGeneration, SUCCESSOR_GENERATION);
    assert.equal(failedSuccessor.move.nextRevision, REVIEW_MODEL);
    assert.equal(failedSuccessor.move.nextGeneration, 39);
    assert.equal(
      failedSuccessor.move.nextGeneration,
      failedSuccessor.move.priorGeneration + 1,
    );
    assert.equal(
      canonicalStringify(failedSuccessor.move.priorHealthyProof),
      canonicalStringify(reviewModelHealthy),
    );

    // A successor failure that does not bind the exact pointer, a
    // no-execution settlement and a missing retained prior never roll back.
    const successorWaits = [
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: SUCCESSOR_REVISION,
          generation: SUCCESSOR_GENERATION,
          healthyProof: reviewModelHealthy,
          executionProof: failedProof(SUCCESSOR_REVISION, 37, 154),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: SUCCESSOR_REVISION,
          generation: SUCCESSOR_GENERATION,
          healthyProof: reviewModelHealthy,
          executionProof: notStartedProof(
            SUCCESSOR_REVISION,
            SUCCESSOR_GENERATION,
          ),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: SUCCESSOR_REVISION,
          generation: SUCCESSOR_GENERATION,
          executionProof: failedProof(SUCCESSOR_REVISION, 38, 155),
        }),
      }),
    ];
    for (const state of successorWaits) {
      const plan = planOwnerDevelopmentInstall(state, NOW);
      assert.notEqual(plan.status, "rollback");
      assert.equal(plan.status, "waiting");
    }

    // The post-rollback review model generation 39 pointer is terminal: it is
    // outside the one-shot chain and never reattempts either movement.
    for (
      const healthy of [
        healthyProof(REVIEW_MODEL, 39, 156),
        null,
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: runtimeRecord({
              revision: REVIEW_MODEL,
              generation: 39,
              healthyProof: healthy,
            }),
          }),
          NOW,
        ).status,
        "no_change",
      );
    }

    // A failed generation 37 candidate settles exactly once by rolling back
    // to the exact previously proven generation 36 revision with a monotonic
    // generation 38, authorized by its recorded healthy proof.
    const failed = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REVIEW_MODEL,
          generation: REVIEW_MODEL_GENERATION,
          healthyProof: baseFetchHealthy,
          executionProof: failedProof(
            REVIEW_MODEL,
            REVIEW_MODEL_GENERATION,
            145,
          ),
        }),
      }),
      NOW,
    );
    assert.equal(failed.status, "rollback");
    if (failed.status !== "rollback") throw new Error("expected rollback");
    assert.equal(failed.move.action, "rollback");
    assert.equal(failed.move.priorRevision, REVIEW_MODEL);
    assert.equal(failed.move.priorGeneration, REVIEW_MODEL_GENERATION);
    assert.equal(failed.move.nextRevision, BASE_FETCH);
    assert.equal(failed.move.nextGeneration, 38);
    assert.equal(failed.move.nextGeneration, failed.move.priorGeneration + 1);
    assert.equal(
      canonicalStringify(failed.move.priorHealthyProof),
      canonicalStringify(baseFetchHealthy),
    );

    // A failure that does not bind the exact pointer, a no-execution
    // settlement and a missing recorded prior never roll back.
    const waits = [
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REVIEW_MODEL,
          generation: REVIEW_MODEL_GENERATION,
          healthyProof: baseFetchHealthy,
          executionProof: failedProof(REVIEW_MODEL, 36, 146),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REVIEW_MODEL,
          generation: REVIEW_MODEL_GENERATION,
          healthyProof: baseFetchHealthy,
          executionProof: notStartedProof(
            REVIEW_MODEL,
            REVIEW_MODEL_GENERATION,
          ),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REVIEW_MODEL,
          generation: REVIEW_MODEL_GENERATION,
          executionProof: failedProof(
            REVIEW_MODEL,
            REVIEW_MODEL_GENERATION,
            147,
          ),
        }),
      }),
    ];
    for (const state of waits) {
      const plan = planOwnerDevelopmentInstall(state, NOW);
      assert.notEqual(plan.status, "rollback");
      assert.equal(plan.status, "waiting");
    }

    // The post-rollback base fetch generation 38 pointer is terminal: it is
    // outside the one-shot chain and never reattempts either movement.
    for (
      const healthy of [
        healthyProof(BASE_FETCH, 38, 148),
        null,
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: runtimeRecord({
              revision: BASE_FETCH,
              generation: 38,
              healthyProof: healthy,
            }),
          }),
          NOW,
        ).status,
        "no_change",
      );
    }
  },
);

Deno.test(
  "owner development install snapshot: only the planned runtime fields change and historical proof is preserved",
  () => {
    const readerHealthy = healthyProof(READER, 6, 81);
    const originalHealthy = healthyProof(ORIGINAL, 5, 82);

    const installState = releaseSnapshot({
      runtime: runtimeRecord({
        revision: READER,
        generation: 6,
        healthyProof: readerHealthy,
        executionProof: readerHealthy,
      }),
      hostedReleases: [acceptedRelease()],
      cooldowns: [cooldown(NOW - 1)],
    });
    const rollbackState = releaseSnapshot({
      runtime: runtimeRecord({
        revision: READER,
        generation: 6,
        healthyProof: originalHealthy,
        executionProof: failedProof(READER, 6, 83),
      }),
      hostedReleases: [acceptedRelease()],
      cooldowns: [cooldown(NOW - 1)],
    });

    for (const state of [installState, rollbackState]) {
      const before = canonicalStringify(state);
      const plan = planOwnerDevelopmentInstall(state, NOW);
      assert.ok(plan.status === "install" || plan.status === "rollback");
      if (plan.status !== "install" && plan.status !== "rollback") {
        throw new Error("expected a move");
      }
      const planned = buildOwnerDevelopmentInstallSnapshot(
        state,
        STATE_HEAD,
        plan.move,
        NOW,
      );
      const priorRuntime = state.hostedRuntimes[0];
      const nextRuntime = planned.hostedRuntimes[0];

      assert.equal(planned.version, "v1");
      assert.equal(planned.kind, "release_state_snapshot");
      assert.equal(planned.sequence, state.sequence + 1);
      assert.equal(planned.stateHead, STATE_HEAD);
      assert.equal(planned.updatedAt, NOW);
      assert.equal(
        canonicalStringify(planned.releases),
        canonicalStringify(state.releases),
      );
      assert.equal(
        canonicalStringify(planned.hostedReleases),
        canonicalStringify(state.hostedReleases),
      );
      assert.equal(
        canonicalStringify(planned.githubCooldowns),
        canonicalStringify(state.githubCooldowns),
      );
      assert.equal(planned.hostedRuntimes.length, 1);
      assert.equal(nextRuntime.id, priorRuntime.id);
      assert.equal(nextRuntime.activeRevision, plan.move.nextRevision);
      assert.equal(nextRuntime.generation, plan.move.nextGeneration);
      assert.equal(nextRuntime.nextOrdinaryAt, NOW);
      assert.equal(nextRuntime.updatedAt, NOW);
      assert.equal(nextRuntime.createdAt, priorRuntime.createdAt);
      assert.equal(nextRuntime.execution, null);
      assert.equal(
        canonicalStringify(nextRuntime.lastHealthyProof),
        canonicalStringify(priorRuntime.lastHealthyProof),
      );
      assert.equal(
        canonicalStringify(nextRuntime.lastExecutionProof),
        canonicalStringify(priorRuntime.lastExecutionProof),
      );
      // The planning boundary never mutates its input snapshot.
      assert.equal(canonicalStringify(state), before);
    }

    // A move that does not bind the exact read pointer is refused outright.
    const plan = planOwnerDevelopmentInstall(installState, NOW);
    if (plan.status !== "install") throw new Error("expected install");
    assert.throws(() =>
      buildOwnerDevelopmentInstallSnapshot(
        installState,
        STATE_HEAD,
        { ...plan.move, priorGeneration: 2 },
        NOW,
      )
    );
  },
);

Deno.test(
  "owner development install files: canonical manifest, digest record path and bounded commit record",
  async () => {
    const proof = healthyProof(READER, 6, 91);
    const state = releaseSnapshot({
      runtime: runtimeRecord({
        revision: READER,
        generation: 6,
        healthyProof: proof,
        executionProof: proof,
      }),
      hostedReleases: [acceptedRelease()],
    });
    const plan = planOwnerDevelopmentInstall(state, NOW);
    if (plan.status !== "install") throw new Error("expected install");
    const planned = buildOwnerDevelopmentInstallSnapshot(
      state,
      STATE_HEAD,
      plan.move,
      NOW,
    );

    const files = await ownerDevelopmentInstallFiles(planned, STATE_HEAD);
    assert.equal(files.manifest.path, "manifest.json");
    const manifest = JSON.parse(files.manifest.text);
    assert.equal(manifest.version, "v1");
    assert.equal(manifest.kind, "release_state_manifest");
    assert.equal(manifest.sequence, state.sequence + 1);
    assert.equal(manifest.updatedAt, NOW);
    assert.equal(manifest.stateHead, STATE_HEAD);
    assert.equal(
      files.manifest.text,
      `${canonicalStringify(manifest)}\n`,
    );

    const runtime = planned.hostedRuntimes[0];
    const digest = await rawSha256(HOSTED_RUNTIME_ID);
    assert.equal(
      files.record.path,
      `hostedRuntimes/${digest}.json`,
    );
    assert.match(files.record.path, /^hostedRuntimes\/[0-9a-f]{64}\.json$/);
    assert.equal(
      files.record.text,
      `${canonicalStringify(runtime)}\n`,
    );
    const reread = JSON.parse(files.record.text);
    assert.equal(reread.id, HOSTED_RUNTIME_ID);
    assert.equal(reread.activeRevision, plan.move.nextRevision);
    assert.equal(reread.generation, plan.move.nextGeneration);
    assert.equal(reread.nextOrdinaryAt, NOW);

    const record = {
      version: "v1" as const,
      kind: "owner_development_install" as const,
      authority: "owner" as const,
      action: plan.move.action,
      authorizedAt: NOW,
      priorRevision: plan.move.priorRevision,
      priorGeneration: plan.move.priorGeneration,
      nextRevision: plan.move.nextRevision,
      nextGeneration: plan.move.nextGeneration,
      stateHead: STATE_HEAD,
      priorHealthyProof: plan.move.priorHealthyProof,
      nonce: "a".repeat(64),
    };
    const message = ownerDevelopmentInstallCommitMessage(record);
    assert.ok(message.startsWith("owner-development-install\n\n"));
    assert.ok(message.length < 8_192);
    const lines = message.trim().split("\n");
    const parsed = JSON.parse(lines[lines.length - 1]);
    assert.equal(parsed.kind, "owner_development_install");
    assert.equal(parsed.authority, "owner");
    assert.equal(parsed.action, "install");
    assert.equal(parsed.authorizedAt, NOW);
    assert.equal(parsed.priorRevision, plan.move.priorRevision);
    assert.equal(parsed.priorGeneration, plan.move.priorGeneration);
    assert.equal(parsed.nextRevision, AGGREGATE);
    assert.equal(parsed.nextGeneration, 7);
    assert.equal(parsed.stateHead, STATE_HEAD);
    assert.equal(parsed.nonce, "a".repeat(64));
    assert.equal(
      canonicalStringify(parsed.priorHealthyProof),
      canonicalStringify(proof),
    );

    // A malformed record is refused instead of serialized.
    assert.throws(() =>
      ownerDevelopmentInstallCommitMessage({ ...record, nonce: "not-a-nonce" })
    );
  },
);
