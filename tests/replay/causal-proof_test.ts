/**
 * Trusted causal-proof boundary tests (plan 01).
 *
 * The strict validator, the canonical failure-signature identity, the
 * deterministic proof/fixture reference grammar and the ReplayPort consuming
 * boundary are exercised against the ACTUAL Deno process runtime and real
 * local toy git revisions: a fully bound proof alone suppresses
 * `fixture_redacted`, while an absent, structurally invalid, stale,
 * identity-mismatched or revoked-identity proof keeps the ordinary redacted
 * fixture and limitation. Every other limitation (output_truncated,
 * unrelated failure, unavailable, wrong test identity) still fails closed.
 *
 * Public synthetic data only; no network, no model call, no credentials.
 */

import assert from "node:assert/strict";

import { asEncryptedArtifactDigest } from "../../src/contracts/brands.ts";
import type {
  CommandId,
  FixtureDigest,
  GitSha,
} from "../../src/contracts/brands.ts";
import type {
  PortResultV1,
  ReplayRunRequestV1,
} from "../../src/contracts/ports.ts";
import { parseRepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import {
  deriveFailureSignatureIdentity,
  GATEWAY_CAUSAL_VERIFIER_ID,
  gatewayCausalProofRef,
  gatewayFixtureRefIdentity,
  validateGatewayCausalProof,
} from "../../src/replay/causal-proof.ts";
import type { GatewayCausalProofV1 } from "../../src/replay/causal-proof.ts";
import { computeReplayFixtureDigest } from "../../src/replay/fixture.ts";
import type {
  ExpectedFailureV1,
  ResolvedFixtureV1,
} from "../../src/replay/fixture.ts";
import { ReplayPortImpl } from "../../src/replay/port.ts";
import type { ReplayPortOptions } from "../../src/replay/port.ts";
import type { WorkItemId } from "../../src/contracts/brands.ts";
import {
  createToyApp,
  gitRun,
  testGitEnv,
  TOY_REPOSITORY,
  toyOptions,
} from "./helpers.ts";

const INCIDENT_ID = "provider-00000000-0000-4000-8000-000000000001";
const CAPTURE_ID = "synthetic-capture-2";
const ARTIFACT_DIGEST = asEncryptedArtifactDigest("c".repeat(64));
const TEST_ID = "gateway:stream-termination";
const REPLAY_COMMAND = "replay" as CommandId;
const TEST_COMMAND = "test" as CommandId;
const EXPECTED_FAILURE: ExpectedFailureV1 = {
  reason: "missing completion terminator produces 500",
  match: { kind: "contains", text: "stream terminated unexpectedly" },
};

const FAKE_ORIGINAL_SHA = "1".repeat(40) as GitSha;

const here = new URL(import.meta.url);
if (here.protocol !== "file:") throw new Error("expected a file: test module");
const testsDir = decodeURIComponent(here.pathname).replace(
  /\/causal-proof_test\.ts$/,
  "",
);

const textEncoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Proof/bundle builders (deterministic; signatures via the canonical module
// derivation so the tests also prove the derivation loop).
// ---------------------------------------------------------------------------

/** Gateway-style fixture entry bytes (public synthetic protocol vocabulary). */
function gatewayEntries(): { path: string; bytes: Uint8Array }[] {
  return [
    {
      path:
        `tests/fixtures/gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}/request.json`,
      bytes: textEncoder.encode(JSON.stringify({
        endpoint: "/v1/responses",
        method: "POST",
        contentType: "application/json",
        body:
          '{"model":"synthetic-model","input":"fixture text","stream":true}',
      })),
    },
    {
      path:
        `tests/fixtures/gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}/upstream.json`,
      bytes: textEncoder.encode(JSON.stringify({
        version: 1,
        attempts: [{
          provider: "chatgpt_codex",
          status: 200,
          content_type: "text/event-stream",
          chunks_base64: [
            "ZGF0YTogIntcInR5cGVcIjpcInJlc3BvbnNlLmNyZWF0ZWRcIn0iXQ==",
          ],
          terminal: "eof",
        }],
        attempts_truncated: false,
        bytes_truncated: false,
        chunks_truncated: false,
      })),
    },
  ];
}

async function buildProof(
  bundleDigest: FixtureDigest,
  originalGitSha: GitSha,
  overrides: Partial<GatewayCausalProofV1> = {},
): Promise<GatewayCausalProofV1> {
  const fixtureRef =
    `fixture://gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}/${bundleDigest}`;
  const signature = await deriveFailureSignatureIdentity(EXPECTED_FAILURE);
  const proof: GatewayCausalProofV1 = {
    version: "v1",
    kind: "gateway_causal_proof",
    verifier: GATEWAY_CAUSAL_VERIFIER_ID,
    proofRef: gatewayCausalProofRef(INCIDENT_ID, CAPTURE_ID, bundleDigest),
    repository: TOY_REPOSITORY,
    incidentId: INCIDENT_ID,
    captureId: CAPTURE_ID,
    artifactDigest: ARTIFACT_DIGEST,
    originalGitSha,
    fixtureRef,
    bundleDigest,
    replayCommandId: REPLAY_COMMAND,
    testCommandId: TEST_COMMAND,
    testIds: [TEST_ID],
    expectedFailure: EXPECTED_FAILURE,
    originalObservation: { intended: true, signature },
    fixtureObservation: { intended: true, signature },
    ...overrides,
  };
  return proof;
}

async function gatewayBundle(
  originalGitSha: GitSha,
  proofOverrides: Partial<GatewayCausalProofV1> = {},
): Promise<{ bundle: ResolvedFixtureV1; digest: FixtureDigest; ref: string }> {
  const entries = gatewayEntries();
  const digest = await computeReplayFixtureDigest(entries);
  const ref = `fixture://gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}/${digest}`;
  const bundle: ResolvedFixtureV1 = {
    testIds: [TEST_ID],
    expectedFailure: EXPECTED_FAILURE,
    entries,
    provenance: {
      sanitized: true,
      sanitizer: "gateway-structural-v1",
      provenanceRef: ref,
      redacted: true,
      note:
        "gateway capture redacted; re-encoded to a fixed protocol vocabulary",
    },
    causalProof: await buildProof(digest, originalGitSha, proofOverrides),
  };
  return { bundle, digest, ref };
}

/** Config whose "test" command runs one credential-free deno eval script. */
function evalConfig(
  script: string,
  maxOutputBytes = 262_144,
): RepositoryConfigV1 {
  const command = {
    executable: "deno",
    args: ["eval", "--allow-read=.", script],
    maxDurationMs: 15_000,
    maxOutputBytes,
  };
  return parseRepositoryConfigV1({
    version: "v1",
    kind: "repository_config",
    repository: TOY_REPOSITORY,
    baseBranch: "main",
    adapter: { kind: "gateway", baseUrl: "https://ai.ubq.fi" },
    commands: { replay: "replay", test: "test" },
    commandRegistry: {
      version: "v1",
      commands: { replay: command, test: command },
    },
    protectedPaths: ["src/"],
    build: { projectId: null, acceptance: null },
    secretRef: null,
    liveStartLimits: null,
    sessionBound: null,
    retention: null,
    stabilityPolicy: null,
  });
}

const FAIL_SCRIPT =
  `const base = "tests/fixtures/gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}"; const request = JSON.parse(await Deno.readTextFile(base + "/request.json")); const upstream = JSON.parse(await Deno.readTextFile(base + "/upstream.json")); if (request.endpoint !== "/v1/responses") Deno.exit(9); if (!upstream.attempts.every((a) => a.terminal === "eof")) Deno.exit(9); console.log("sentinel-replay-test:${TEST_ID}"); console.log("stream terminated unexpectedly"); Deno.exit(1);`;

const PASS_SCRIPT =
  `const base = "tests/fixtures/gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}"; const request = JSON.parse(await Deno.readTextFile(base + "/request.json")); const upstream = JSON.parse(await Deno.readTextFile(base + "/upstream.json")); if (request.endpoint !== "/v1/responses") Deno.exit(9); if (!upstream.attempts.every((a) => a.terminal === "eof")) Deno.exit(9); console.log("sentinel-replay-test:${TEST_ID}");`;

async function withFixture<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await Deno.makeTempDir({
    prefix: ".causal-proof-tmp-",
    dir: testsDir,
  });
  try {
    return await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

function assertPortOk<T>(result: PortResultV1<T>): T {
  assert.ok(result.ok, `expected port ok, got ${JSON.stringify(result)}`);
  return result.value;
}

function runRequest(
  bundle: ResolvedFixtureV1,
  ref: string,
  digest: FixtureDigest,
  revision: GitSha,
  overrides: Record<string, unknown> = {},
): ReplayRunRequestV1 {
  return {
    taskId: "incident:toy-0001" as WorkItemId,
    repository: TOY_REPOSITORY,
    revision,
    commandId: TEST_COMMAND,
    fixtureRef: ref,
    fixtureDigest: digest,
    testIds: bundle.testIds,
    outputLimitBytes: 262_144,
    ...overrides,
  } as ReplayRunRequestV1;
}

function portWith(
  toyRoot: string,
  scratchDir: string,
  bundle: ResolvedFixtureV1,
  overrides: Partial<ReplayPortOptions> = {},
): ReplayPortImpl {
  return new ReplayPortImpl({
    ...toyOptions(toyRoot, scratchDir),
    fixtures: {
      resolveFixture: () => Promise.resolve({ ok: true, value: bundle }),
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Validator and identity derivations (no subprocess)
// ---------------------------------------------------------------------------

Deno.test("causal proof: canonical signature identity is deterministic and strictly bound to the expected failure", async () => {
  const first = await deriveFailureSignatureIdentity(EXPECTED_FAILURE);
  const second = await deriveFailureSignatureIdentity(EXPECTED_FAILURE);
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(
    first,
    await deriveFailureSignatureIdentity({
      reason: EXPECTED_FAILURE.reason,
      match: { kind: "contains", text: "different failure text" },
    }),
    "changed matcher must change the identity",
  );
  assert.notEqual(
    first,
    await deriveFailureSignatureIdentity({
      reason: "different reason",
      match: EXPECTED_FAILURE.match,
    }),
    "changed reason must change the identity",
  );
});

Deno.test("causal proof: gateway fixture and proof reference grammar is strict", () => {
  const digest = "a".repeat(64) as FixtureDigest;
  const ref = `fixture://gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}/${digest}`;
  const parsed = gatewayFixtureRefIdentity(ref);
  assert.notEqual(parsed, null);
  assert.equal(parsed!.incidentId, INCIDENT_ID);
  assert.equal(parsed!.captureId, CAPTURE_ID);
  assert.equal(parsed!.bundleDigest, digest);
  assert.equal(
    gatewayCausalProofRef(INCIDENT_ID, CAPTURE_ID, digest),
    `fixture://proof/gateway-causal/${INCIDENT_ID}/${CAPTURE_ID}/${digest}`,
  );
  for (
    const malformed of [
      "",
      "artifact://sentinel/toy",
      `fixture://gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}`,
      `fixture://gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}/a`.repeat(2),
      "fixture://gateway-replay/not-an-incident/" + CAPTURE_ID + "/" + digest,
      `fixture://gateway-replay/${INCIDENT_ID}/../${CAPTURE_ID}/${digest}`,
      "fixture://captures/toy/upstream.json",
    ]
  ) {
    assert.equal(gatewayFixtureRefIdentity(malformed), null, malformed);
  }
});

Deno.test("causal proof: strict structural validation accepts only fully bound proofs", async () => {
  const digest = "b".repeat(64) as FixtureDigest;
  const proof = await buildProof(digest, FAKE_ORIGINAL_SHA);
  const parsed = await validateGatewayCausalProof(proof);
  assert.notEqual(parsed, null);
  assert.equal(parsed!.verifier, GATEWAY_CAUSAL_VERIFIER_ID);
  assert.equal(parsed!.bundleDigest, digest);
  assert.equal(parsed!.originalGitSha, FAKE_ORIGINAL_SHA);

  // Verifier identity is fixed: a different id is never a proof.
  assert.equal(
    await validateGatewayCausalProof({ ...proof, verifier: "other-oracle" }),
    null,
  );
  // Kind/version are exact.
  assert.equal(
    await validateGatewayCausalProof({ ...proof, kind: "something_else" }),
    null,
  );
  assert.equal(
    await validateGatewayCausalProof({ ...proof, version: "v2" }),
    null,
  );
  // Proof reference must be the deterministic sibling reference.
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      proofRef:
        `fixture://proof/gateway-causal/${INCIDENT_ID}/${CAPTURE_ID}/b`.repeat(
          2,
        ).slice(0, 20) + "x",
    }),
    null,
  );
  // Internal reference consistency: fixture ref must embed the same identities.
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      fixtureRef: `fixture://gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}/${
        "d".repeat(64)
      }`,
    }),
    null,
  );
  // The bundle digest is a distinct 64-hex identity, never a Git SHA.
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      bundleDigest: "a".repeat(40),
    }),
    null,
  );
  // The artifact digest is its own brand shape (64-hex).
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      artifactDigest: "e".repeat(40),
    }),
    null,
  );
  // Command ids must be trusted command identifiers.
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      replayCommandId: "not allowed",
    }),
    null,
  );
  // Test ids must be the exact bounded list.
  assert.equal(
    await validateGatewayCausalProof({ ...proof, testIds: [] }),
    null,
  );
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      testIds: [TEST_ID, TEST_ID],
    }),
    null,
  );
  // Expected failure must be bounded and matcher-supported.
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      expectedFailure: { ...EXPECTED_FAILURE, reason: "" },
    }),
    null,
  );
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      expectedFailure: {
        ...EXPECTED_FAILURE,
        match: { kind: "contains", text: "x".repeat(600) },
      },
    }),
    null,
  );
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      expectedFailure: { ...EXPECTED_FAILURE, match: { kind: "other" } },
    }),
    null,
  );
  // Both observations must be intended failures.
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      originalObservation: {
        intended: false,
        signature: proof.originalObservation.signature,
      },
    }),
    null,
  );
  // Signatures must be equal and canonically derived; never exit codes.
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      fixtureObservation: {
        intended: true,
        signature: "f".repeat(64),
      },
    }),
    null,
  );
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      originalObservation: { intended: true, signature: "z".repeat(64) },
    }),
    null,
  );
  // A changed matcher with stale signatures never validates.
  const different = await buildProof(digest, FAKE_ORIGINAL_SHA, {
    expectedFailure: {
      reason: "different reason",
      match: { kind: "contains", text: "different text" },
    },
  });
  assert.equal(await validateGatewayCausalProof(different), null);
});

// ---------------------------------------------------------------------------
// ReplayPort consuming boundary (real process runtime, real toy revisions)
// ---------------------------------------------------------------------------

Deno.test("causal proof: a valid proof suppresses fixture_redacted at the consuming boundary", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const { bundle, digest, ref } = await gatewayBundle(toy.originalSha);
    const port = portWith(toy.root, `${root}/scratch`, bundle, {
      config: evalConfig(FAIL_SCRIPT),
    });

    // Before-failure at the exact original revision: intended, zero limitations.
    const before = assertPortOk(
      await port.runReplay(runRequest(bundle, ref, digest, toy.originalSha)),
    );
    assert.equal(before.outcome, "failed");
    assert.equal(before.exitCode, 1);
    assert.equal(before.failure?.intended, true);
    assert.deepEqual(before.limitations, []);

    // The proof is for the immutable capture/fixture relationship: a
    // candidate revision may differ from proof.originalGitSha.
    const after = assertPortOk(
      await port.runReplay(runRequest(bundle, ref, digest, toy.candidateSha)),
    );
    assert.equal(after.outcome, "failed");
    assert.equal(after.failure?.intended, true);
    assert.deepEqual(after.limitations, []);

    // Pass side: the same permanent fixture passes with zero limitations.
    const passPort = portWith(toy.root, `${root}/scratch`, bundle, {
      config: evalConfig(PASS_SCRIPT),
    });
    const passed = assertPortOk(
      await passPort.runReplay(
        runRequest(bundle, ref, digest, toy.candidateSha),
      ),
    );
    assert.equal(passed.outcome, "passed");
    assert.equal(passed.exitCode, 0);
    assert.deepEqual(passed.limitations, []);
  });
});

Deno.test("causal proof: absent or mismatched proofs keep the ordinary redacted limitation", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);

    // No proof at all: ordinary redacted fixture and its limitation.
    const noProof = await gatewayBundle(toy.originalSha);
    delete noProof.bundle.causalProof;
    const noProofPort = portWith(toy.root, `${root}/scratch`, noProof.bundle, {
      config: evalConfig(FAIL_SCRIPT),
    });
    const limited = assertPortOk(
      await noProofPort.runReplay(
        runRequest(
          noProof.bundle,
          noProof.ref,
          noProof.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.equal(limited.outcome, "failed");
    assert.equal(limited.failure?.intended, true);
    assert.deepEqual(limited.limitations, ["fixture_redacted"]);

    // Wrong bundle digest: structurally valid but not bound to the actual
    // bundle bytes → the redaction limitation stays.
    const wrongDigest = await gatewayBundle(toy.originalSha, {
      bundleDigest: "e".repeat(64) as FixtureDigest,
    });
    const wrongDigestPort = portWith(
      toy.root,
      `${root}/scratch`,
      wrongDigest.bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    );
    const mismatched = assertPortOk(
      await wrongDigestPort.runReplay(
        runRequest(
          wrongDigest.bundle,
          wrongDigest.ref,
          wrongDigest.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.deepEqual(mismatched.limitations, ["fixture_redacted"]);

    // Wrong fixture ref (a different capture identity): the port derives the
    // incident/capture from the request ref, so the proof cannot bind.
    const wrongRefBundle = await gatewayBundle(toy.originalSha);
    const wrongRefPort = portWith(
      toy.root,
      `${root}/scratch`,
      wrongRefBundle.bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    );
    const wrongRef = assertPortOk(
      await wrongRefPort.runReplay(
        runRequest(
          wrongRefBundle.bundle,
          `fixture://gateway-replay/${INCIDENT_ID}/different-capture/${wrongRefBundle.digest}`,
          wrongRefBundle.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.deepEqual(wrongRef.limitations, ["fixture_redacted"]);

    // Wrong command identity: the proof binds the configured test command.
    const wrongCommand = await gatewayBundle(toy.originalSha, {
      testCommandId: "other_test" as CommandId,
    });
    const wrongCommandPort = portWith(
      toy.root,
      `${root}/scratch`,
      wrongCommand.bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    );
    const wrongCommandRun = assertPortOk(
      await wrongCommandPort.runReplay(
        runRequest(
          wrongCommand.bundle,
          wrongCommand.ref,
          wrongCommand.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.deepEqual(wrongCommandRun.limitations, ["fixture_redacted"]);

    // Wrong test-id list: the proof's exact test identity must match the
    // resolved fixture identity.
    const wrongTestIds = await gatewayBundle(toy.originalSha, {
      testIds: ["other:test"],
    });
    const wrongTestIdsPort = portWith(
      toy.root,
      `${root}/scratch`,
      wrongTestIds.bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    );
    const wrongTestIdsRun = assertPortOk(
      await wrongTestIdsPort.runReplay(
        runRequest(
          wrongTestIds.bundle,
          wrongTestIds.ref,
          wrongTestIds.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.deepEqual(wrongTestIdsRun.limitations, ["fixture_redacted"]);

    // Changed expected-failure matcher (signatures re-derived for the changed
    // matcher, so structural validation passes): the resolved fixture's
    // expected failure is the trusted binding and still mismatches.
    const changedMatcher = await gatewayBundle(toy.originalSha, {
      expectedFailure: {
        reason: "different reason",
        match: { kind: "contains", text: "different text" },
      },
    });
    const changedMatcherPort = portWith(
      toy.root,
      `${root}/scratch`,
      changedMatcher.bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    );
    const changedMatcherRun = assertPortOk(
      await changedMatcherPort.runReplay(
        runRequest(
          changedMatcher.bundle,
          changedMatcher.ref,
          changedMatcher.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.deepEqual(changedMatcherRun.limitations, ["fixture_redacted"]);

    // Wrong repository identity.
    const wrongRepository = await gatewayBundle(toy.originalSha, {
      repository: { ...TOY_REPOSITORY, name: "different-repo" },
    });
    const wrongRepositoryPort = portWith(
      toy.root,
      `${root}/scratch`,
      wrongRepository.bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    );
    const wrongRepositoryRun = assertPortOk(
      await wrongRepositoryPort.runReplay(
        runRequest(
          wrongRepository.bundle,
          wrongRepository.ref,
          wrongRepository.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.deepEqual(wrongRepositoryRun.limitations, ["fixture_redacted"]);

    // Stale/mismatched observation signatures (equal to each other but not
    // the canonical identity) never validate.
    const staleSignature = "9".repeat(64);
    const staleObservation = await gatewayBundle(toy.originalSha, {
      originalObservation: { intended: true, signature: staleSignature },
      fixtureObservation: { intended: true, signature: staleSignature },
    });
    const stalePort = portWith(
      toy.root,
      `${root}/scratch`,
      staleObservation.bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    );
    const staleRun = assertPortOk(
      await stalePort.runReplay(
        runRequest(
          staleObservation.bundle,
          staleObservation.ref,
          staleObservation.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.deepEqual(staleRun.limitations, ["fixture_redacted"]);
  });
});

Deno.test("causal proof: other limitations still fail closed alongside a valid proof", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const { bundle, digest, ref } = await gatewayBundle(toy.originalSha);

    // Truncated output keeps output_truncated even when the proof is valid.
    const truncatingConfig = evalConfig(
      "console.log('x'.repeat(4000)); console.log(\"sentinel-replay-test:" +
        TEST_ID +
        '"); console.log("stream terminated unexpectedly"); Deno.exit(1);',
      128,
    );
    const truncating = portWith(toy.root, `${root}/scratch-trunc`, bundle, {
      config: truncatingConfig,
    });
    const truncated = assertPortOk(
      await truncating.runReplay(
        runRequest(bundle, ref, digest, toy.originalSha),
      ),
    );
    assert.equal(truncated.outcome, "failed");
    assert.equal(truncated.failure?.intended, false);
    assert.deepEqual(truncated.limitations, ["output_truncated"]);

    // Unrelated failure: same valid proof, different failure reason — never
    // an intended failure, and never a clean run.
    const unrelated = assertPortOk(
      await portWith(toy.root, `${root}/scratch-unrelated`, bundle, {
        config: evalConfig(
          `console.log("sentinel-replay-test:${TEST_ID}"); console.log("unrelated boom"); Deno.exit(1);`,
        ),
      }).runReplay(runRequest(bundle, ref, digest, toy.originalSha)),
    );
    assert.equal(unrelated.outcome, "failed");
    assert.equal(unrelated.failure?.intended, false);
    assert.deepEqual(unrelated.limitations, []);

    // A request carrying test ids that do not match the trusted fixture
    // identity is rejected before any target command runs.
    const wrongRequestIds = await portWith(
      toy.root,
      `${root}/scratch-ids`,
      bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    ).runReplay(
      runRequest(bundle, ref, digest, toy.originalSha, {
        testIds: ["different:test"],
      }),
    );
    assert.ok(!wrongRequestIds.ok);
    assert.match(wrongRequestIds.error.detail, /test identity/);

    // A request fixture ref that is not the gateway grammar cannot bind the
    // proof: the ordinary redacted limitation stays (fail closed).
    const nonGatewayRefRun = await portWith(
      toy.root,
      `${root}/scratch-ref`,
      bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    ).runReplay(
      runRequest(
        bundle,
        "fixture://captures/toy/upstream.json",
        digest,
        toy.originalSha,
      ),
    );
    assert.ok(nonGatewayRefRun.ok);
    if (nonGatewayRefRun.ok) {
      assert.deepEqual(nonGatewayRefRun.value.limitations, [
        "fixture_redacted",
      ]);
    }
  });
});

Deno.test("causal proof: source checkout stays untouched and scratch is cleaned", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const { bundle, digest, ref } = await gatewayBundle(toy.originalSha);
    const port = portWith(toy.root, `${root}/scratch`, bundle, {
      config: evalConfig(FAIL_SCRIPT),
    });
    const result = assertPortOk(
      await port.runReplay(runRequest(bundle, ref, digest, toy.originalSha)),
    );
    assert.deepEqual(result.limitations, []);
    const env = testGitEnv(`${root}/home`);
    const status = await gitRun(toy.root, ["status", "--porcelain"], env);
    assert.equal(status.stdout.trim(), "");
    const scratchLeft: string[] = [];
    try {
      for await (const entry of Deno.readDir(`${root}/scratch`)) {
        scratchLeft.push(entry.name);
      }
    } catch {
      // scratch dir may not exist; no leftovers then
    }
    assert.deepEqual(scratchLeft, []);
  });
});
