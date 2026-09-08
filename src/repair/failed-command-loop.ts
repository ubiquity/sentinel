/**
 * Pure repeated failed-command loop guard for one exact Codex thread/turn.
 *
 * Adapted idea and the four-identical-failed-pairs pattern from
 * OpenHands/software-agent-sdk at
 * df2ea8fa5542d5d2a543e108bc8b2d4fbbab34b1
 * (clients/typescript/src/conversation/stuck-detector.ts, MIT); see the
 * forthcoming docs/THIRD_PARTY_NOTICES.md for the attribution, license text
 * and modification record. No upstream framework, server, workspace or event
 * classes are imported; this is an independent small state machine over
 * sanitized scalar observations.
 *
 * Normalization, checkpoint hashing and conclusive-failure classification are
 * trusted model-port integration concerns, not this helper's. Here a unique
 * observation is a counted failure only when conclusiveFailure is true and
 * exitCode is a nonzero integer; presence of a SHA-256 digest/checkpoint is
 * validated, and anything else resets the repeated sequence.
 *
 * State is bounded: at most MAX_UNIQUE_ITEM_IDS seen item IDs, plus the last
 * canonical key, its consecutive count, the steer phase and a broken-sequence
 * flag. No transcript, timestamps, reasons or raw output are retained.
 */

/** One completed command item observed for the exact thread/turn. */
export interface FailedCommandObservation {
  threadId: string;
  turnId: string;
  itemId: string;
  command: string;
  cwd: string;
  exitCode: number;
  outputDigest: string;
  checkpoint: string;
  conclusiveFailure: boolean;
}

/** Guard decision; steer/interrupt carry a sanitized evidence digest only. */
export type FailedCommandLoopResult =
  | { kind: "continue" }
  | { kind: "steer"; evidenceDigest: string }
  | { kind: "interrupt"; evidenceDigest: string };

const MAX_UNIQUE_ITEM_IDS = 1024;
const STEER_REQUIRED_FAILURES = 4;
const INTERRUPT_AFTER_UNBROKEN_PAIRS = 2;
const INTERRUPT_AFTER_BROKEN_PAIRS = 6; // four identical plus two later pairs
const SHA256_HEX = /^[0-9a-f]{64}$/i;

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

/** Canonical comparison key: exact tuple, ignoring item ID and timing. */
function canonicalKey(item: FailedCommandObservation): string {
  return JSON.stringify([
    item.command,
    item.cwd,
    item.exitCode,
    item.outputDigest,
    item.checkpoint,
  ]);
}

const encoder = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

type SteerPhase = "none" | "pending" | "used";

export class FailedCommandLoopGuard {
  readonly threadId: string;
  readonly turnId: string;

  private seenItemIds = new Set<string>();
  private disabled = false;
  private interrupted = false;
  private key: string | null = null;
  private count = 0;
  private phase: SteerPhase = "none";
  private sequenceBroken = false;
  private postAckCount = 0;
  private postAckNeed = INTERRUPT_AFTER_UNBROKEN_PAIRS;

  constructor(threadId: string, turnId: string) {
    this.threadId = threadId;
    this.turnId = turnId;
  }

  async observe(
    input: FailedCommandObservation,
  ): Promise<FailedCommandLoopResult> {
    if (this.disabled || this.interrupted) {
      return { kind: "continue" };
    }
    if (input.threadId !== this.threadId || input.turnId !== this.turnId) {
      return { kind: "continue" };
    }
    if (this.seenItemIds.has(input.itemId)) {
      return { kind: "continue" };
    }
    if (this.seenItemIds.size >= MAX_UNIQUE_ITEM_IDS) {
      this.disabled = true;
      return { kind: "continue" };
    }
    this.seenItemIds.add(input.itemId);

    const failed =
      input.conclusiveFailure === true &&
      typeof input.exitCode === "number" &&
      Number.isInteger(input.exitCode) &&
      input.exitCode !== 0;
    if (
      !failed || !isSha256Hex(input.outputDigest) ||
      !isSha256Hex(input.checkpoint)
    ) {
      this.resetSequence();
      return { kind: "continue" };
    }

    const key = canonicalKey(input);
    const sameSequence = key === this.key;
    if (sameSequence) {
      this.count += 1;
    } else {
      this.key = key;
      this.count = 1;
    }

    if (this.phase === "none") {
      if (this.count >= STEER_REQUIRED_FAILURES) {
        this.phase = "pending";
        this.sequenceBroken = false;
        return { kind: "steer", evidenceDigest: await sha256Hex(key) };
      }
      return { kind: "continue" };
    }

    if (this.phase === "pending") {
      if (!sameSequence) {
        this.sequenceBroken = true;
      }
      return { kind: "continue" };
    }

    // Steer acknowledged; only observations after the ack count further.
    if (sameSequence) {
      this.postAckCount += 1;
    } else {
      this.sequenceBroken = true;
      this.postAckCount = 1;
      this.postAckNeed = INTERRUPT_AFTER_BROKEN_PAIRS;
    }
    if (this.postAckCount >= this.postAckNeed) {
      this.interrupted = true;
      return { kind: "interrupt", evidenceDigest: await sha256Hex(key) };
    }
    return { kind: "continue" };
  }

  /** Mark the already-suggested steer as acknowledged; no-op before a steer. */
  markSteered(): void {
    if (this.phase !== "pending") {
      return;
    }
    this.phase = "used";
    this.postAckCount = 0;
    this.postAckNeed = this.sequenceBroken
      ? INTERRUPT_AFTER_BROKEN_PAIRS
      : INTERRUPT_AFTER_UNBROKEN_PAIRS;
  }

  /**
   * Reset repeated-sequence progress on an edit, inconclusive evidence or a
   * concurrent active command. Seen item IDs and the used steer are kept.
   */
  resetProgress(): void {
    this.resetSequence();
  }

  private resetSequence(): void {
    this.key = null;
    this.count = 0;
    if (this.phase !== "none") {
      this.sequenceBroken = true;
      if (this.phase === "used") {
        this.postAckCount = 0;
        this.postAckNeed = INTERRUPT_AFTER_BROKEN_PAIRS;
      }
    }
  }
}
