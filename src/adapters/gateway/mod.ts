/**
 * m02-evidence: gateway incident adapter, strict producer wire parsers and the
 * bounded restricted local artifact store.
 *
 * Owned module (`src/adapters/gateway/**`); the shared contracts in
 * `src/contracts/` are foundation-owned and frozen. The adapter consumes the
 * frozen proposed gateway producer HTTP contract (docs/contracts.md §11) and
 * the existing target replay export schema; the current target does not
 * implement the proposed index (m06 postponed), which the adapter maps to
 * `unavailable` — never to an empty successful listing.
 */

export {
  artifactRef,
  GatewayIncidentAdapter,
  type GatewayIncidentAdapterOptionsV1,
} from "./incident-adapter.ts";
export {
  type GatewayAuthProviderV1,
  type GatewayHttpRequestV1,
  type GatewayHttpResponseV1,
  gatewayRead,
  type GatewayTransportV1,
} from "./http.ts";
export {
  type ArtifactStoreErrorV1,
  ArtifactStoreFailure,
  type ArtifactStoreLimitsV1,
  type ArtifactStorePutV1,
  type ArtifactStoreResultV1,
  type ArtifactStoreV1,
  LocalArtifactStore,
  parseArtifactRefIdentity,
  type StoredArtifactV1,
} from "./store.ts";
export {
  concatReplayChunks,
  decodeBase64Url,
  encodeCanonicalBase64,
  GATEWAY_CURSOR_MAX_LENGTH,
  GATEWAY_INCIDENT_ID,
  GATEWAY_INDEX_PAGE_BYTE_CAP,
  GATEWAY_MAX_ARTIFACTS_PER_EVIDENCE,
  GATEWAY_MAX_SCAN_PAGES,
  GATEWAY_REPLAY_ALGORITHM,
  GATEWAY_REPLAY_CHUNK_BYTES,
  GATEWAY_REPLAY_COMPRESSION,
  GATEWAY_REPLAY_ENVELOPE_VERSION,
  GATEWAY_REPLAY_IV_BYTES,
  GATEWAY_REPLAY_MAX_CHUNKS,
  GATEWAY_REPLAY_MAX_CIPHERTEXT_BYTES,
  GATEWAY_REPLAY_TTL_MS,
  GATEWAY_RESPONSE_BYTE_CEILING,
  type GatewayIndexPageV1,
  type GatewayIndexRowV1,
  type GatewayReplayCaptureV1,
  type GatewayReplayManifestV1,
  type GatewayReplayPageV1,
  gatewayRowToSummary,
  GatewayWireError,
  parseGatewayIndexPageV1,
  parseGatewayIndexRowV1,
  parseGatewayReplayCaptureV1,
  parseGatewayReplayManifestV1,
  parseGatewayReplayPageV1,
  replayManifestToWire,
} from "./wire.ts";
export {
  createProtocolSanitizer,
  type GatewayRestrictedProvenanceV1,
  type GatewaySanitizedRequestV1,
  type GatewaySanitizerPolicyV1,
  type ProtocolSanitizer,
  type SanitizedGatewayFixtureV1,
  type SanitizedGatewayReplayV1,
  sanitizeGatewayReplay,
  sanitizeRecordedUpstream,
} from "./sanitize.ts";
