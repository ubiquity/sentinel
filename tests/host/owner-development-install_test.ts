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
  OWNER_DEVELOPMENT_INSTALL_AGGREGATE_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_AGGREGATE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_ORIGINAL_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_ORIGINAL_REVISION,
  OWNER_DEVELOPMENT_INSTALL_READER_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_READER_REVISION,
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
      "no_change",
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
