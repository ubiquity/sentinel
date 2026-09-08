/**
 * m04-repair failed-command-loop guard tests: four identical failed pairs then
 * two more after a steer ack, duplicate/stale events, reset conditions,
 * pending-ack semantics, progress during pending steering, bounded ID window
 * disable and single-steer behavior. Pure in-memory state only.
 */
import assert from "node:assert/strict";

import {
  FailedCommandLoopGuard,
  type FailedCommandLoopResult,
  type FailedCommandObservation,
} from "../../src/repair/failed-command-loop.ts";

const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";

const hex = (n: number): string => n.toString(16).padStart(64, "0");

function obs(
  overrides: Partial<FailedCommandObservation> = {},
): FailedCommandObservation {
  return {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: "item-1",
    command: "deno test tests/repair/failed-command-loop_test.ts",
    cwd: "/repo",
    exitCode: 1,
    outputDigest: hex(1),
    checkpoint: hex(2),
    conclusiveFailure: true,
    ...overrides,
  };
}

async function observe(
  guard: FailedCommandLoopGuard,
  overrides: Partial<FailedCommandObservation> = {},
): Promise<FailedCommandLoopResult> {
  return guard.observe(obs(overrides));
}

function expectContinue(result: FailedCommandLoopResult): void {
  assert.deepEqual(result, { kind: "continue" });
}

function expectSteer(result: FailedCommandLoopResult): string {
  assert.equal(result.kind, "steer");
  return result.kind === "steer" ? result.evidenceDigest : "";
}

function expectInterrupt(result: FailedCommandLoopResult): string {
  assert.equal(result.kind, "interrupt");
  return result.kind === "interrupt" ? result.evidenceDigest : "";
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

Deno.test("failed-command-loop: four identical failed pairs steer, two more after ack interrupt", async () => {
  const guard = new FailedCommandLoopGuard(THREAD_ID, TURN_ID);
  expectContinue(await observe(guard, { itemId: "item-1" }));
  expectContinue(await observe(guard, { itemId: "item-2" }));
  expectContinue(await observe(guard, { itemId: "item-3" }));
  const steer = await observe(guard, { itemId: "item-4" });

  const steerDigest = expectSteer(steer);
  assert.match(steerDigest, /^[0-9a-f]{64}$/);

  guard.markSteered();
  expectContinue(await observe(guard, { itemId: "item-5" }));
  const interrupt = await observe(guard, { itemId: "item-6" });
  assert.equal(expectInterrupt(interrupt), steerDigest);

  // Interrupt is emitted once; later observations just continue.
  expectContinue(await observe(guard, { itemId: "item-7" }));
});

Deno.test("failed-command-loop: duplicate item IDs never count and never reset", async () => {
  const guard = new FailedCommandLoopGuard(THREAD_ID, TURN_ID);
  expectContinue(await observe(guard, { itemId: "dup" }));
  // Re-observations of the same item, even with reset-looking metadata.
  expectContinue(await observe(guard, { itemId: "dup", exitCode: 0 }));
  expectContinue(
    await observe(guard, {
      itemId: "dup",
      conclusiveFailure: false,
    }),
  );
  expectContinue(await observe(guard, { itemId: "dup", outputDigest: hex(9) }));
  // Three more unique identical failures still reach the steer threshold.
  expectContinue(await observe(guard, { itemId: "item-2" }));
  expectContinue(await observe(guard, { itemId: "item-3" }));
  expectSteer(await observe(guard, { itemId: "item-4" }));
});

Deno.test("failed-command-loop: foreign thread and stale turn observations are ignored", async () => {
  const guard = new FailedCommandLoopGuard(THREAD_ID, TURN_ID);
  expectContinue(
    await observe(guard, {
      itemId: "foreign",
      threadId: "other-thread",
    }),
  );
  expectContinue(await observe(guard, { itemId: "stale", turnId: "turn-0" }));
  // Only the four real failures count.
  expectContinue(await observe(guard, { itemId: "item-1" }));
  expectContinue(await observe(guard, { itemId: "item-2" }));
  expectContinue(await observe(guard, { itemId: "item-3" }));
  expectSteer(await observe(guard, { itemId: "item-4" }));
});

Deno.test("failed-command-loop: success, inconclusive and zero-exit unique observations reset", async () => {
  const success = new FailedCommandLoopGuard(THREAD_ID, TURN_ID);
  expectContinue(await observe(success, { itemId: "item-1" }));
  expectContinue(await observe(success, { itemId: "item-2" }));
  expectContinue(await observe(success, { itemId: "item-3", exitCode: 0 }));
  expectContinue(await observe(success, { itemId: "item-4" }));
  expectContinue(await observe(success, { itemId: "item-5" }));
  expectContinue(await observe(success, { itemId: "item-6" }));
  expectSteer(await observe(success, { itemId: "item-7" }));

  const inconclusive = new FailedCommandLoopGuard(THREAD_ID, TURN_ID);
  expectContinue(await observe(inconclusive, { itemId: "item-1" }));
  expectContinue(await observe(inconclusive, { itemId: "item-2" }));
  expectContinue(
    await observe(inconclusive, {
      itemId: "item-3",
      conclusiveFailure: false,
      exitCode: 2,
    }),
  );
  expectContinue(await observe(inconclusive, { itemId: "item-4" }));
  expectContinue(await observe(inconclusive, { itemId: "item-5" }));
  expectContinue(await observe(inconclusive, { itemId: "item-6" }));
  expectSteer(await observe(inconclusive, { itemId: "item-7" }));
});

Deno.test("failed-command-loop: a different failure tuple resets the count", async () => {
  // Each canonical component change breaks the repeat: exit code, command,
  // cwd, output digest and checkpoint; item ID never does.
  const variants = [
    { itemId: "item-3", exitCode: 2 },
    { itemId: "item-3", command: "deno test other.ts" },
    { itemId: "item-3", cwd: "/repo/src" },
    { itemId: "item-3", outputDigest: hex(3) },
    { itemId: "item-3", checkpoint: hex(4) },
  ];
  for (const variant of variants) {
    const guard = new FailedCommandLoopGuard(THREAD_ID, TURN_ID);
    expectContinue(await observe(guard, { itemId: "item-1" }));
    expectContinue(await observe(guard, { itemId: "item-2" }));
    expectContinue(await observe(guard, variant));
    // Three further original-tuple failures still need four consecutive.
    expectContinue(await observe(guard, { itemId: "item-4" }));
    expectContinue(await observe(guard, { itemId: "item-5" }));
    expectContinue(await observe(guard, { itemId: "item-6" }));
    expectSteer(await observe(guard, { itemId: "item-7" }));
  }
});

Deno.test("failed-command-loop: missing or malformed digest/checkpoint resets", async () => {
  const missing = new FailedCommandLoopGuard(THREAD_ID, TURN_ID);
  expectContinue(await observe(missing, { itemId: "item-1" }));
  expectContinue(await observe(missing, { itemId: "item-2" }));
  const noCheckpoint = obs({ itemId: "item-3" });
  delete (noCheckpoint as Partial<FailedCommandObservation>).checkpoint;
  expectContinue(await missing.observe(noCheckpoint));
  expectContinue(await observe(missing, { itemId: "item-4" }));
  expectContinue(await observe(missing, { itemId: "item-5" }));
  expectContinue(await observe(missing, { itemId: "item-6" }));
  expectSteer(await observe(missing, { itemId: "item-7" }));

  const malformed = new FailedCommandLoopGuard(THREAD_ID, TURN_ID);
  expectContinue(await observe(malformed, { itemId: "item-1" }));
  expectContinue(await observe(malformed, { itemId: "item-2" }));
  expectContinue(
    await observe(malformed, {
      itemId: "item-3",
      outputDigest: "not-sha256",
    }),
  );
  expectContinue(
    await observe(malformed, {
      itemId: "item-4",
      outputDigest: "",
    }),
  );
  // Each malformed unique observation resets, so four consecutive failures
  // are needed after the last reset before the steer threshold.
  expectContinue(await observe(malformed, { itemId: "item-5" }));
  expectContinue(await observe(malformed, { itemId: "item-6" }));
  expectContinue(await observe(malformed, { itemId: "item-7" }));
  expectSteer(await observe(malformed, { itemId: "item-8" }));
});

Deno.test("failed-command-loop: events between steer and acknowledgement never count post-steer", async () => {
  const guard = new FailedCommandLoopGuard(THREAD_ID, TURN_ID);
  expectContinue(await observe(guard, { itemId: "item-1" }));
  expectContinue(await observe(guard, { itemId: "item-2" }));
  expectContinue(await observe(guard, { itemId: "item-3" }));
  expectSteer(await observe(guard, { itemId: "item-4" }));
  // Two identical pairs before the caller acks must not count as post-steer.
  expectContinue(await observe(guard, { itemId: "item-5" }));
  expectContinue(await observe(guard, { itemId: "item-6" }));
  guard.markSteered();
  expectContinue(await observe(guard, { itemId: "item-7" }));
  expectInterrupt(await observe(guard, { itemId: "item-8" }));
});

Deno.test("failed-command-loop: progress during pending steering requires four plus two fresh pairs after ack", async () => {
  const changed = new FailedCommandLoopGuard(THREAD_ID, TURN_ID);
  expectContinue(await observe(changed, { itemId: "item-1" }));
  expectContinue(await observe(changed, { itemId: "item-2" }));
  expectContinue(await observe(changed, { itemId: "item-3" }));
  expectSteer(await observe(changed, { itemId: "item-4" }));
  // Progress while steering: a different cwd starts a new tuple.
  expectContinue(
    await observe(changed, { itemId: "item-5", cwd: "/repo/src" }),
  );
  expectContinue(
    await observe(changed, { itemId: "item-6", cwd: "/repo/src" }),
  );
  changed.markSteered();
  // Broken old sequence: six unchanged pairs after the ack, no second steer.
  for (let index = 7; index <= 11; index++) {
    expectContinue(
      await observe(changed, {
        itemId: `item-${index}`,
        cwd: "/repo/src",
      }),
    );
  }
  const interrupt = await observe(changed, {
    itemId: "item-12",
    cwd: "/repo/src",
  });
  assert.equal(expectInterrupt(interrupt).length, 64);

  // resetProgress during pending steering behaves the same and keeps seen IDs.
  const reset = new FailedCommandLoopGuard(THREAD_ID, TURN_ID);
  expectContinue(await observe(reset, { itemId: "item-1" }));
  expectContinue(await observe(reset, { itemId: "item-2" }));
  expectContinue(await observe(reset, { itemId: "item-3" }));
  expectSteer(await observe(reset, { itemId: "item-4" }));
  reset.resetProgress();
  // Old seen item stays seen; nothing is replayed or recounted.
  expectContinue(await observe(reset, { itemId: "item-1" }));
  reset.markSteered();
  for (let index = 5; index <= 9; index++) {
    expectContinue(
      await observe(reset, {
        itemId: `item-${index}`,
        cwd: "/repo/src",
      }),
    );
  }
  expectInterrupt(
    await observe(reset, {
      itemId: "item-10",
      cwd: "/repo/src",
    }),
  );
});

Deno.test("failed-command-loop: item ID window disables the guard at the cap without evicting", async () => {
  const guard = new FailedCommandLoopGuard(THREAD_ID, TURN_ID);
  for (let index = 1; index <= 1024; index++) {
    expectContinue(
      await observe(guard, {
        itemId: `item-${index}`,
        command: `cmd-${index}`,
      }),
    );
  }
  // The 1025th unique item cannot be added: the guard is permanently off.
  expectContinue(
    await observe(guard, {
      itemId: "item-1025",
      command: "cmd-1025",
    }),
  );
  // Even four identical failures must never steer afterwards.
  expectContinue(await observe(guard, { itemId: "after-1" }));
  expectContinue(await observe(guard, { itemId: "after-2" }));
  expectContinue(await observe(guard, { itemId: "after-3" }));
  expectContinue(await observe(guard, { itemId: "after-4" }));
  // Old duplicates are not replayed as fresh evidence.
  expectContinue(await observe(guard, { itemId: "item-1" }));
});

Deno.test("failed-command-loop: one steer per instance and never total lifetime counts", async () => {
  const guard = new FailedCommandLoopGuard(THREAD_ID, TURN_ID);
  expectContinue(await observe(guard, { itemId: "item-1" }));
  expectContinue(await observe(guard, { itemId: "item-2" }));
  expectContinue(await observe(guard, { itemId: "item-3" }));
  expectSteer(await observe(guard, { itemId: "item-4" }));
  guard.markSteered();
  expectContinue(await observe(guard, { itemId: "item-5" }));
  expectInterrupt(await observe(guard, { itemId: "item-6" }));

  // A broken sequence after steering never re-steers; it needs four plus two.
  const broken = new FailedCommandLoopGuard(THREAD_ID, TURN_ID);
  expectContinue(await observe(broken, { itemId: "item-1" }));
  expectContinue(await observe(broken, { itemId: "item-2" }));
  expectContinue(await observe(broken, { itemId: "item-3" }));
  expectSteer(await observe(broken, { itemId: "item-4" }));
  broken.markSteered();
  broken.resetProgress();
  expectContinue(await observe(broken, { itemId: "item-5", cwd: "/repo/src" }));
  expectContinue(await observe(broken, { itemId: "item-6", cwd: "/repo/src" }));
  expectContinue(await observe(broken, { itemId: "item-7", cwd: "/repo/src" }));
  expectContinue(await observe(broken, { itemId: "item-8", cwd: "/repo/src" }));
  expectContinue(await observe(broken, { itemId: "item-9", cwd: "/repo/src" }));
  expectInterrupt(
    await observe(broken, {
      itemId: "item-10",
      cwd: "/repo/src",
    }),
  );
});

Deno.test("failed-command-loop: markSteered before a steer is a no-op", async () => {
  const guard = new FailedCommandLoopGuard(THREAD_ID, TURN_ID);
  guard.markSteered();
  expectContinue(await observe(guard, { itemId: "item-1" }));
  expectContinue(await observe(guard, { itemId: "item-2" }));
  expectContinue(await observe(guard, { itemId: "item-3" }));
  expectSteer(await observe(guard, { itemId: "item-4" }));
});

Deno.test("failed-command-loop: evidenceDigest is the deterministic sha256 of the canonical tuple", async () => {
  const expected = await sha256Hex(
    JSON.stringify([
      obs().command,
      obs().cwd,
      obs().exitCode,
      obs().outputDigest,
      obs().checkpoint,
    ]),
  );
  const first = new FailedCommandLoopGuard(THREAD_ID, TURN_ID);
  let digest = "";
  for (let index = 1; index <= 4; index++) {
    const result = await observe(first, { itemId: `item-${index}` });
    if (index === 4) {
      digest = expectSteer(result);
    } else {
      expectContinue(result);
    }
  }
  assert.equal(digest, expected);

  // Same canonical tuple, another instance: identical digest.
  const second = new FailedCommandLoopGuard(THREAD_ID, TURN_ID);
  for (let index = 1; index <= 3; index++) {
    expectContinue(await observe(second, { itemId: `item-${index}` }));
  }
  assert.equal(
    expectSteer(await observe(second, { itemId: "item-4" })),
    expected,
  );

  // A different canonical tuple yields a different digest.
  const other = new FailedCommandLoopGuard(THREAD_ID, TURN_ID);
  const otherCommand = "deno test other.ts";
  for (let index = 1; index <= 3; index++) {
    expectContinue(
      await observe(other, {
        itemId: `item-${index}`,
        command: otherCommand,
      }),
    );
  }
  const otherDigest = expectSteer(
    await observe(other, {
      itemId: "item-4",
      command: otherCommand,
    }),
  );
  assert.notEqual(otherDigest, expected);
});
