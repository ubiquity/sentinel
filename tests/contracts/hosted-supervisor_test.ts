/**
 * Hosted supervisor records: strict parser rejection, phase/proof rules,
 * execution-settlement semantics, request binding and the fail-closed snapshot
 * transition validator. Pure contract tests only; no Git, network, model or
 * credentials.
 */
import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import {
  HOSTED_RUNTIME_ID,
  hostedReceiptBindsRequest,
  parseHostedExecutionIntentV1,
  parseHostedExecutionSettlementV1,
  parseHostedNotStartedProofV1,
  parseHostedReleaseRecordV1,
  parseHostedRunProofV1,
  parseHostedRuntimeRecordV1,
  validateHostedStateTransition,
} from "../../src/contracts/hosted-supervisor.ts";
import type {
  HostedExecutionIntentV1,
  HostedReleaseRecordV1,
  HostedRunProofV1,
  HostedRuntimeRecordV1,
} from "../../src/contracts/hosted-supervisor.ts";
import { parseReleaseRequestV1 } from "../../src/contracts/release.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { tryParse } from "../../src/contracts/validation.ts";

const T = 1786000000000;
const SHA_A = "a".repeat(40) as GitSha;
const SHA_B = "b".repeat(40) as GitSha;
const SHA_C = "c".repeat(40) as GitSha;
const DIGEST = "d".repeat(64);
const SELF = { owner: "ubiquity", name: "sentinel", installationId: 0 };

function execution(
  overrides: Record<string, unknown> = {},
): HostedExecutionIntentV1 {
  return parseHostedExecutionIntentV1({
    id: "1:1:repair",
    runId: 1,
    runAttempt: 1,
    launcherSha: SHA_C,
    purpose: "candidate",
    revision: SHA_B,
    generation: 2,
    releaseId: "release-1",
    createdAt: T,
    ...overrides,
  });
}

function proof(overrides: Record<string, unknown> = {}): HostedRunProofV1 {
  return parseHostedRunProofV1({
    execution: execution(),
    workflowId: 357012162,
    workflowPath: ".github/workflows/supervisor.yml",
    repository: "ubiquity/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    jobId: 9,
    startedAt: T + 1000,
    finishedAt: T + 2000,
    observedAt: T + 3000,
    outcome: "healthy",
    startupReady: true,
    settled: true,
    baseSha: SHA_A,
    terminalAt: T + 1500,
    logDigest: DIGEST,
    ...overrides,
  });
}

function failedProof(
  executionIntent: HostedExecutionIntentV1,
): HostedRunProofV1 {
  return proof({
    execution: executionIntent,
    outcome: "failed",
    startupReady: false,
    baseSha: null,
    terminalAt: null,
  });
}

function notStarted(
  executionIntent: HostedExecutionIntentV1,
  overrides: Record<string, unknown> = {},
) {
  return parseHostedNotStartedProofV1({
    execution: executionIntent,
    workflowId: 357012162,
    workflowPath: ".github/workflows/supervisor.yml",
    repository: "ubiquity/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    jobId: null,
    finishedAt: T + 500,
    observedAt: T + 1000,
    outcome: "not_started",
    evidenceDigest: DIGEST,
    ...overrides,
  });
}

function releaseRequest(overrides: Record<string, unknown> = {}) {
  return parseReleaseRequestV1({
    version: "v1",
    kind: "release_request",
    id: "release-1",
    target: { repository: { ...SELF }, environment: "production" },
    revision: SHA_B,
    source: {
      pullRequest: 1,
      reviewRequestId: "review-req-1",
      reviewReceiptId: "review-receipt-1",
      head: SHA_B,
      base: SHA_A,
    },
    status: "open",
    failureReason: null,
    createdAt: T - 1000,
    ...overrides,
  });
}

/** Purpose-"prior" execution healthy proof for revision SHA_A. */
function priorProof(): HostedRunProofV1 {
  return proof({
    execution: execution({ purpose: "prior", revision: SHA_A, generation: 1 }),
  });
}

function hostedRelease(
  overrides: Record<string, unknown> = {},
): HostedReleaseRecordV1 {
  return parseHostedReleaseRecordV1({
    version: "v1",
    kind: "hosted_release",
    id: "release-1",
    request: releaseRequest(),
    priorRevision: SHA_A,
    phase: "verifying",
    priorProof: priorProof(),
    candidateProof: null,
    rollbackProof: null,
    pointerIntent: null,
    createdAt: T,
    updatedAt: T + 2000,
    ...overrides,
  });
}

function runtime(
  overrides: Record<string, unknown> = {},
): HostedRuntimeRecordV1 {
  return parseHostedRuntimeRecordV1({
    version: "v1",
    kind: "hosted_runtime",
    id: HOSTED_RUNTIME_ID,
    activeRevision: SHA_B,
    generation: 2,
    lastHealthyProof: null,
    lastExecutionProof: null,
    nextOrdinaryAt: T,
    execution: execution(),
    createdAt: T,
    updatedAt: T + 2000,
    ...overrides,
  });
}

function releaseSnapshot(overrides: Record<string, unknown> = {}) {
  return parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T,
    releases: [],
    hostedRuntimes: [],
    hostedReleases: [],
    githubCooldowns: [],
    ...overrides,
  });
}

function rejected<T>(parser: (input: unknown) => T, input: unknown): boolean {
  return tryParse(parser, input).ok === false;
}

const BOOT_EXECUTION = execution({
  purpose: "bootstrap",
  revision: SHA_A,
  generation: 1,
  releaseId: null,
});

Deno.test("hosted supervisor: exact valid records parse and the request binds canonically", () => {
  const intent = execution();
  assert.equal(intent.id, "1:1:repair");
  assert.equal(intent.purpose, "candidate");
  assert.equal(intent.releaseId, "release-1");
  const runProof = proof();
  assert.equal(runProof.settled, true);
  assert.equal(runProof.outcome, "healthy");
  const settled = runtime({
    execution: null,
    lastExecutionProof: failedProof(BOOT_EXECUTION),
  });
  assert.equal(settled.lastExecutionProof?.outcome, "failed");
  assert.equal(settled.lastHealthyProof, null);
  const release = hostedRelease();
  assert.equal(release.phase, "verifying");
  assert.equal(release.priorProof?.execution.purpose, "prior");
  const snapshot = releaseSnapshot({
    hostedRuntimes: [runtime()],
    hostedReleases: [release],
  });
  assert.equal(snapshot.hostedRuntimes.length, 1);
  assert.equal(snapshot.hostedReleases.length, 1);
  // The reviewed request binds canonically; a changed request does not.
  assert.equal(hostedReceiptBindsRequest(release, releaseRequest()), true);
  assert.equal(
    hostedReceiptBindsRequest(
      release,
      releaseRequest({
        source: {
          pullRequest: 1,
          reviewRequestId: "review-req-1",
          reviewReceiptId: "other-receipt",
          head: SHA_B,
          base: SHA_A,
        },
      }),
    ),
    false,
  );
});

Deno.test("hosted supervisor: execution and proof reject foreign or unsettled metadata", () => {
  assert.ok(
    rejected(parseHostedExecutionIntentV1, { ...execution(), id: "1:1:other" }),
  );
  assert.ok(
    rejected(parseHostedExecutionIntentV1, {
      ...execution(),
      purpose: "ordinary",
      releaseId: "release-1",
    }),
  );
  assert.ok(
    rejected(parseHostedExecutionIntentV1, {
      ...execution(),
      purpose: "candidate",
      releaseId: null,
    }),
  );
  assert.ok(rejected(parseHostedRunProofV1, { ...proof(), workflowId: 1 }));
  assert.ok(
    rejected(parseHostedRunProofV1, {
      ...proof(),
      workflowPath: ".github/workflows/other.yml",
    }),
  );
  assert.ok(
    rejected(parseHostedRunProofV1, { ...proof(), repository: "ubiquity/x" }),
  );
  assert.ok(
    rejected(parseHostedRunProofV1, { ...proof(), ref: "refs/heads/x" }),
  );
  assert.ok(rejected(parseHostedRunProofV1, { ...proof(), settled: false }));
  assert.ok(
    rejected(parseHostedRunProofV1, { ...proof(), startupReady: false }),
  );
  assert.ok(rejected(parseHostedRunProofV1, { ...proof(), baseSha: null }));
  assert.ok(rejected(parseHostedRunProofV1, { ...proof(), terminalAt: null }));
  assert.ok(
    rejected(parseHostedRunProofV1, { ...proof(), terminalAt: T + 4000 }),
  );
  assert.ok(
    rejected(parseHostedRunProofV1, { ...proof(), observedAt: T + 500 }),
  );
  assert.ok(
    rejected(parseHostedRunProofV1, { ...proof(), startedAt: T - 5000 }),
  );
  // A failed proof may precede any terminal output but must be a settled job.
  const failed = failedProof(execution());
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.terminalAt, null);
  assert.equal(failed.settled, true);
});

Deno.test("hosted supervisor: runtime requires the settlement proof and never an already-settled execution", () => {
  const settled = failedProof(BOOT_EXECUTION);
  assert.ok(
    rejected(parseHostedRuntimeRecordV1, {
      version: "v1",
      kind: "hosted_runtime",
      id: HOSTED_RUNTIME_ID,
      activeRevision: SHA_A,
      generation: 1,
      lastHealthyProof: null,
      nextOrdinaryAt: T,
      execution: null,
      createdAt: T,
      updatedAt: T,
    }),
  );
  // The active execution cannot already be its own settlement.
  assert.ok(
    rejected(parseHostedRuntimeRecordV1, {
      ...runtime({
        activeRevision: SHA_A,
        generation: 1,
        execution: BOOT_EXECUTION,
      }),
      lastExecutionProof: settled,
    }),
  );
  assert.ok(
    rejected(parseHostedRuntimeRecordV1, {
      ...runtime({
        activeRevision: SHA_A,
        generation: 1,
        execution: BOOT_EXECUTION,
      }),
      lastHealthyProof: proof({ execution: BOOT_EXECUTION }),
    }),
  );
  // The deterministic execution id is the identity: altered metadata on the
  // settled intent does not make it a different, still-active execution.
  const alteredBoot = execution({
    purpose: "bootstrap",
    revision: SHA_A,
    generation: 1,
    releaseId: null,
    createdAt: T + 1000,
  });
  assert.ok(
    rejected(parseHostedRuntimeRecordV1, {
      ...runtime({
        activeRevision: SHA_A,
        generation: 1,
        execution: BOOT_EXECUTION,
      }),
      lastExecutionProof: failedProof(alteredBoot),
    }),
  );
  assert.ok(
    rejected(parseHostedRuntimeRecordV1, {
      ...runtime({
        activeRevision: SHA_A,
        generation: 1,
        execution: BOOT_EXECUTION,
      }),
      lastHealthyProof: proof({ execution: alteredBoot }),
    }),
  );
  // lastHealthyProof is healthy-only; lastExecutionProof may be failed.
  assert.ok(
    rejected(parseHostedRuntimeRecordV1, {
      ...runtime(),
      lastHealthyProof: settled,
    }),
  );
  const valid = runtime({
    activeRevision: SHA_A,
    generation: 1,
    execution: null,
    lastExecutionProof: settled,
  });
  assert.equal(valid.lastExecutionProof?.outcome, "failed");
});

Deno.test("hosted supervisor: release record rejects foreign requests, wrong or failed proofs and illegal phases", () => {
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      request: releaseRequest({
        target: {
          repository: {
            owner: "ubiquity",
            name: "sentinel",
            installationId: 7,
          },
          environment: "production",
        },
      }),
    }),
  );
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      request: releaseRequest({
        target: { repository: { ...SELF }, environment: "isolated" },
      }),
    }),
  );
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      request: releaseRequest({ status: "fulfilled" }),
    }),
  );
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      request: releaseRequest({
        source: {
          pullRequest: 1,
          reviewRequestId: "review-req-1",
          reviewReceiptId: null,
          head: SHA_B,
          base: SHA_A,
        },
      }),
    }),
  );
  assert.ok(
    rejected(parseHostedReleaseRecordV1, { ...hostedRelease(), id: "other" }),
  );
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      priorRevision: SHA_B,
    }),
  );
  // Wrong purpose / wrong head binding in proofs.
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      priorProof: proof(),
    }),
  );
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      phase: "accepted",
      candidateProof: proof({
        execution: execution({ purpose: "candidate", revision: SHA_A }),
      }),
    }),
  );
  // priorProof and rollbackProof are healthy-only.
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      priorProof: failedProof(
        execution({ purpose: "prior", revision: SHA_A, generation: 1 }),
      ),
    }),
  );
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      phase: "rollback_verifying",
      candidateProof: failedProof(execution()),
      rollbackProof: failedProof(
        execution({ purpose: "rollback", revision: SHA_A, generation: 1 }),
      ),
    }),
  );
  // A failed candidate is the first exact candidate result and is allowed.
  const rollbackPending = hostedRelease({
    phase: "rollback_pending",
    candidateProof: failedProof(execution()),
  });
  assert.equal(rollbackPending.phase, "rollback_pending");
  // Pointer intents exist only with their exact phase movement.
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      pointerIntent: {
        action: "promote",
        expectedRevision: SHA_A,
        nextRevision: SHA_B,
        expectedGeneration: 1,
        createdAt: T,
      },
    }),
  );
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      phase: "promoting",
      pointerIntent: null,
    }),
  );
  // A proof execution cannot precede the hosted receipt.
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      createdAt: T + 5000,
      updatedAt: T + 6000,
    }),
  );
});

Deno.test("hosted supervisor: snapshot requires the hosted collections and bounds the runtime pointer", () => {
  assert.ok(
    rejected(parseReleaseStateSnapshotV1, {
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T,
      releases: [],
      githubCooldowns: [],
    }),
  );
  assert.ok(
    rejected(parseReleaseStateSnapshotV1, {
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T,
      releases: [],
      hostedRuntimes: [runtime(), runtime()],
      hostedReleases: [],
      githubCooldowns: [],
    }),
  );
  assert.ok(
    rejected(parseReleaseStateSnapshotV1, {
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T,
      releases: [],
      hostedRuntimes: [],
      hostedReleases: [hostedRelease(), hostedRelease()],
      githubCooldowns: [],
    }),
  );
});

Deno.test("hosted supervisor: ordinary/bootstrap settlement clears only with the exact proof and a new run comes later", () => {
  const active = runtime({
    activeRevision: SHA_A,
    generation: 1,
    execution: BOOT_EXECUTION,
    updatedAt: T + 2000,
  });
  const settled = runtime({
    activeRevision: SHA_A,
    generation: 1,
    execution: null,
    lastExecutionProof: failedProof(BOOT_EXECUTION),
    updatedAt: T + 2001,
  });
  // A failed ordinary/bootstrap run settles; missing settlement stays pending.
  assert.equal(
    validateHostedStateTransition([active], [], [settled], []),
    null,
  );
  assert.equal(
    validateHostedStateTransition(
      [active],
      [],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: null,
          lastExecutionProof: null,
          updatedAt: T + 2001,
        }),
      ],
      [],
    ),
    "hosted runtime execution cannot be cleared without its exact settlement proof",
  );
  // An unrelated syntactically valid proof never settles it.
  assert.equal(
    validateHostedStateTransition(
      [active],
      [],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: null,
          lastExecutionProof: failedProof(
            execution({
              runId: 2,
              id: "2:1:repair",
              purpose: "ordinary",
              revision: SHA_A,
              generation: 1,
              releaseId: null,
            }),
          ),
          updatedAt: T + 2001,
        }),
      ],
      [],
    ),
    "hosted runtime execution cannot be cleared without its exact settlement proof",
  );
  // A failure preserves lastHealthyProof unchanged.
  const olderHealthy = proof({
    execution: execution({
      runId: 5,
      id: "5:1:repair",
      purpose: "ordinary",
      revision: SHA_A,
      generation: 1,
      releaseId: null,
    }),
  });
  assert.equal(
    validateHostedStateTransition(
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: BOOT_EXECUTION,
          lastHealthyProof: olderHealthy,
        }),
      ],
      [],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: null,
          lastExecutionProof: failedProof(BOOT_EXECUTION),
          lastHealthyProof: olderHealthy,
        }),
      ],
      [],
    ),
    null,
  );
  // A healthy settlement may update both proofs to the same exact proof.
  const healthyBoot = proof({ execution: BOOT_EXECUTION });
  assert.equal(
    validateHostedStateTransition(
      [active],
      [],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: null,
          lastExecutionProof: healthyBoot,
          lastHealthyProof: healthyBoot,
        }),
      ],
      [],
    ),
    null,
  );
  // A changed healthy proof must be the same exact settlement proof.
  const unrelatedHealthy = proof({
    execution: execution({
      runId: 6,
      id: "6:1:repair",
      purpose: "ordinary",
      revision: SHA_A,
      generation: 1,
      releaseId: null,
    }),
  });
  assert.equal(
    validateHostedStateTransition(
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: BOOT_EXECUTION,
          lastHealthyProof: olderHealthy,
        }),
      ],
      [],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: null,
          lastExecutionProof: healthyBoot,
          lastHealthyProof: unrelatedHealthy,
        }),
      ],
      [],
    ),
    "a healthy settlement must update both runtime proofs to the same exact proof",
  );
  // A retry is a NEW intent in a later write, never a rebind.
  const retry = execution({
    runId: 2,
    id: "2:1:repair",
    purpose: "ordinary",
    revision: SHA_A,
    generation: 1,
    releaseId: null,
  });
  assert.equal(
    validateHostedStateTransition(
      [settled],
      [],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: retry,
          lastExecutionProof: failedProof(BOOT_EXECUTION),
          updatedAt: T + 2002,
        }),
      ],
      [],
    ),
    null,
  );
  // The strict parser refuses an active execution equal to its own settlement,
  // so the transition guard fixture is assembled from valid parsed parts.
  const settledRebind = {
    ...runtime({
      activeRevision: SHA_A,
      generation: 1,
      execution: BOOT_EXECUTION,
      updatedAt: T + 2002,
    }),
    lastExecutionProof: failedProof(BOOT_EXECUTION),
  };
  assert.equal(
    validateHostedStateTransition([settled], [], [settledRebind], []),
    "a settled hosted runtime execution cannot be rebound",
  );
  // The same settled execution id with altered metadata is still refused.
  const alteredRebindExecution = execution({
    purpose: "bootstrap",
    revision: SHA_A,
    generation: 1,
    releaseId: null,
    createdAt: T + 1000,
  });
  const alteredRebind = {
    ...runtime({
      activeRevision: SHA_A,
      generation: 1,
      execution: alteredRebindExecution,
      updatedAt: T + 2002,
    }),
    lastExecutionProof: failedProof(BOOT_EXECUTION),
  };
  assert.equal(
    validateHostedStateTransition([settled], [], [alteredRebind], []),
    "a settled hosted runtime execution cannot be rebound",
  );
  assert.equal(
    validateHostedStateTransition(
      [active],
      [],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: execution({
            runId: 2,
            id: "2:1:repair",
            purpose: "ordinary",
            revision: SHA_A,
            generation: 1,
            releaseId: null,
          }),
          updatedAt: T + 2002,
        }),
      ],
      [],
    ),
    "an existing hosted runtime execution cannot be replaced",
  );
  assert.equal(
    validateHostedStateTransition(
      [settled],
      [],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: null,
          lastExecutionProof: failedProof(retry),
          updatedAt: T + 2002,
        }),
      ],
      [],
    ),
    "hosted runtime lastExecutionProof can only change on its exact execution settlement",
  );
});

Deno.test("hosted supervisor: pointer movement is atomic, intent-bound and never carries an execution", () => {
  const priorExec = execution({
    purpose: "prior",
    revision: SHA_A,
    generation: 1,
  });
  const priorHealthy = proof({ execution: priorExec });
  const moving = runtime({
    activeRevision: SHA_A,
    generation: 1,
    execution: null,
    lastExecutionProof: priorHealthy,
    lastHealthyProof: priorHealthy,
  });
  const moved = runtime({
    activeRevision: SHA_B,
    generation: 2,
    execution: null,
    lastExecutionProof: priorHealthy,
    lastHealthyProof: priorHealthy,
    updatedAt: T + 2001,
  });
  const promoting = () =>
    hostedRelease({
      phase: "promoting",
      priorProof: priorHealthy,
      pointerIntent: {
        action: "promote",
        expectedRevision: SHA_A,
        nextRevision: SHA_B,
        expectedGeneration: 1,
        createdAt: T + 1000,
      },
    });
  const verifying = () => hostedRelease({ phase: "verifying" });
  // Intent-before-pointer: the healthy prior settlement attaches the proof and
  // the intent in the same write that clears the prior execution.
  assert.equal(
    validateHostedStateTransition(
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: priorExec,
        }),
      ],
      [hostedRelease({ phase: "requested", priorProof: null })],
      [moving],
      [promoting()],
    ),
    null,
  );
  // A proof insertion without clearing its exact execution is refused.
  assert.equal(
    validateHostedStateTransition(
      [moving],
      [hostedRelease({ phase: "requested", priorProof: null })],
      [moving],
      [promoting()],
    ),
    "a newly attached hosted release proof must bind the exact settled execution",
  );
  assert.equal(
    validateHostedStateTransition(
      [moving],
      [promoting()],
      [moved],
      [verifying()],
    ),
    null,
  );
  // No movement without the matching prior intent.
  assert.equal(
    validateHostedStateTransition(
      [moving],
      [hostedRelease({ phase: "verifying" })],
      [moved],
      [verifying()],
    ),
    "hosted runtime pointer movement has no exact persisted pointer intent and phase advance",
  );
  // Movement must not set a new execution in the same write.
  assert.equal(
    validateHostedStateTransition(
      [moving],
      [promoting()],
      [
        runtime({
          activeRevision: SHA_B,
          generation: 2,
          execution: execution({
            runId: 2,
            id: "2:1:repair",
            purpose: "candidate",
            revision: SHA_B,
          }),
          lastExecutionProof: priorHealthy,
          lastHealthyProof: priorHealthy,
          updatedAt: T + 2001,
        }),
      ],
      [verifying()],
    ),
    "hosted runtime pointer movement requires no active execution",
  );
  // Movement is refused while an execution is still active.
  assert.equal(
    validateHostedStateTransition(
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: priorExec,
        }),
      ],
      [promoting()],
      [moved],
      [verifying()],
    ),
    "hosted runtime pointer movement requires no active execution",
  );
  // Generation jumps and same-revision generation changes stay refused.
  assert.equal(
    validateHostedStateTransition(
      [moving],
      [promoting()],
      [
        runtime({
          activeRevision: SHA_B,
          generation: 3,
          execution: null,
          lastExecutionProof: priorHealthy,
          lastHealthyProof: priorHealthy,
        }),
      ],
      [verifying()],
    ),
    "hosted runtime pointer movement requires exactly one generation increment",
  );
  assert.equal(
    validateHostedStateTransition(
      [moving],
      [promoting()],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 2,
          execution: null,
          lastExecutionProof: priorHealthy,
          lastHealthyProof: priorHealthy,
        }),
      ],
      [verifying()],
    ),
    "the same hosted runtime revision cannot change generation",
  );
  // Phase advance without the movement is refused.
  assert.equal(
    validateHostedStateTransition(
      [moving],
      [promoting()],
      [moving],
      [verifying()],
    ),
    "a hosted release phase advance requires the exact atomic pointer movement",
  );
});

Deno.test("hosted supervisor: failed prior and failed rollback settle in the runtime and retry deterministically", () => {
  const priorExec = execution({
    purpose: "prior",
    revision: SHA_A,
    generation: 1,
  });
  const requested = hostedRelease({ phase: "requested", priorProof: null });
  // Failed prior execution: clears the runtime, keeps the release requested.
  const failedPriorRuntime = runtime({
    activeRevision: SHA_A,
    generation: 1,
    execution: null,
    lastExecutionProof: failedProof(priorExec),
  });
  assert.equal(
    validateHostedStateTransition(
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: priorExec,
        }),
      ],
      [requested],
      [failedPriorRuntime],
      [requested],
    ),
    null,
  );
  // A later NEW prior run then settles healthy and attaches the proof.
  const retryPrior = execution({
    runId: 2,
    id: "2:1:repair",
    purpose: "prior",
    revision: SHA_A,
    generation: 1,
  });
  const retryActive = runtime({
    activeRevision: SHA_A,
    generation: 1,
    execution: retryPrior,
    lastExecutionProof: failedProof(priorExec),
    updatedAt: T + 2001,
  });
  assert.equal(
    validateHostedStateTransition(
      [failedPriorRuntime],
      [requested],
      [retryActive],
      [requested],
    ),
    null,
  );
  const healthyPrior = proof({ execution: retryPrior });
  assert.equal(
    validateHostedStateTransition(
      [retryActive],
      [requested],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: null,
          lastExecutionProof: healthyPrior,
          lastHealthyProof: healthyPrior,
          updatedAt: T + 2002,
        }),
      ],
      [
        hostedRelease({
          phase: "promoting",
          priorProof: healthyPrior,
          pointerIntent: {
            action: "promote",
            expectedRevision: SHA_A,
            nextRevision: SHA_B,
            expectedGeneration: 1,
            createdAt: T + 1000,
          },
        }),
      ],
    ),
    null,
  );

  // Failed rollback execution: clears the runtime, keeps rollback_verifying.
  const failedCandidateExec = execution({
    purpose: "candidate",
    revision: SHA_B,
    generation: 2,
  });
  const healthyPriorProof = proof({ execution: priorExec });
  const failedCandidate = failedProof(failedCandidateExec);
  const rollbackBase = runtime({
    activeRevision: SHA_A,
    generation: 3,
    execution: null,
    lastExecutionProof: failedCandidate,
    lastHealthyProof: healthyPriorProof,
  });
  const rollbackVerifying = hostedRelease({
    phase: "rollback_verifying",
    priorProof: healthyPriorProof,
    candidateProof: failedCandidate,
  });
  const rollbackExec = execution({
    runId: 3,
    id: "3:1:repair",
    purpose: "rollback",
    revision: SHA_A,
    generation: 3,
  });
  const rollbackActive = runtime({
    activeRevision: SHA_A,
    generation: 3,
    execution: rollbackExec,
    lastExecutionProof: failedCandidate,
    lastHealthyProof: healthyPriorProof,
    updatedAt: T + 2001,
  });
  assert.equal(
    validateHostedStateTransition(
      [rollbackBase],
      [rollbackVerifying],
      [rollbackActive],
      [rollbackVerifying],
    ),
    null,
  );
  const failedRollback = failedProof(rollbackExec);
  const rollbackFailed = runtime({
    activeRevision: SHA_A,
    generation: 3,
    execution: null,
    lastExecutionProof: failedRollback,
    lastHealthyProof: healthyPriorProof,
    updatedAt: T + 2002,
  });
  assert.equal(
    validateHostedStateTransition(
      [rollbackActive],
      [rollbackVerifying],
      [rollbackFailed],
      [rollbackVerifying],
    ),
    null,
  );
  // A later healthy rollback run attaches the rollback proof and closes.
  const retryRollback = execution({
    runId: 4,
    id: "4:1:repair",
    purpose: "rollback",
    revision: SHA_A,
    generation: 3,
  });
  const retryRollbackActive = runtime({
    activeRevision: SHA_A,
    generation: 3,
    execution: retryRollback,
    lastExecutionProof: failedRollback,
    lastHealthyProof: healthyPriorProof,
    updatedAt: T + 2003,
  });
  assert.equal(
    validateHostedStateTransition(
      [rollbackFailed],
      [rollbackVerifying],
      [retryRollbackActive],
      [rollbackVerifying],
    ),
    null,
  );
  const healthyRollback = proof({ execution: retryRollback });
  assert.equal(
    validateHostedStateTransition(
      [retryRollbackActive],
      [rollbackVerifying],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 3,
          execution: null,
          lastExecutionProof: healthyRollback,
          lastHealthyProof: healthyRollback,
          updatedAt: T + 2004,
        }),
      ],
      [
        hostedRelease({
          phase: "rolled_back",
          priorProof: healthyPriorProof,
          candidateProof: failedCandidate,
          rollbackProof: healthyRollback,
        }),
      ],
    ),
    null,
  );
});

Deno.test("hosted supervisor: newly attached release proofs bind the exact settled execution", () => {
  // Distinct deterministic execution identity from the default run 1 prior job.
  const candidateExec = execution({ runId: 2, id: "2:1:repair" });
  const priorHealthy = priorProof();
  const verifying = hostedRelease();
  const active = runtime({
    activeRevision: SHA_B,
    generation: 2,
    execution: candidateExec,
    lastHealthyProof: priorHealthy,
  });
  const healthyCandidate = proof({ execution: candidateExec });
  const settled = runtime({
    activeRevision: SHA_B,
    generation: 2,
    execution: null,
    lastExecutionProof: healthyCandidate,
    lastHealthyProof: healthyCandidate,
    updatedAt: T + 2001,
  });
  assert.equal(
    validateHostedStateTransition(
      [active],
      [verifying],
      [settled],
      [
        hostedRelease({
          phase: "accepted",
          priorProof: priorHealthy,
          candidateProof: healthyCandidate,
        }),
      ],
    ),
    null,
  );
  // An unrelated proof is never attached, even though it is valid in shape.
  const unrelated = proof({
    execution: execution({ runId: 9, id: "9:1:repair" }),
  });
  assert.equal(
    validateHostedStateTransition(
      [active],
      [verifying],
      [settled],
      [
        hostedRelease({
          phase: "accepted",
          priorProof: priorHealthy,
          candidateProof: unrelated,
        }),
      ],
    ),
    "a newly attached hosted release proof must bind the exact settled execution",
  );
  // A failed settlement cannot be laundered into a healthy candidate proof,
  // even for the same execution intent and phase.
  assert.equal(
    validateHostedStateTransition(
      [active],
      [verifying],
      [
        runtime({
          activeRevision: SHA_B,
          generation: 2,
          execution: null,
          lastExecutionProof: failedProof(candidateExec),
          lastHealthyProof: priorHealthy,
          updatedAt: T + 2001,
        }),
      ],
      [
        hostedRelease({
          phase: "accepted",
          priorProof: priorHealthy,
          candidateProof: healthyCandidate,
        }),
      ],
    ),
    "a newly attached hosted release proof must bind the exact settled execution",
  );
  // Changed digest or time on the same execution is a different proof.
  assert.equal(
    validateHostedStateTransition(
      [active],
      [verifying],
      [settled],
      [
        hostedRelease({
          phase: "accepted",
          priorProof: priorHealthy,
          candidateProof: proof({
            execution: candidateExec,
            logDigest: "e".repeat(64),
          }),
        }),
      ],
    ),
    "a newly attached hosted release proof must bind the exact settled execution",
  );
  assert.equal(
    validateHostedStateTransition(
      [active],
      [verifying],
      [settled],
      [
        hostedRelease({
          phase: "accepted",
          priorProof: priorHealthy,
          candidateProof: proof({
            execution: candidateExec,
            finishedAt: T + 2500,
          }),
        }),
      ],
    ),
    "a newly attached hosted release proof must bind the exact settled execution",
  );
  // A proof insertion without clearing an execution is refused.
  assert.equal(
    validateHostedStateTransition(
      [
        runtime({
          activeRevision: SHA_B,
          generation: 2,
          execution: null,
          lastHealthyProof: priorHealthy,
        }),
      ],
      [verifying],
      [
        runtime({
          activeRevision: SHA_B,
          generation: 2,
          execution: null,
          lastHealthyProof: priorHealthy,
        }),
      ],
      [
        hostedRelease({
          phase: "accepted",
          priorProof: priorHealthy,
          candidateProof: unrelated,
        }),
      ],
    ),
    "a newly attached hosted release proof must bind the exact settled execution",
  );
  // Once attached, a release proof is immutable and terminal receipts freeze.
  const accepted = hostedRelease({
    phase: "accepted",
    priorProof: priorHealthy,
    candidateProof: healthyCandidate,
    updatedAt: T + 3000,
  });
  assert.equal(
    validateHostedStateTransition(
      [settled],
      [accepted],
      [settled],
      [
        {
          ...accepted,
          candidateProof: proof({
            execution: candidateExec,
            outcome: "failed",
            startupReady: false,
            baseSha: null,
            terminalAt: null,
          }),
        },
      ],
    ),
    "an existing hosted release proof is immutable",
  );
  assert.equal(
    validateHostedStateTransition(
      [settled],
      [accepted],
      [settled],
      [{ ...accepted, updatedAt: T + 4000 } as HostedReleaseRecordV1],
    ),
    "a terminal hosted release receipt is immutable",
  );
  // A set pointer intent cannot change, and clears only on the exact movement.
  const promoting = hostedRelease({
    phase: "promoting",
    priorProof: priorHealthy,
    pointerIntent: {
      action: "promote",
      expectedRevision: SHA_A,
      nextRevision: SHA_B,
      expectedGeneration: 1,
      createdAt: T + 1000,
    },
  });
  assert.equal(
    validateHostedStateTransition(
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: null,
          lastExecutionProof: priorHealthy,
          lastHealthyProof: priorHealthy,
        }),
      ],
      [promoting],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: null,
          lastExecutionProof: priorHealthy,
          lastHealthyProof: priorHealthy,
        }),
      ],
      [
        hostedRelease({
          phase: "promoting",
          priorProof: priorHealthy,
          pointerIntent: {
            action: "promote",
            expectedRevision: SHA_A,
            nextRevision: SHA_B,
            expectedGeneration: 1,
            createdAt: T + 1500,
          },
        }),
      ],
    ),
    "a set hosted release pointer intent cannot change",
  );
  // New records start clean and runtimes never disappear or mutate identity.
  assert.equal(
    validateHostedStateTransition(
      [],
      [],
      [],
      [hostedRelease({ phase: "verifying" })],
    ),
    "a new hosted release must start at requested with no proofs or pointer intent",
  );
  assert.equal(
    validateHostedStateTransition(
      [],
      [],
      [],
      [hostedRelease({ phase: "requested", priorProof: null })],
    ),
    null,
  );
  assert.equal(
    validateHostedStateTransition(
      [],
      [],
      [runtime({ generation: 2, execution: null })],
      [],
    ),
    "the first hosted runtime must start at generation 1",
  );
  assert.equal(
    validateHostedStateTransition(
      [],
      [],
      [
        runtime({
          generation: 1,
          execution: null,
          lastHealthyProof: priorHealthy,
        }),
      ],
      [],
    ),
    "the first hosted runtime cannot claim a healthy proof",
  );
  assert.equal(
    validateHostedStateTransition(
      [],
      [],
      [
        runtime({
          generation: 1,
          execution: null,
          lastExecutionProof: priorHealthy,
        }),
      ],
      [],
    ),
    "the first hosted runtime cannot claim historical proof",
  );
  const runtimeRecord = runtime();
  assert.equal(
    validateHostedStateTransition([runtimeRecord], [], [], []),
    "existing hosted runtime cannot disappear",
  );
  assert.equal(
    validateHostedStateTransition(
      [runtimeRecord],
      [],
      [{ ...runtimeRecord, createdAt: runtimeRecord.createdAt + 1 }],
      [],
    ),
    "hosted runtime createdAt is immutable",
  );
  assert.equal(
    validateHostedStateTransition(
      [runtimeRecord],
      [],
      [{ ...runtimeRecord, updatedAt: runtimeRecord.updatedAt - 1 }],
      [],
    ),
    "hosted runtime updatedAt cannot move backward",
  );
  assert.equal(
    validateHostedStateTransition(
      [],
      [hostedRelease({ phase: "requested", priorProof: null })],
      [],
      [],
    ),
    "existing hosted release cannot disappear",
  );
});

Deno.test("hosted supervisor: no-execution settlement parses exactly and never fabricates run evidence", () => {
  const skipped = notStarted(BOOT_EXECUTION);
  assert.equal(skipped.outcome, "not_started");
  assert.equal(skipped.jobId, null);
  assert.equal(skipped.execution.id, "1:1:repair");
  const absent = notStarted(BOOT_EXECUTION, { jobId: 12 });
  assert.equal(absent.jobId, 12);
  // No start time, startup flag, base, terminal or log digest exists.
  assert.ok(
    rejected(parseHostedNotStartedProofV1, { ...skipped, startedAt: T + 1 }),
  );
  assert.ok(
    rejected(parseHostedNotStartedProofV1, { ...skipped, logDigest: DIGEST }),
  );
  assert.ok(
    rejected(parseHostedNotStartedProofV1, { ...skipped, startupReady: false }),
  );
  assert.ok(
    rejected(parseHostedNotStartedProofV1, { ...skipped, terminalAt: null }),
  );
  // Fixed identity, exact intent binding and digest.
  assert.ok(
    rejected(parseHostedNotStartedProofV1, { ...skipped, workflowId: 1 }),
  );
  assert.ok(
    rejected(parseHostedNotStartedProofV1, {
      ...skipped,
      workflowPath: ".github/workflows/other.yml",
    }),
  );
  assert.ok(
    rejected(parseHostedNotStartedProofV1, {
      ...skipped,
      repository: "ubiquity/x",
    }),
  );
  assert.ok(
    rejected(parseHostedNotStartedProofV1, { ...skipped, ref: "refs/heads/x" }),
  );
  assert.ok(
    rejected(parseHostedNotStartedProofV1, {
      ...skipped,
      evidenceDigest: "zz",
    }),
  );
  assert.ok(
    rejected(parseHostedNotStartedProofV1, { ...skipped, outcome: "failed" }),
  );
  assert.ok(
    rejected(parseHostedNotStartedProofV1, {
      ...skipped,
      execution: { ...skipped.execution, id: "9:9:repair" },
    }),
  );
  // Listing observation bounds use the same 999 ms tolerance.
  assert.ok(
    rejected(parseHostedNotStartedProofV1, {
      ...skipped,
      finishedAt: T - 5000,
    }),
  );
  assert.ok(
    rejected(parseHostedNotStartedProofV1, {
      ...skipped,
      finishedAt: T + 5000,
      observedAt: T + 500,
    }),
  );
  // Dispatcher: run proofs stay run proofs; unknown outcomes reject.
  assert.equal(parseHostedExecutionSettlementV1(proof()).outcome, "healthy");
  assert.equal(
    parseHostedExecutionSettlementV1(skipped).outcome,
    "not_started",
  );
  assert.ok(
    rejected(parseHostedExecutionSettlementV1, {
      ...skipped,
      outcome: "cancelled",
    }),
  );
  // Runtime accepts the settlement union; health remains run-proof only.
  const settled = runtime({ execution: null, lastExecutionProof: skipped });
  assert.equal(settled.lastExecutionProof?.outcome, "not_started");
  assert.ok(
    rejected(parseHostedRuntimeRecordV1, {
      ...runtime(),
      lastHealthyProof: skipped,
    }),
  );
});

Deno.test("hosted supervisor: not_started clears the intent only and retries at a later run", () => {
  const active = runtime({
    activeRevision: SHA_A,
    generation: 1,
    execution: BOOT_EXECUTION,
  });
  const settlement = notStarted(BOOT_EXECUTION);
  const cleared = runtime({
    activeRevision: SHA_A,
    generation: 1,
    execution: null,
    lastExecutionProof: settlement,
    updatedAt: T + 2001,
  });
  assert.equal(
    validateHostedStateTransition([active], [], [cleared], []),
    null,
  );
  // It can never claim health in the same write.
  const otherHealthy = proof({
    execution: execution({
      runId: 5,
      id: "5:1:repair",
      purpose: "ordinary",
      revision: SHA_A,
      generation: 1,
      releaseId: null,
    }),
  });
  assert.equal(
    validateHostedStateTransition(
      [active],
      [],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: null,
          lastExecutionProof: settlement,
          lastHealthyProof: otherHealthy,
          updatedAt: T + 2001,
        }),
      ],
      [],
    ),
    "a not_started settlement preserves lastHealthyProof",
  );
  // It can never move the pointer in the same write.
  assert.equal(
    validateHostedStateTransition(
      [active],
      [],
      [
        runtime({
          activeRevision: SHA_B,
          generation: 2,
          execution: null,
          lastExecutionProof: settlement,
          updatedAt: T + 2001,
        }),
      ],
      [],
    ),
    "a not_started settlement cannot move the runtime pointer",
  );
  // It can never attach a release proof.
  assert.equal(
    validateHostedStateTransition(
      [active],
      [hostedRelease({ phase: "requested", priorProof: null })],
      [cleared],
      [
        {
          ...hostedRelease(),
          phase: "promoting",
          priorProof: proof({ execution: BOOT_EXECUTION }),
          pointerIntent: {
            action: "promote",
            expectedRevision: SHA_A,
            nextRevision: SHA_B,
            expectedGeneration: 1,
            createdAt: T + 1000,
          },
        },
      ],
    ),
    "a not_started settlement cannot attach a release proof",
  );
  // A retry is a NEW run/attempt in a later write; the old one never rebinds.
  const retry = execution({
    runId: 2,
    id: "2:1:repair",
    purpose: "ordinary",
    revision: SHA_A,
    generation: 1,
    releaseId: null,
  });
  assert.equal(
    validateHostedStateTransition(
      [cleared],
      [],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: retry,
          lastExecutionProof: settlement,
          updatedAt: T + 2002,
        }),
      ],
      [],
    ),
    null,
  );
  // Same no-execution settlement rebound: the parser refuses the equal active
  // execution, so the transition guard fixture is assembled from valid parts.
  const notStartedRebind = {
    ...runtime({
      activeRevision: SHA_A,
      generation: 1,
      execution: BOOT_EXECUTION,
      updatedAt: T + 2002,
    }),
    lastExecutionProof: settlement,
  };
  assert.equal(
    validateHostedStateTransition([cleared], [], [notStartedRebind], []),
    "a settled hosted runtime execution cannot be rebound",
  );
});
