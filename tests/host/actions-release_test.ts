/**
 * Persisted hosted-supervisor release receipt reader.
 *
 * These tests drive the REAL `readHostedReleaseReceipt` helper over REAL
 * temporary Git release state whose receipts are advanced through the ACTUAL
 * supervisor core by the shared fixture, plus narrow read-only state fakes. No
 * network, no model, no raw workflow-green path and no real token.
 */
import assert from "node:assert/strict";

import { hostedReceiptBindsRequest } from "../../src/contracts/hosted-supervisor.ts";
import type {
  PortResultV1,
  StateReadResultV1,
  StateReadView,
} from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { parseReleaseRequestV1 } from "../../src/contracts/release.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { readHostedReleaseReceipt } from "../../src/host/actions-release.ts";
import { createReleaseStateStore } from "../../src/state/mod.ts";
import type { ReleaseGitStateStore } from "../../src/state/mod.ts";
import {
  makeRemoteCtx,
  SHA1,
  SHA2,
  SHA3,
  T0,
  testGitEnv,
} from "../state/helpers.ts";
import { persistHostedReceipt } from "./hosted-receipt-fixture.ts";
import type { HostedReceiptClockV1 } from "./hosted-receipt-fixture.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/host\/actions-release_test\.ts$/,
  "",
);

const SELF = { owner: "ubiquity", name: "sentinel", installationId: 0 };
const REQUEST_ID = "release-hosted-1";
const REVISION = SHA3;
const PRIOR = SHA2;

class FixtureClock implements HostedReceiptClockV1 {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

function request(overrides: Record<string, unknown> = {}): ReleaseRequestV1 {
  return parseReleaseRequestV1({
    version: "v1",
    kind: "release_request",
    id: REQUEST_ID,
    target: { repository: { ...SELF }, environment: "production" },
    revision: REVISION,
    source: {
      pullRequest: 30,
      reviewRequestId: "review-req-hosted-1",
      reviewReceiptId: "review-receipt-hosted-1",
      head: SHA1,
      base: PRIOR,
    },
    status: "open",
    failureReason: null,
    createdAt: T0,
    ...overrides,
  });
}

interface RigV1 {
  store: ReleaseGitStateStore;
  clock: FixtureClock;
  seedEmpty(): Promise<void>;
  cleanup(): Promise<void>;
}

async function makeRig(): Promise<RigV1> {
  const root = await Deno.makeTempDir({
    prefix: "sentinel-actions-release-",
    dir: ROOT,
  });
  const env = testGitEnv(`${root}/git-home`);
  await Deno.mkdir(`${root}/git-home`, { recursive: true });
  const remote = await makeRemoteCtx(root, env);
  const store = createReleaseStateStore({
    scratchDir: `${root}/scratch`,
    remoteUrl: remote.remoteUrl,
  });
  return {
    store,
    clock: new FixtureClock(T0),
    seedEmpty: async () => {
      const snapshot = parseReleaseStateSnapshotV1({
        version: "v1",
        kind: "release_state_snapshot",
        stateHead: null,
        sequence: 1,
        updatedAt: T0,
        releases: [],
        hostedRuntimes: [],
        hostedReleases: [],
        githubCooldowns: [],
      });
      const written = await store.writeRelease(snapshot, null);
      assert.ok(
        written.ok && written.value.status === "applied",
        JSON.stringify(written),
      );
    },
    cleanup: async () => {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

function fakeState(
  readRelease: () => Promise<
    PortResultV1<StateReadResultV1<ReleaseStateSnapshotV1>>
  >,
): StateReadView {
  return {
    readRepair: () => Promise.reject(new Error("unused readRepair")),
    readRelease,
  };
}

Deno.test("actions release: the persisted accepted receipt binds exactly and is returned", async () => {
  const rig = await makeRig();
  try {
    const held = request();
    const persisted = await persistHostedReceipt({
      release: rig.store,
      clock: rig.clock,
      request: held,
      priorRevision: PRIOR,
      phase: "accepted",
    });
    assert.equal(persisted.phase, "accepted");
    assert.equal(persisted.priorProof?.outcome, "healthy");
    assert.equal(persisted.candidateProof?.outcome, "healthy");
    assert.equal(persisted.rollbackProof, null);

    const result = await readHostedReleaseReceipt({ state: rig.store }, held);
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) throw new Error("unreachable");
    assert.ok(result.value !== null);
    if (result.value === null) throw new Error("unreachable");
    assert.equal(result.value.id, persisted.id);
    assert.equal(result.value.phase, "accepted");
    assert.ok(hostedReceiptBindsRequest(result.value, held));
    assert.equal(result.value.candidateProof?.outcome, "healthy");
    assert.equal(result.value.priorProof?.outcome, "healthy");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("actions release: the persisted rolled_back receipt carries the exact failed chain", async () => {
  const rig = await makeRig();
  try {
    const held = request();
    const persisted = await persistHostedReceipt({
      release: rig.store,
      clock: rig.clock,
      request: held,
      priorRevision: PRIOR,
      phase: "rolled_back",
    });
    assert.equal(persisted.phase, "rolled_back");
    assert.equal(persisted.priorProof?.outcome, "healthy");
    assert.equal(persisted.candidateProof?.outcome, "failed");
    assert.equal(persisted.rollbackProof?.outcome, "healthy");

    const result = await readHostedReleaseReceipt({ state: rig.store }, held);
    assert.ok(result.ok && result.value !== null, JSON.stringify(result));
    if (!result.ok || result.value === null) throw new Error("unreachable");
    assert.equal(result.value.phase, "rolled_back");
    assert.ok(hostedReceiptBindsRequest(result.value, held));
  } finally {
    await rig.cleanup();
  }
});

Deno.test("actions release: a missing record is null and an absent or unreadable state is unavailable", async () => {
  const rig = await makeRig();
  try {
    // Absent release state (nothing seeded) is unavailable, never null.
    const absent = await readHostedReleaseReceipt(
      { state: rig.store },
      request(),
    );
    assert.equal(absent.ok, false);
    if (!absent.ok) assert.equal(absent.error.kind, "unavailable");

    // A found snapshot without the record is an explicit null.
    await rig.seedEmpty();
    const missing = await readHostedReleaseReceipt(
      { state: rig.store },
      request(),
    );
    assert.ok(missing.ok && missing.value === null, JSON.stringify(missing));

    const unreadable = await readHostedReleaseReceipt({
      state: fakeState(() =>
        Promise.resolve(portError("unavailable", "state down"))
      ),
    }, request());
    assert.equal(unreadable.ok, false);

    const thrown = await readHostedReleaseReceipt({
      state: fakeState(() => Promise.reject(new Error("boom"))),
    }, request());
    assert.equal(thrown.ok, false);

    // A structurally corrupt snapshot is unavailable, never a null receipt.
    const corrupt = await readHostedReleaseReceipt({
      state: fakeState(() =>
        Promise.resolve(portOk({
          status: "found" as const,
          snapshot: {
            version: "v1",
            kind: "release_state_snapshot",
          } as unknown as ReleaseStateSnapshotV1,
          head: SHA1,
          ref: null,
        }))
      ),
    }, request());
    assert.equal(corrupt.ok, false);
    if (!corrupt.ok) assert.equal(corrupt.error.kind, "unavailable");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("actions release: a malformed stored record is unavailable", async () => {
  const rig = await makeRig();
  try {
    // Snapshot-shaped but with a malformed hosted release record.
    const malformed = await readHostedReleaseReceipt({
      state: fakeState(() =>
        Promise.resolve(portOk({
          status: "found" as const,
          snapshot: {
            version: "v1",
            kind: "release_state_snapshot",
            stateHead: null,
            sequence: 1,
            updatedAt: T0,
            releases: [],
            hostedRuntimes: [],
            hostedReleases: [{ version: "v1", kind: "hosted_release" }],
            githubCooldowns: [],
          } as unknown as ReleaseStateSnapshotV1,
          head: SHA1,
          ref: null,
        }))
      ),
    }, request());
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.equal(malformed.error.kind, "unavailable");

    // Same-id but differently-bound record: the stored bytes for the id are
    // not the requested identity, so no receipt is inferred.
    const held = request();
    await persistHostedReceipt({
      release: rig.store,
      clock: rig.clock,
      request: held,
      priorRevision: PRIOR,
      phase: "accepted",
    });
    const other = request({
      revision: SHA2,
      source: {
        pullRequest: 31,
        reviewRequestId: "review-req-hosted-1",
        reviewReceiptId: "review-receipt-hosted-1",
        head: SHA1,
        base: SHA2,
      },
    });
    const mismatch = await readHostedReleaseReceipt(
      { state: rig.store },
      other,
    );
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.error.kind, "unavailable");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("actions release: a foreign scope or malformed request is invalid", async () => {
  const rig = await makeRig();
  try {
    const foreign = request({
      target: {
        repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 7 },
        environment: "production",
      },
    });
    const result = await readHostedReleaseReceipt(
      { state: rig.store },
      foreign,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, "invalid");

    const malformed = await readHostedReleaseReceipt(
      { state: rig.store },
      { id: "not-a-request" } as unknown as ReleaseRequestV1,
    );
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.equal(malformed.error.kind, "invalid");
  } finally {
    await rig.cleanup();
  }
});
