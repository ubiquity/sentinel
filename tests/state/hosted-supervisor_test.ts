/**
 * Hosted supervisor storage: real temporary Git roundtrip through the existing
 * release state ref (separate collections, no manifest change, no fabricated
 * Deno release records) and store-level transition enforcement across the
 * corrected settlement sequence. No network, model, credential or GitHub
 * write.
 */
import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import {
  HOSTED_RUNTIME_ID,
  parseHostedExecutionIntentV1,
  parseHostedReleaseRecordV1,
  parseHostedRunProofV1,
  parseHostedRuntimeRecordV1,
} from "../../src/contracts/hosted-supervisor.ts";
import type {
  HostedExecutionIntentV1,
  HostedRunProofV1,
} from "../../src/contracts/hosted-supervisor.ts";
import type { StateReadView } from "../../src/contracts/ports.ts";
import { parseReleaseRequestV1 } from "../../src/contracts/release.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
} from "../../src/state/mod.ts";
import { makeRemoteCtx, T0, testGitEnv } from "./helpers.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/state\/hosted-supervisor_test\.ts$/,
  "",
);

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
    createdAt: T0,
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
    startedAt: T0 + 1000,
    finishedAt: T0 + 2000,
    observedAt: T0 + 3000,
    outcome: "healthy",
    startupReady: true,
    settled: true,
    baseSha: SHA_A,
    terminalAt: T0 + 1500,
    logDigest: DIGEST,
    ...overrides,
  });
}

function failedProof(intent: HostedExecutionIntentV1): HostedRunProofV1 {
  return proof({
    execution: intent,
    outcome: "failed",
    startupReady: false,
    baseSha: null,
    terminalAt: null,
  });
}

function releaseRequest() {
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
    createdAt: T0 - 1000,
  });
}

function requestedRelease() {
  return parseHostedReleaseRecordV1({
    version: "v1",
    kind: "hosted_release",
    id: "release-1",
    request: releaseRequest(),
    priorRevision: SHA_A,
    phase: "requested",
    priorProof: null,
    candidateProof: null,
    rollbackProof: null,
    pointerIntent: null,
    createdAt: T0,
    updatedAt: T0 + 2000,
  });
}

function promotingRelease(priorHealthy: HostedRunProofV1) {
  return parseHostedReleaseRecordV1({
    version: "v1",
    kind: "hosted_release",
    id: "release-1",
    request: releaseRequest(),
    priorRevision: SHA_A,
    phase: "promoting",
    priorProof: priorHealthy,
    candidateProof: null,
    rollbackProof: null,
    pointerIntent: {
      action: "promote",
      expectedRevision: SHA_A,
      nextRevision: SHA_B,
      expectedGeneration: 1,
      createdAt: T0 + 1000,
    },
    createdAt: T0,
    updatedAt: T0 + 2000,
  });
}

function verifyingRelease(priorHealthy: HostedRunProofV1) {
  return parseHostedReleaseRecordV1({
    version: "v1",
    kind: "hosted_release",
    id: "release-1",
    request: releaseRequest(),
    priorRevision: SHA_A,
    phase: "verifying",
    priorProof: priorHealthy,
    candidateProof: null,
    rollbackProof: null,
    pointerIntent: null,
    createdAt: T0,
    updatedAt: T0 + 2000,
  });
}

function acceptedRelease(
  priorHealthy: HostedRunProofV1,
  candidateHealthy: HostedRunProofV1,
) {
  return parseHostedReleaseRecordV1({
    version: "v1",
    kind: "hosted_release",
    id: "release-1",
    request: releaseRequest(),
    priorRevision: SHA_A,
    phase: "accepted",
    priorProof: priorHealthy,
    candidateProof: candidateHealthy,
    rollbackProof: null,
    pointerIntent: null,
    createdAt: T0,
    updatedAt: T0 + 3000,
  });
}

function runtime(
  overrides: Record<string, unknown> = {},
) {
  return parseHostedRuntimeRecordV1({
    version: "v1",
    kind: "hosted_runtime",
    id: HOSTED_RUNTIME_ID,
    activeRevision: SHA_A,
    generation: 1,
    lastHealthyProof: null,
    lastExecutionProof: null,
    nextOrdinaryAt: T0,
    execution: execution({
      purpose: "bootstrap",
      revision: SHA_A,
      generation: 1,
      releaseId: null,
    }),
    createdAt: T0,
    updatedAt: T0 + 2000,
    ...overrides,
  });
}

function snapshot(input: {
  stateHead: GitSha | null;
  sequence: number;
  updatedAt: number;
  releases?: ReleaseStateSnapshotV1["releases"];
  hostedRuntimes: ReleaseStateSnapshotV1["hostedRuntimes"];
  hostedReleases: ReleaseStateSnapshotV1["hostedReleases"];
}): ReleaseStateSnapshotV1 {
  return {
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: input.stateHead,
    sequence: input.sequence,
    updatedAt: input.updatedAt,
    releases: input.releases ?? [],
    hostedRuntimes: input.hostedRuntimes,
    hostedReleases: input.hostedReleases,
  };
}

async function makeCtx(prefix: string) {
  const tmp = await Deno.makeTempDir({
    prefix: `sentinel-hosted-${prefix}-`,
    dir: ROOT,
  });
  const env = testGitEnv(`${tmp}/git-home`);
  await Deno.mkdir(`${tmp}/git-home`, { recursive: true });
  const remote = await makeRemoteCtx(tmp, env);
  return {
    tmp,
    remoteUrl: remote.remoteUrl,
    cleanup: async () => {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    },
  };
}

Deno.test(
  "hosted supervisor state: real Git roundtrip stores both collections and reads them through the repair facade",
  async () => {
    const ctx = await makeCtx("roundtrip");
    try {
      const release = createReleaseStateStore({
        scratchDir: `${ctx.tmp}/release-scratch`,
        remoteUrl: ctx.remoteUrl,
      });
      const seed = snapshot({
        stateHead: null,
        sequence: 1,
        updatedAt: T0,
        hostedRuntimes: [runtime()],
        hostedReleases: [requestedRelease()],
      });
      const written = await release.writeRelease(seed, null);
      assert.ok(written.ok, JSON.stringify(written));
      if (written.ok) assert.equal(written.value.status, "applied");

      // The read-only repair facade reads the release ref without any release
      // write capability and sees the hosted collections.
      const readOnly: StateReadView = createRepairStateStore({
        scratchDir: `${ctx.tmp}/repair-scratch`,
        remoteUrl: ctx.remoteUrl,
      });
      const read = await readOnly.readRelease();
      assert.ok(read.ok && read.value.status === "found");
      if (!read.ok || read.value.status !== "found") {
        throw new Error("missing release state");
      }
      assert.deepEqual(read.value.snapshot.hostedRuntimes, seed.hostedRuntimes);
      assert.deepEqual(read.value.snapshot.hostedReleases, seed.hostedReleases);
      assert.deepEqual(read.value.snapshot.releases, []);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "hosted supervisor state: failure settlement, retry, intent-before-pointer and atomic movement through real Git",
  async () => {
    const ctx = await makeCtx("progression");
    try {
      const store = createReleaseStateStore({
        scratchDir: `${ctx.tmp}/release-scratch`,
        remoteUrl: ctx.remoteUrl,
      });
      const bootIntent = execution({
        purpose: "bootstrap",
        revision: SHA_A,
        generation: 1,
        releaseId: null,
      });
      const seed = snapshot({
        stateHead: null,
        sequence: 1,
        updatedAt: T0,
        hostedRuntimes: [runtime({ execution: bootIntent })],
        hostedReleases: [requestedRelease()],
      });
      const seeded = await store.writeRelease(seed, null);
      assert.ok(seeded.ok && seeded.value.status === "applied");
      let head: GitSha | null = null;
      if (seeded.ok && seeded.value.status === "applied") {
        head = seeded.value.head;
      }
      const write = (next: ReleaseStateSnapshotV1) =>
        store.writeRelease(next, head);

      // Clearing the active execution without its exact settlement refuses.
      const cleared = await write(snapshot({
        stateHead: head,
        sequence: 2,
        updatedAt: T0 + 1,
        hostedRuntimes: [runtime({
          execution: null,
          lastExecutionProof: null,
          updatedAt: T0 + 2001,
        })],
        hostedReleases: [requestedRelease()],
      }));
      assert.equal(cleared.ok, false);
      if (!cleared.ok) {
        assert.equal(
          cleared.error.detail,
          "hosted runtime execution cannot be cleared without its exact settlement proof",
        );
      }

      // Rewriting the stored request refuses (canonical full-request binding).
      const rewrittenRequest = parseHostedReleaseRecordV1({
        ...requestedRelease(),
        request: parseReleaseRequestV1({
          ...releaseRequest(),
          source: {
            pullRequest: 1,
            reviewRequestId: "review-req-1",
            reviewReceiptId: "other-receipt",
            head: SHA_B,
            base: SHA_A,
          },
        }),
      });
      const rewritten = await write(snapshot({
        stateHead: head,
        sequence: 2,
        updatedAt: T0 + 1,
        hostedRuntimes: [runtime({ execution: bootIntent })],
        hostedReleases: [rewrittenRequest],
      }));
      assert.equal(rewritten.ok, false);
      if (!rewritten.ok) {
        assert.equal(
          rewritten.error.detail,
          "hosted release request is immutable",
        );
      }

      // Failed bootstrap settlement: clears the execution and records the
      // failed proof in lastExecutionProof; no fake healthy claim.
      const failedBoot = failedProof(bootIntent);
      const bootSettled = await write(snapshot({
        stateHead: head,
        sequence: 2,
        updatedAt: T0 + 2,
        hostedRuntimes: [runtime({
          execution: null,
          lastExecutionProof: failedBoot,
          updatedAt: T0 + 2002,
        })],
        hostedReleases: [requestedRelease()],
      }));
      assert.ok(bootSettled.ok && bootSettled.value.status === "applied");
      if (!bootSettled.ok || bootSettled.value.status !== "applied") return;
      head = bootSettled.value.head;

      // A retry starts a NEW ordinary execution in a LATER write.
      const ordinaryIntent = execution({
        runId: 2,
        id: "2:1:repair",
        purpose: "ordinary",
        revision: SHA_A,
        generation: 1,
        releaseId: null,
      });
      const retry = await write(snapshot({
        stateHead: head,
        sequence: 3,
        updatedAt: T0 + 3,
        hostedRuntimes: [runtime({
          execution: ordinaryIntent,
          lastExecutionProof: failedBoot,
          updatedAt: T0 + 2003,
        })],
        hostedReleases: [requestedRelease()],
      }));
      assert.ok(retry.ok && retry.value.status === "applied");
      if (!retry.ok || retry.value.status !== "applied") return;
      head = retry.value.head;

      // Replacing the active execution in one write refuses.
      const replacement = await write(snapshot({
        stateHead: head,
        sequence: 4,
        updatedAt: T0 + 4,
        hostedRuntimes: [runtime({
          execution: execution({
            runId: 3,
            id: "3:1:repair",
            purpose: "ordinary",
            revision: SHA_A,
            generation: 1,
            releaseId: null,
          }),
          lastExecutionProof: failedBoot,
          updatedAt: T0 + 2004,
        })],
        hostedReleases: [requestedRelease()],
      }));
      assert.equal(replacement.ok, false);
      if (!replacement.ok) {
        assert.equal(
          replacement.error.detail,
          "an existing hosted runtime execution cannot be replaced",
        );
      }

      // Healthy ordinary settlement updates both runtime proofs to the same
      // exact proof.
      const healthyOrdinary = proof({ execution: ordinaryIntent });
      const ordinarySettled = await write(snapshot({
        stateHead: head,
        sequence: 4,
        updatedAt: T0 + 4,
        hostedRuntimes: [runtime({
          execution: null,
          lastExecutionProof: healthyOrdinary,
          lastHealthyProof: healthyOrdinary,
          updatedAt: T0 + 2004,
        })],
        hostedReleases: [requestedRelease()],
      }));
      assert.ok(
        ordinarySettled.ok && ordinarySettled.value.status === "applied",
      );
      if (!ordinarySettled.ok || ordinarySettled.value.status !== "applied") {
        return;
      }
      head = ordinarySettled.value.head;

      // A prior execution starts in a later write.
      const priorIntent = execution({
        runId: 4,
        id: "4:1:repair",
        purpose: "prior",
        revision: SHA_A,
        generation: 1,
      });
      const priorActive = await write(snapshot({
        stateHead: head,
        sequence: 5,
        updatedAt: T0 + 5,
        hostedRuntimes: [runtime({
          execution: priorIntent,
          lastExecutionProof: healthyOrdinary,
          lastHealthyProof: healthyOrdinary,
          updatedAt: T0 + 2005,
        })],
        hostedReleases: [requestedRelease()],
      }));
      assert.ok(priorActive.ok && priorActive.value.status === "applied");
      if (!priorActive.ok || priorActive.value.status !== "applied") return;
      head = priorActive.value.head;

      // Healthy prior settlement attaches the prior proof and the promote
      // intent in the same write (intent-before-pointer).
      const healthyPrior = proof({ execution: priorIntent });
      const promoting = await write(snapshot({
        stateHead: head,
        sequence: 6,
        updatedAt: T0 + 6,
        hostedRuntimes: [runtime({
          execution: null,
          lastExecutionProof: healthyPrior,
          lastHealthyProof: healthyPrior,
          updatedAt: T0 + 2006,
        })],
        hostedReleases: [promotingRelease(healthyPrior)],
      }));
      assert.ok(promoting.ok && promoting.value.status === "applied");
      if (!promoting.ok || promoting.value.status !== "applied") return;
      head = promoting.value.head;

      // An unrelated movement has no matching persisted intent.
      const unrelated = await write(snapshot({
        stateHead: head,
        sequence: 7,
        updatedAt: T0 + 7,
        hostedRuntimes: [runtime({
          activeRevision: SHA_C,
          generation: 2,
          execution: null,
          lastExecutionProof: healthyPrior,
          lastHealthyProof: healthyPrior,
          updatedAt: T0 + 2007,
        })],
        hostedReleases: [promotingRelease(healthyPrior)],
      }));
      assert.equal(unrelated.ok, false);
      if (!unrelated.ok) {
        assert.equal(
          unrelated.error.detail,
          "hosted runtime pointer movement has no exact persisted pointer intent and phase advance",
        );
      }

      // The exact atomic movement: revision/generation + 1, intent cleared,
      // phase promoting -> verifying, no active execution.
      const moved = await write(snapshot({
        stateHead: head,
        sequence: 7,
        updatedAt: T0 + 7,
        hostedRuntimes: [runtime({
          activeRevision: SHA_B,
          generation: 2,
          execution: null,
          lastExecutionProof: healthyPrior,
          lastHealthyProof: healthyPrior,
          updatedAt: T0 + 2007,
        })],
        hostedReleases: [verifyingRelease(healthyPrior)],
      }));
      assert.ok(moved.ok && moved.value.status === "applied");
      if (!moved.ok || moved.value.status !== "applied") return;
      head = moved.value.head;

      // The candidate execution starts only in a later write.
      const candidateIntent = execution({
        runId: 5,
        id: "5:1:repair",
        purpose: "candidate",
        revision: SHA_B,
        generation: 2,
      });
      const candidateActive = await write(snapshot({
        stateHead: head,
        sequence: 8,
        updatedAt: T0 + 8,
        hostedRuntimes: [runtime({
          activeRevision: SHA_B,
          generation: 2,
          execution: candidateIntent,
          lastExecutionProof: healthyPrior,
          lastHealthyProof: healthyPrior,
          updatedAt: T0 + 2008,
        })],
        hostedReleases: [verifyingRelease(healthyPrior)],
      }));
      assert.ok(
        candidateActive.ok && candidateActive.value.status === "applied",
      );
      if (!candidateActive.ok || candidateActive.value.status !== "applied") {
        return;
      }
      head = candidateActive.value.head;

      // Healthy candidate settlement attaches the candidate proof and accepts.
      const healthyCandidate = proof({ execution: candidateIntent });
      const accepted = await write(snapshot({
        stateHead: head,
        sequence: 9,
        updatedAt: T0 + 9,
        hostedRuntimes: [runtime({
          activeRevision: SHA_B,
          generation: 2,
          execution: null,
          lastExecutionProof: healthyCandidate,
          lastHealthyProof: healthyCandidate,
          updatedAt: T0 + 2009,
        })],
        hostedReleases: [acceptedRelease(healthyPrior, healthyCandidate)],
      }));
      assert.ok(accepted.ok && accepted.value.status === "applied");
      if (!accepted.ok || accepted.value.status !== "applied") return;
      head = accepted.value.head;

      // Terminal receipts cannot be edited and proofs cannot be rewritten.
      const terminalEdit = await write(snapshot({
        stateHead: head,
        sequence: 10,
        updatedAt: T0 + 10,
        hostedRuntimes: [runtime({
          activeRevision: SHA_B,
          generation: 2,
          execution: null,
          lastExecutionProof: healthyCandidate,
          lastHealthyProof: healthyCandidate,
          updatedAt: T0 + 2010,
        })],
        hostedReleases: [{
          ...acceptedRelease(healthyPrior, healthyCandidate),
          updatedAt: T0 + 3001,
        }],
      }));
      assert.equal(terminalEdit.ok, false);
      if (!terminalEdit.ok) {
        assert.equal(
          terminalEdit.error.detail,
          "a terminal hosted release receipt is immutable",
        );
      }
      const proofRewrite = await write(snapshot({
        stateHead: head,
        sequence: 10,
        updatedAt: T0 + 10,
        hostedRuntimes: [runtime({
          activeRevision: SHA_B,
          generation: 2,
          execution: null,
          lastExecutionProof: healthyCandidate,
          lastHealthyProof: healthyCandidate,
          updatedAt: T0 + 2010,
        })],
        hostedReleases: [{
          ...acceptedRelease(healthyPrior, healthyCandidate),
          candidateProof: { ...healthyCandidate, logDigest: "e".repeat(64) },
        }],
      }));
      assert.equal(proofRewrite.ok, false);
      if (!proofRewrite.ok) {
        assert.equal(
          proofRewrite.error.detail,
          "an existing hosted release proof is immutable",
        );
      }

      // The final accepted state is intact after every refused write.
      const final = await store.readRelease();
      assert.ok(final.ok && final.value.status === "found");
      if (!final.ok || final.value.status !== "found") return;
      assert.equal(final.value.snapshot.sequence, 9);
      assert.equal(final.value.snapshot.hostedReleases[0].phase, "accepted");
      const finalRuntime = final.value.snapshot.hostedRuntimes[0];
      assert.equal(finalRuntime.activeRevision, SHA_B);
      assert.equal(finalRuntime.generation, 2);
      assert.equal(finalRuntime.execution, null);
      assert.equal(
        finalRuntime.lastExecutionProof?.execution.id,
        candidateIntent.id,
      );
      assert.equal(finalRuntime.lastHealthyProof?.outcome, "healthy");
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "hosted supervisor state: the initial release snapshot cannot smuggle hosted history",
  async () => {
    const ctx = await makeCtx("initial");
    try {
      const store = createReleaseStateStore({
        scratchDir: `${ctx.tmp}/release-scratch`,
        remoteUrl: ctx.remoteUrl,
      });

      // A first runtime must be generation 1.
      const futureGeneration = await store.writeRelease(
        snapshot({
          stateHead: null,
          sequence: 1,
          updatedAt: T0,
          hostedRuntimes: [runtime({ generation: 2, execution: null })],
          hostedReleases: [requestedRelease()],
        }),
        null,
      );
      assert.equal(futureGeneration.ok, false);
      if (!futureGeneration.ok) {
        assert.equal(
          futureGeneration.error.detail,
          "the first hosted runtime must start at generation 1",
        );
      }

      // No historical settlement proof may be smuggled in.
      const historicalProof = await store.writeRelease(
        snapshot({
          stateHead: null,
          sequence: 1,
          updatedAt: T0,
          hostedRuntimes: [runtime({
            generation: 1,
            execution: null,
            lastExecutionProof: proof({
              execution: execution({
                purpose: "ordinary",
                revision: SHA_A,
                generation: 1,
                releaseId: null,
              }),
            }),
          })],
          hostedReleases: [requestedRelease()],
        }),
        null,
      );
      assert.equal(historicalProof.ok, false);
      if (!historicalProof.ok) {
        assert.equal(
          historicalProof.error.detail,
          "the first hosted runtime cannot claim historical proof",
        );
      }

      // A terminal hosted release receipt cannot be the initial record.
      const terminalReceipt = await store.writeRelease(
        snapshot({
          stateHead: null,
          sequence: 1,
          updatedAt: T0,
          hostedRuntimes: [],
          hostedReleases: [
            acceptedRelease(
              proof({
                execution: execution({
                  purpose: "prior",
                  revision: SHA_A,
                  generation: 1,
                }),
              }),
              proof(),
            ),
          ],
        }),
        null,
      );
      assert.equal(terminalReceipt.ok, false);
      if (!terminalReceipt.ok) {
        assert.equal(
          terminalReceipt.error.detail,
          "a new hosted release must start at requested with no proofs or pointer intent",
        );
      }

      // Every refused initial write left the release ref absent.
      const read = await store.readRelease();
      assert.ok(read.ok && read.value.status === "absent");
    } finally {
      await ctx.cleanup();
    }
  },
);
