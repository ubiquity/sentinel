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
  OWNER_DEVELOPMENT_INSTALL_DELIVERED_ROUND2_REVISION,
  OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_REVISION,
  OWNER_DEVELOPMENT_INSTALL_FINDINGS_REVISION,
  OWNER_DEVELOPMENT_INSTALL_GUARD_REVISION,
  OWNER_DEVELOPMENT_INSTALL_HISTORY_REVISION,
  OWNER_DEVELOPMENT_INSTALL_LEDGER_REVISION,
  OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_ORIGINAL_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_ORIGINAL_REVISION,
  OWNER_DEVELOPMENT_INSTALL_READER_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_READER_REVISION,
  OWNER_DEVELOPMENT_INSTALL_RECEIPT_REVISION,
  OWNER_DEVELOPMENT_INSTALL_RECOVERY_REVISION,
  OWNER_DEVELOPMENT_INSTALL_RELEASED_REVISION,
  OWNER_DEVELOPMENT_INSTALL_RETIRE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_REVISION,
  OWNER_DEVELOPMENT_INSTALL_REVIEWER_REVISION,
  OWNER_DEVELOPMENT_INSTALL_ROUND8_REVISION,
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
    // The model-route generation is the fixed end of the chain.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: MODEL_ROUTE,
            generation: 26,
            healthyProof: healthyProof(MODEL_ROUTE, 26, 97),
          }),
        }),
        NOW,
      ).status,
      "no_change",
    );
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
