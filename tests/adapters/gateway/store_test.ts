/**
 * LocalArtifactStore tests: the actual local restricted file-backed store —
 * atomic writes with restrictive perms, exact ref-to-digest path mapping,
 * symlink/path-traversal defense, immutability (same ref + different bytes
 * conflicts), capacity exhaustion without deleting active evidence, explicit
 * source-expiry vs local-retention expiry, restart durability and no
 * plaintext/key leakage in persisted metadata.
 */

import assert from "node:assert/strict";

import {
  type ArtifactStoreLimitsV1,
  LocalArtifactStore,
  parseArtifactRefIdentity,
} from "../../../src/adapters/gateway/store.ts";
import { parseGatewayReplayManifestV1 } from "../../../src/adapters/gateway/wire.ts";
import {
  b64Url,
  CAPTURE_ID_A,
  CAPTURE_ID_B,
  FakeClock,
  FINGERPRINT_A,
  INCIDENT_A,
  INCIDENT_B,
  makeCapture,
  sha256hex,
  syntheticBytes,
  T0,
} from "./helpers.ts";

const STORE_LIMITS: ArtifactStoreLimitsV1 = {
  totalMaxBytes: 1_000_000,
  artifactMaxBytes: 100_000,
  retentionMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
};

const REF_A = `artifact://sentinel/${INCIDENT_A}/${CAPTURE_ID_A}`;

function ciphertextFor(seed: number, length = 64): Uint8Array<ArrayBuffer> {
  return syntheticBytes(length, seed);
}

async function putCapture(
  store: LocalArtifactStore,
  bytes: Uint8Array,
  ref = REF_A,
  now = T0,
  overrides: Partial<Record<string, unknown>> = {},
) {
  const ciphertext = new Uint8Array(bytes) as Uint8Array<ArrayBuffer>;
  const refCaptureId = ref.split("/").at(-1);
  const captureId =
    refCaptureId !== undefined && /^[A-Za-z0-9_-]{1,128}$/.test(refCaptureId)
      ? refCaptureId
      : "cap-default";
  const capture = makeCapture(ciphertext, {
    capture_id: captureId,
    fingerprint: FINGERPRINT_A,
    ...overrides,
  });
  return await store.put({
    ref,
    digest: await sha256hex(ciphertext),
    ciphertext,
    incidentId: parseArtifactRefIdentity(ref)?.incidentId ?? INCIDENT_A,
    captureId,
    fingerprint: FINGERPRINT_A,
    caseGroupDigest: "c".repeat(64),
    sourceCapturedAt: T0,
    sourceExpiresAt: T0 + 48 * 60 * 60 * 1_000,
    contentType: "application/octet-stream",
    manifest: parseGatewayReplayManifestV1(capture.manifest),
  }, now);
}

async function makeStore(
  limits: ArtifactStoreLimitsV1 = STORE_LIMITS,
): Promise<{ store: LocalArtifactStore; root: string }> {
  const root = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-m02-store-",
  });
  const store = new LocalArtifactStore({ root, limits });
  const opened = await store.open();
  assert.ok(opened.ok, `store open failed: ${JSON.stringify(opened)}`);
  return { store, root };
}

async function removeTemp(root: string): Promise<void> {
  await Deno.remove(root, { recursive: true }).catch(() => {});
}

function assertOwnerOnly(mode: number): void {
  assert.equal(
    mode & 0o077,
    0,
    `unexpected group/other permissions: ${mode.toString(8)}`,
  );
}

/**
 * Real symlink creation needs unscoped read/write grants (Deno refuses to
 * create symlinks under path-scoped grants). When the sandbox forbids it the
 * symlink-dependent checks are skipped explicitly instead of failing; with
 * unscoped grants they run fully.
 */
async function trySymlink(target: string, link: string): Promise<boolean> {
  try {
    await Deno.symlink(target, link);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotCapable) {
      console.warn(
        "store symlink defense check skipped: Deno.symlink needs unscoped read/write grants",
      );
      return false;
    }
    throw error;
  }
}

Deno.test("store: put/get roundtrip with exact digest, size and expiry", async () => {
  const { store, root } = await makeStore();
  try {
    const bytes = ciphertextFor(3, 1_024);
    const put = await putCapture(store, bytes);
    assert.ok(put.ok);
    if (!put.ok) return;
    const stored = put.value;
    assert.equal(stored.ref, REF_A);
    assert.equal(stored.digest, await sha256hex(bytes));
    assert.equal(stored.sizeBytes, bytes.byteLength);
    assert.equal(stored.expiresAt, T0 + STORE_LIMITS.retentionMaxAgeMs);
    assert.equal(stored.sourceExpiresAt, T0 + 48 * 60 * 60 * 1_000);
    assert.deepEqual(Array.from(stored.ciphertext), Array.from(bytes));
    // The AES-GCM/gzip manifest is preserved privately for trusted decryption.
    assert.equal(stored.manifest.algorithm, "AES-256-GCM");
    assert.equal(stored.manifest.compression, "gzip");
    assert.equal(stored.manifest.fingerprint, FINGERPRINT_A);
    assert.equal(stored.manifest.captureId, CAPTURE_ID_A);
    const stats = await store.stats();
    assert.ok(
      stats.ok && stats.value.totalBytes === 1_024 && stats.value.count === 1,
    );
    const got = await store.get(REF_A, T0 + 60_000);
    assert.ok(got.ok && got.value !== null);
    if (got.ok && got.value) {
      assert.equal(got.value.digest, stored.digest);
      assert.deepEqual(Array.from(got.value.ciphertext), Array.from(bytes));
    }
  } finally {
    await removeTemp(root);
  }
});

Deno.test("store: restart observes the same retained evidence", async () => {
  const { store, root } = await makeStore();
  const bytes = ciphertextFor(5, 2_048);
  const put = await putCapture(store, bytes);
  assert.ok(put.ok);
  // A brand-new store instance over the same root: no in-memory cache, the
  // metadata and bytes on disk are the only authority.
  const restarted = new LocalArtifactStore({
    root,
    limits: { ...STORE_LIMITS, totalMaxBytes: 500_000 },
  });
  const opened = await restarted.open();
  assert.ok(opened.ok, `restart open failed: ${JSON.stringify(opened)}`);
  const got = await restarted.get(REF_A, T0 + 60_000);
  assert.ok(got.ok && got.value !== null, JSON.stringify(got));
  if (got.ok && got.value) {
    assert.equal(got.value.digest, await sha256hex(bytes));
    assert.equal(got.value.expiresAt, put.ok ? put.value.expiresAt : 0);
    assert.equal(got.value.retainedAt, put.ok ? put.value.retainedAt : 0);
  }
  const stats = await restarted.stats();
  assert.ok(
    stats.ok && stats.value.count === 1 && stats.value.totalBytes === 2_048,
  );
  await removeTemp(root);
});

Deno.test("store: same ref with same bytes is idempotent, different bytes conflict", async () => {
  const { store, root } = await makeStore();
  try {
    const bytes = ciphertextFor(7, 512);
    const first = await putCapture(store, bytes);
    assert.ok(first.ok);
    const firstExpiresAt = first.ok ? first.value.expiresAt : 0;
    const again = await putCapture(store, bytes);
    assert.ok(again.ok);
    if (again.ok) assert.equal(again.value.expiresAt, firstExpiresAt);
    const changed = await putCapture(store, ciphertextFor(9, 512));
    assert.ok(!changed.ok && changed.error.kind === "conflict");
    // The original bytes survive: no overwrite, no deletion of active evidence.
    const got = await store.get(REF_A, T0 + 1_000);
    assert.ok(got.ok && got.value);
    if (got.ok && got.value) {
      assert.equal(got.value.digest, await sha256hex(bytes));
    }
  } finally {
    await removeTemp(root);
  }
});

Deno.test("store: traversal and foreign refs are rejected", async () => {
  const { store, root } = await makeStore();
  try {
    const bytes = ciphertextFor(1, 32);
    for (
      const ref of [
        "artifact://sentinel/../../etc/passwd",
        "artifact://sentinel/../x",
        "artifact://sentinel/x/y/z",
        "file:///etc/passwd",
        "artifact://sentinel/synth-0001/capture-1.pgp",
        "artifact://sentinel/INCIDENT-A/cap",
      ]
    ) {
      const put = await putCapture(store, bytes, ref);
      assert.ok(!put.ok, `ref ${ref} must be rejected`);
      if (!put.ok) assert.equal(put.error.kind, "invalid");
    }
    assert.equal(parseArtifactRefIdentity("artifact://sentinel/../x"), null);
    assert.equal(
      parseArtifactRefIdentity("artifact://sentinel/../etc/passwd"),
      null,
    );
    assert.notEqual(
      parseArtifactRefIdentity(
        `artifact://sentinel/${INCIDENT_A}/${CAPTURE_ID_A}`,
      ),
      null,
    );
  } finally {
    await removeTemp(root);
  }
});

Deno.test("store: owner-only permissions on directories and files", async () => {
  const { store, root } = await makeStore();
  try {
    await putCapture(store, ciphertextFor(11, 256));
    const rootStat = await Deno.lstat(root);
    const entriesStat = await Deno.lstat(`${root}/entries`);
    const fileNames = [];
    for await (const entry of Deno.readDir(`${root}/entries`)) {
      fileNames.push(entry.name);
    }
    assert.equal(fileNames.length, 2);
    for (const name of fileNames) {
      const stat = await Deno.lstat(`${root}/entries/${name}`);
      if (stat.isDirectory) continue;
      assertOwnerOnly(stat.mode! & 0o777);
    }
    assertOwnerOnly(rootStat.mode! & 0o777);
    assertOwnerOnly(entriesStat.mode! & 0o777);
  } finally {
    await removeTemp(root);
  }
});

Deno.test("store: symlink at path is never followed", async () => {
  const { store, root } = await makeStore();
  try {
    const bytes = ciphertextFor(13, 128);
    const put = await putCapture(store, bytes);
    assert.ok(put.ok);
    const statEntries = [];
    for await (const entry of Deno.readDir(`${root}/entries`)) {
      statEntries.push(entry.name);
    }
    assert.equal(statEntries.length, 2);
    const binName = statEntries.find((name) => name.endsWith(".bin"))!;
    const binPath = `${root}/entries/${binName}`;
    await Deno.remove(binPath);
    // Plant a symlink at the exact entry path pointing at attacker bytes.
    const attackerPath = `${root}/attacker.pgp`;
    await Deno.writeFile(attackerPath, ciphertextFor(111, 128));
    if (!await trySymlink(attackerPath, binPath)) return;
    const got = await store.get(REF_A, T0 + 1_000);
    assert.ok(!got.ok, "symlinked bytes must never be served");
    if (!got.ok) assert.equal(got.error.kind, "corrupt");
    // A re-put of the same bytes must also fail closed at the symlinked path.
    const overwrite = await putCapture(store, bytes);
    assert.ok(!overwrite.ok && overwrite.error.kind === "corrupt");
    // Different bytes at the same ref conflict before any path access.
    const changed = await putCapture(store, ciphertextFor(112, 128));
    assert.ok(!changed.ok && changed.error.kind === "conflict");
  } finally {
    await removeTemp(root);
  }
});

Deno.test("store: symlinked entries directory and root are rejected", async () => {
  const parent = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-m02-parent-",
  });
  try {
    const realRoot = `${parent}/real`;
    await Deno.mkdir(realRoot, { mode: 0o700 });
    const linkedRoot = `${parent}/linked`;
    if (!await trySymlink(realRoot, linkedRoot)) return;
    const store = new LocalArtifactStore({
      root: linkedRoot,
      limits: STORE_LIMITS,
    });
    const opened = await store.open();
    assert.ok(!opened.ok && opened.error.kind === "invalid");

    const symlinkedEntries = `${parent}/symlinked-entries`;
    await Deno.mkdir(symlinkedEntries, { mode: 0o700 });
    const pointTarget = `${parent}/target-entries`;
    await Deno.mkdir(pointTarget, { mode: 0o700 });
    await Deno.remove(symlinkedEntries);
    if (!await trySymlink(pointTarget, symlinkedEntries)) return;
    const otherStore = new LocalArtifactStore({
      root: symlinkedEntries,
      limits: STORE_LIMITS,
    });
    const otherOpened = await otherStore.open();
    assert.ok(!otherOpened.ok && otherOpened.error.kind === "invalid");
  } finally {
    await removeTemp(parent);
  }
});

Deno.test("store: capacity exhaustion blocks without deleting active evidence", async () => {
  const { store, root } = await makeStore({
    totalMaxBytes: 550,
    artifactMaxBytes: 1_000,
    retentionMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
  });
  try {
    const first = await putCapture(store, ciphertextFor(21, 250));
    assert.ok(first.ok);
    const secondRef =
      `artifact://sentinel/${INCIDENT_A}/${"0c0ffee1-1234-4abc-8def-000000000001"}`;
    const second = await putCapture(store, ciphertextFor(23, 250), secondRef);
    assert.ok(second.ok);
    const thirdRef =
      `artifact://sentinel/${INCIDENT_A}/${"0c0ffee3-1234-4abc-8def-000000000003"}`;
    const third = await putCapture(store, ciphertextFor(25, 250), thirdRef);
    assert.ok(!third.ok && third.error.kind === "full");
    // Neither retained artifact was touched: capacity exhaustion never evicts.
    const a = await store.get(REF_A, T0 + 1_000);
    assert.ok(a.ok && a.value !== null);
    const stats = await store.stats();
    assert.ok(
      stats.ok && stats.value.count === 2 && stats.value.totalBytes === 500,
    );
  } finally {
    await removeTemp(root);
  }
});

Deno.test("store: capacity admission reclaims expired evidence across incidents", async (t) => {
  for (const restart of [false, true]) {
    await t.step(restart ? "after restart" : "without reopening", async () => {
      const limits = {
        totalMaxBytes: 400,
        artifactMaxBytes: 200,
        retentionMaxAgeMs: 1_000,
      };
      const initial = await makeStore(limits);
      let store = initial.store;
      const { root } = initial;
      const clock = new FakeClock(T0);
      const refB = `artifact://sentinel/${INCIDENT_B}/${CAPTURE_ID_B}`;
      const nextRefB = `artifact://sentinel/${INCIDENT_B}/cap-next`;
      const activeBytes = ciphertextFor(72, 200);
      const nextBytes = ciphertextFor(73, 200);
      try {
        const first = await putCapture(
          store,
          ciphertextFor(71, 200),
          REF_A,
          clock.now(),
        );
        assert.ok(first.ok, JSON.stringify(first));
        clock.advance(500);
        const active = await putCapture(store, activeBytes, refB, clock.now());
        assert.ok(active.ok, JSON.stringify(active));
        clock.advance(499);
        const full = await putCapture(store, nextBytes, nextRefB, clock.now());
        assert.ok(!full.ok && full.error.kind === "full", JSON.stringify(full));
        const beforeExpiry = await store.get(REF_A, clock.now());
        assert.ok(beforeExpiry.ok && beforeExpiry.value !== null);
        clock.advance(1);
        if (restart) {
          store = new LocalArtifactStore({ root, limits });
          const opened = await store.open();
          assert.ok(opened.ok, JSON.stringify(opened));
        }
        const listed = await store.listByIncident(INCIDENT_B, clock.now());
        assert.ok(listed.ok, JSON.stringify(listed));
        if (listed.ok) {
          assert.deepEqual(listed.value.map((artifact) => artifact.ref), [
            refB,
          ]);
        }
        const admitted = await putCapture(
          store,
          nextBytes,
          nextRefB,
          clock.now(),
        );
        assert.ok(
          admitted.ok,
          `expired incident A must not block incident B: ${
            JSON.stringify(admitted)
          }`,
        );
        const expiredKey = await sha256hex(new TextEncoder().encode(REF_A));
        for (const suffix of ["json", "bin"]) {
          await assert.rejects(
            Deno.lstat(`${root}/entries/${expiredKey}.${suffix}`),
            Deno.errors.NotFound,
          );
        }
        const stats = await store.stats();
        assert.ok(
          stats.ok && stats.value.totalBytes === 400 && stats.value.count === 2,
          JSON.stringify(stats),
        );
        const preserved = await store.get(refB, clock.now());
        assert.ok(
          preserved.ok && preserved.value !== null,
          JSON.stringify(preserved),
        );
        if (preserved.ok && preserved.value) {
          assert.deepEqual(preserved.value.ciphertext, activeBytes);
        }
        const absent = await store.get(REF_A, clock.now());
        assert.ok(absent.ok && absent.value === null);
        // Advance again on the same instance: reclamation is not confined to open().
        clock.advance(500);
        const later = await putCapture(
          store,
          ciphertextFor(74, 200),
          REF_A,
          clock.now(),
        );
        assert.ok(later.ok, JSON.stringify(later));
        const newest = await store.get(nextRefB, clock.now());
        assert.ok(newest.ok && newest.value !== null, JSON.stringify(newest));
        if (newest.ok && newest.value) {
          assert.deepEqual(newest.value.ciphertext, nextBytes);
        }
        const final = await store.stats();
        assert.ok(
          final.ok && final.value.totalBytes === 400 && final.value.count === 2,
          JSON.stringify(final),
        );
      } finally {
        await removeTemp(root);
      }
    });
  }
});

Deno.test("store: capacity reclamation fails closed on invalid metadata and failed removal", async (t) => {
  for (const failure of ["metadata", "removal"] as const) {
    await t.step(failure, async () => {
      const { store, root } = await makeStore({
        totalMaxBytes: 400,
        artifactMaxBytes: 200,
        retentionMaxAgeMs: 1_000,
      });
      const refB = `artifact://sentinel/${INCIDENT_B}/${CAPTURE_ID_B}`;
      const nextRefB = `artifact://sentinel/${INCIDENT_B}/cap-next`;
      const activeBytes = ciphertextFor(82, 200);
      try {
        assert.ok((await putCapture(store, ciphertextFor(81, 200))).ok);
        assert.ok((await putCapture(store, activeBytes, refB, T0 + 500)).ok);
        const key = await sha256hex(new TextEncoder().encode(REF_A));
        const metaPath = `${root}/entries/${key}.json`;
        const binPath = `${root}/entries/${key}.bin`;
        if (failure === "metadata") {
          const metadata = JSON.parse(await Deno.readTextFile(metaPath));
          metadata.incidentId = INCIDENT_B;
          await Deno.writeTextFile(metaPath, JSON.stringify(metadata));
        } else {
          // A nonempty directory at the bytes path makes actual deletion fail.
          await Deno.remove(binPath);
          await Deno.mkdir(binPath);
          await Deno.writeFile(`${binPath}/blocked`, ciphertextFor(81, 200));
        }
        const rejected = await putCapture(
          store,
          ciphertextFor(83, 200),
          nextRefB,
          T0 + 1_000,
        );
        assert.ok(!rejected.ok, JSON.stringify(rejected));
        if (!rejected.ok) {
          assert.equal(
            rejected.error.kind,
            failure === "metadata" ? "corrupt" : "unavailable",
          );
        }
        const preserved = await store.get(refB, T0 + 1_000);
        assert.ok(
          preserved.ok && preserved.value !== null,
          JSON.stringify(preserved),
        );
        if (preserved.ok && preserved.value) {
          assert.deepEqual(preserved.value.ciphertext, activeBytes);
        }
        const absent = await store.get(nextRefB, T0 + 1_000);
        assert.ok(absent.ok && absent.value === null);
        if (failure === "removal") {
          // Partial deletion must not free accounting while the bytes remain.
          const retry = await putCapture(
            store,
            ciphertextFor(83, 200),
            nextRefB,
            T0 + 1_000,
          );
          assert.ok(
            !retry.ok && retry.error.kind === "unavailable",
            JSON.stringify(retry),
          );
          assert.equal(
            (await Deno.readFile(`${binPath}/blocked`)).byteLength,
            200,
          );
          const restarted = new LocalArtifactStore({
            root,
            limits: store.limits,
          });
          const opened = await restarted.open();
          if (opened.ok) {
            const afterRestart = await putCapture(
              restarted,
              ciphertextFor(83, 200),
              nextRefB,
              T0 + 1_000,
            );
            assert.ok(
              !afterRestart.ok,
              `restart must not forget unremoved ciphertext: ${
                JSON.stringify(afterRestart)
              }`,
            );
          } else {
            assert.equal(opened.error.kind, "corrupt");
          }
          assert.ok((await Deno.lstat(metaPath)).isFile);
        } else {
          assert.equal((await Deno.readFile(binPath)).byteLength, 200);
        }
      } finally {
        await removeTemp(root);
      }
    });
  }
});

Deno.test("store: per-artifact byte bound is enforced without partial writes", async () => {
  const { store, root } = await makeStore({
    totalMaxBytes: 1_000_000,
    artifactMaxBytes: 500,
    retentionMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
  });
  try {
    const put = await putCapture(store, ciphertextFor(31, 501));
    assert.ok(!put.ok && put.error.kind === "invalid");
    const stats = await store.stats();
    assert.ok(stats.ok && stats.value.count === 0);
  } finally {
    await removeTemp(root);
  }
});

Deno.test("store: local expiry purges on access and reads absent", async () => {
  const { store, root } = await makeStore({
    totalMaxBytes: 1_000_000,
    artifactMaxBytes: 1_000,
    retentionMaxAgeMs: 1_000,
  });
  try {
    const bytes = ciphertextFor(41, 300);
    const put = await putCapture(store, bytes);
    assert.ok(put.ok);
    const expiresAt = put.ok ? put.value.expiresAt : T0;
    const before = await store.get(REF_A, expiresAt - 1);
    assert.ok(before.ok && before.value !== null);
    const after = await store.get(REF_A, expiresAt);
    assert.ok(after.ok && after.value === null);
    const stats = await store.stats();
    assert.ok(
      stats.ok && stats.value.count === 0 && stats.value.totalBytes === 0,
    );
    const files = [];
    for await (const entry of Deno.readDir(`${root}/entries`)) {
      files.push(entry.name);
    }
    assert.equal(files.length, 0);
  } finally {
    await removeTemp(root);
  }
});

Deno.test("store: listByIncident returns only that incident's non-expired artifacts", async () => {
  const { store, root } = await makeStore({
    totalMaxBytes: 1_000_000,
    artifactMaxBytes: 1_000,
    retentionMaxAgeMs: 1_000,
  });
  try {
    const refA = REF_A;
    const refB =
      `artifact://sentinel/${INCIDENT_A}/${"0c0ffee2-1234-4abc-8def-000000000002"}`;
    const refOther =
      `artifact://sentinel/provider-11111111-1111-4111-8111-111111111111/${"0c0ffee3-1234-4abc-8def-000000000003"}`;
    // Staggered retention: A expires at T0+1000, B/other at T0+1900.
    await putCapture(store, ciphertextFor(51, 200), refA, T0);
    await putCapture(store, ciphertextFor(53, 200), refB, T0 + 900);
    await putCapture(store, ciphertextFor(55, 200), refOther, T0 + 900);
    const listed = await store.listByIncident(INCIDENT_A, T0 + 950);
    assert.ok(listed.ok && listed.value.length === 2, JSON.stringify(listed));
    if (listed.ok) {
      assert.deepEqual(
        listed.value.map((a) => a.ref).sort(),
        [refA, refB].sort(),
      );
    }
    // Expired entries are purged from the listing.
    await store.get(refA, T0 + 1_100);
    const after = await store.listByIncident(INCIDENT_A, T0 + 1_100);
    assert.ok(after.ok && after.value.length === 1, JSON.stringify(after));
    assert.equal(after.ok ? after.value[0]?.ref : null, refB);
  } finally {
    await removeTemp(root);
  }
});

Deno.test("store: persisted metadata carries no plaintext and no key material", async () => {
  const { store, root } = await makeStore();
  try {
    const bytes = ciphertextFor(61, 1_024);
    await putCapture(store, bytes);
    let metadataText = "";
    for await (const entry of Deno.readDir(`${root}/entries`)) {
      if (entry.name.endsWith(".json")) {
        metadataText = await Deno.readTextFile(`${root}/entries/${entry.name}`);
      }
    }
    assert.ok(metadataText.length > 0);
    // The raw ciphertext (as base64) must never be embedded in metadata.
    assert.ok(!metadataText.includes(b64Url(bytes)));
    assert.ok(!metadataText.includes("body"));
    assert.ok(!metadataText.includes("plaintext"));
    // The manifest fingerprint is the HMAC identity, not a ciphertext digest.
    const parsed = JSON.parse(metadataText) as {
      fingerprint: string;
      digest: string;
    };
    assert.equal(parsed.fingerprint, FINGERPRINT_A);
    assert.match(parsed.fingerprint, /^[0-9a-f]{64}$/);
    assert.notEqual(parsed.fingerprint, parsed.digest);
  } finally {
    await removeTemp(root);
  }
});
