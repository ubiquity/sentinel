/**
 * Trusted hosted release-receipt reader (fixed self scope 0).
 *
 * The hosted repair host composes this read-only capability onto its repair
 * state view so the self release path consumes the protected supervisor's
 * PERSISTED receipt — never a raw workflow-green run. It reads only the
 * existing release state snapshot, performs no writes, starts no model, uses
 * no HTTP, token or GitHub client, and every failure is a bounded sanitized
 * `unavailable`.
 */

import {
  hostedReceiptBindsRequest,
  parseHostedReleaseRecordV1,
} from "../contracts/hosted-supervisor.ts";
import type { HostedReleaseRecordV1 } from "../contracts/hosted-supervisor.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { PortResultV1, StateReadView } from "../contracts/ports.ts";
import { parseReleaseRequestV1 } from "../contracts/release.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import { parseReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { tryParse } from "../contracts/validation.ts";

const STATIC_STATE = "hosted supervisor release state is unavailable";
const STATIC_BINDING = "hosted supervisor receipt does not bind the request";
const STATIC_SCOPE = "hosted supervisor receipt requires the self scope";

/** Exact hosted self scope: the no-App owner credential identity. */
function isHostedSelfRequest(request: ReleaseRequestV1): boolean {
  const repository = request.target.repository;
  return repository.installationId === 0 && repository.owner === "ubiquity" &&
    repository.name === "sentinel" &&
    request.target.environment === "production";
}

/**
 * Read the persisted supervisor receipt for one exact self production
 * request. A missing record is an explicit null; an absent, unreadable or
 * corrupt release snapshot is unavailable; a malformed, foreign or
 * differently-bound request/record is invalid or unavailable. Never throws and
 * never infers a receipt from the active runtime pointer.
 */
export async function readHostedReleaseReceipt(
  input: { state: StateReadView },
  request: ReleaseRequestV1,
): Promise<PortResultV1<HostedReleaseRecordV1 | null>> {
  if (!tryParse(parseReleaseRequestV1, request).ok) {
    return portError("invalid", STATIC_SCOPE);
  }
  if (!isHostedSelfRequest(request)) {
    return portError("invalid", STATIC_SCOPE);
  }
  let snapshot: ReleaseStateSnapshotV1;
  try {
    const read = await input.state.readRelease();
    if (!read.ok) return portError("unavailable", STATIC_STATE);
    if (read.value.status !== "found") {
      return portError("unavailable", STATIC_STATE);
    }
    snapshot = parseReleaseStateSnapshotV1(read.value.snapshot);
  } catch {
    return portError("unavailable", STATIC_STATE);
  }
  const record = snapshot.hostedReleases.find((item) => item.id === request.id);
  if (record === undefined) return portOk(null);
  const parsed = tryParse(parseHostedReleaseRecordV1, record);
  if (!parsed.ok) return portError("unavailable", STATIC_STATE);
  if (!hostedReceiptBindsRequest(parsed.value, request)) {
    return portError("unavailable", STATIC_BINDING);
  }
  return portOk(parsed.value);
}
