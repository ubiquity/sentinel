/**
 * Trusted causal-proof boundary tests (plan 01): pure structural validation.
 *
 * The strict validator, the canonical expected-failure identity, the
 * deterministic proof/fixture reference grammar and the fixed
 * trusted-consumer command identity are exercised WITHOUT any subprocess:
 * a proof is fully bound only with the fixed verifier/command identities,
 * consistent restricted refs, the canonical expected-failure identity and
 * TWO intended-failure observations with observed nonzero exit codes,
 * observed test identities and output digests; an absent, structurally
 * invalid, stale, identity-mismatched or revoked-identity proof is never
 * partially trusted. (The consuming boundary and the concrete verifier are
 * exercised in causal-verifier_test.ts with the real process runtime.)
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
import {
  CAUSAL_CONSUMER_COMMAND_ID,
  deriveExpectedFailureIdentity,
  GATEWAY_CAUSAL_VERIFIER_ID,
  gatewayCausalProofRef,
  gatewayFixtureRefIdentity,
  validateGatewayCausalProof,
} from "../../src/replay/causal-proof.ts";
import type { GatewayCausalProofV1 } from "../../src/replay/causal-proof.ts";
import { computeReplayFixtureDigest } from "../../src/replay/fixture.ts";
import type { ExpectedFailureV1 } from "../../src/replay/fixture.ts";
import { TOY_REPOSITORY } from "./helpers.ts";

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
const OUTPUT_DIGEST = "a1".repeat(32);

const FAKE_ORIGINAL_SHA = "1".repeat(40) as GitSha;

const textEncoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Proof/bundle builders (deterministic; identities derived by the canonical
// module so the tests also prove the derivation loop).
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

function observation(): GatewayCausalProofV1["originalObservation"] {
  return {
    intended: true,
    outputDigest: OUTPUT_DIGEST,
    observedTestIds: [TEST_ID],
    exitCode: 1,
  };
}

async function buildProof(
  bundleDigest: FixtureDigest,
  originalGitSha: GitSha,
  overrides: Partial<GatewayCausalProofV1> = {},
): Promise<GatewayCausalProofV1> {
  const fixtureRef =
    `fixture://gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}/${bundleDigest}`;
  const expectedFailureIdentity = await deriveExpectedFailureIdentity(
    EXPECTED_FAILURE,
  );
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
    consumerCommandId: CAUSAL_CONSUMER_COMMAND_ID,
    testIds: [TEST_ID],
    expectedFailure: EXPECTED_FAILURE,
    expectedFailureIdentity,
    originalObservation: observation(),
    sanitizedObservation: observation(),
    ...overrides,
  };
  return proof;
}

// ---------------------------------------------------------------------------
// Identity derivations and reference grammar (no subprocess)
// ---------------------------------------------------------------------------

Deno.test("causal proof: canonical expected-failure identity is deterministic and strictly bound to the expected failure", async () => {
  const first = await deriveExpectedFailureIdentity(EXPECTED_FAILURE);
  const second = await deriveExpectedFailureIdentity(EXPECTED_FAILURE);
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(
    first,
    await deriveExpectedFailureIdentity({
      reason: EXPECTED_FAILURE.reason,
      match: { kind: "contains", text: "different failure text" },
    }),
    "changed matcher must change the identity",
  );
  assert.notEqual(
    first,
    await deriveExpectedFailureIdentity({
      reason: "different reason",
      match: EXPECTED_FAILURE.match,
    }),
    "changed reason must change the identity",
  );
  assert.notEqual(
    first,
    await deriveExpectedFailureIdentity({
      reason: EXPECTED_FAILURE.reason,
      match: { kind: "regex", source: "stream terminated" },
    }),
    "changed matcher kind must change the identity",
  );
});

Deno.test("causal proof: the fixed trusted-consumer command identity is constant", () => {
  assert.equal(CAUSAL_CONSUMER_COMMAND_ID, "causal_consumer");
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

// ---------------------------------------------------------------------------
// Strict structural validation (no subprocess)
// ---------------------------------------------------------------------------

Deno.test("causal proof: strict structural validation accepts only fully bound proofs", async () => {
  const digest = "b".repeat(64) as FixtureDigest;
  const proof = await buildProof(digest, FAKE_ORIGINAL_SHA);
  const parsed = await validateGatewayCausalProof(proof);
  assert.notEqual(parsed, null);
  assert.equal(parsed!.verifier, GATEWAY_CAUSAL_VERIFIER_ID);
  assert.equal(parsed!.bundleDigest, digest);
  assert.equal(parsed!.originalGitSha, FAKE_ORIGINAL_SHA);
  assert.equal(parsed!.consumerCommandId, CAUSAL_CONSUMER_COMMAND_ID);
  assert.equal(parsed!.expectedFailureIdentity, proof.expectedFailureIdentity);
  assert.deepEqual(parsed!.originalObservation, observation());
  assert.deepEqual(parsed!.sanitizedObservation, observation());

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
  // The trusted-consumer command identity is fixed: an interchangeable
  // command identity is never a proof.
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      consumerCommandId: "other_consumer" as CommandId,
    }),
    null,
  );
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      consumerCommandId: "not allowed" as CommandId,
    }),
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
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      testCommandId: "not allowed",
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
  // The expected-failure identity must be the canonical identity of the
  // exact expected failure; a stale identity is never accepted.
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      expectedFailureIdentity: "d".repeat(64),
    }),
    null,
  );
  // Both observations must be intended failures with observed bindings.
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      originalObservation: {
        intended: false,
        outputDigest: OUTPUT_DIGEST,
        observedTestIds: [TEST_ID],
        exitCode: 1,
      },
    }),
    null,
  );
  // Observed bindings are validated: nonzero bounded exit, 64-hex output
  // digest and the EXACT observed test identity (no extras, no omissions).
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      originalObservation: {
        intended: true,
        outputDigest: OUTPUT_DIGEST,
        observedTestIds: [TEST_ID],
        exitCode: 0,
      },
    }),
    null,
  );
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      originalObservation: {
        intended: true,
        outputDigest: OUTPUT_DIGEST,
        observedTestIds: [TEST_ID],
        exitCode: 300,
      },
    }),
    null,
  );
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      originalObservation: {
        intended: true,
        outputDigest: "f".repeat(40),
        observedTestIds: [TEST_ID],
        exitCode: 1,
      },
    }),
    null,
  );
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      originalObservation: {
        intended: true,
        outputDigest: OUTPUT_DIGEST,
        observedTestIds: [],
        exitCode: 1,
      },
    }),
    null,
  );
  // Extra observed identities are never accepted (the trusted set is exact).
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      originalObservation: {
        intended: true,
        outputDigest: OUTPUT_DIGEST,
        observedTestIds: [TEST_ID, "gateway:extra"],
        exitCode: 1,
      },
    }),
    null,
  );
  // A missing observed identity is never accepted either.
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      originalObservation: {
        intended: true,
        outputDigest: OUTPUT_DIGEST,
        observedTestIds: ["gateway:other"],
        exitCode: 1,
      },
    }),
    null,
  );
  // A changed matcher with a stale expected-failure identity never validates
  // (the identity must be re-derived for the exact changed failure).
  assert.equal(
    await validateGatewayCausalProof({
      ...proof,
      expectedFailure: {
        reason: "different reason",
        match: { kind: "contains", text: "different text" },
      },
    }),
    null,
  );
});

Deno.test("causal proof: observation digests are observed-evidence bindings, not signature identities", async () => {
  // Two intended observations may carry DIFFERENT observed digests: the
  // digest is per-execution observed evidence, never an equality-derived
  // "failure signature".
  const digest = "c".repeat(64) as FixtureDigest;
  const proof = await buildProof(digest, FAKE_ORIGINAL_SHA);
  const different = await validateGatewayCausalProof({
    ...proof,
    sanitizedObservation: {
      intended: true,
      outputDigest: "0".repeat(64),
      observedTestIds: [TEST_ID],
      exitCode: 1,
    },
  });
  assert.notEqual(different, null);
  // The observed output digest is not interchangeable with the canonical
  // expected-failure identity.
  assert.notEqual(
    different!.originalObservation.outputDigest,
    proof.expectedFailureIdentity,
  );
  assert.notEqual(
    different!.sanitizedObservation.outputDigest,
    different!.expectedFailureIdentity,
  );
  // The expected-failure identity is NEVER an observed exit/test binding.
  assert.equal(proof.expectedFailureIdentity.length, 64);
  assert.notEqual(proof.expectedFailureIdentity, "a1".repeat(32));
});

Deno.test("causal proof: the bundle digest covers the real entry bytes", async () => {
  const entries = gatewayEntries();
  const digest = await computeReplayFixtureDigest(entries);
  const proof = await buildProof(digest, FAKE_ORIGINAL_SHA);
  assert.equal(
    proof.bundleDigest,
    await computeReplayFixtureDigest([
      ...entries,
    ]),
  );
  // Byte change => digest change.
  const changed = entries.map((entry, index) =>
    index === 0
      ? {
        ...entry,
        bytes: new Uint8Array([...entry.bytes, 0x78]),
      }
      : entry
  );
  assert.notEqual(digest, await computeReplayFixtureDigest(changed));
});
