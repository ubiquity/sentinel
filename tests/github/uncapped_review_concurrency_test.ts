/**
 * Uncapped simultaneous reviews (owner update 2026-10-02T22:05:51Z: "lift all
 * the limits"). The review transport currently clamps every configured bound
 * to the hard-coded maximum three, and `src/host/local.ts` wires an even
 * tighter one. Both are artificial throttles on how many reviews can be in
 * flight at once.
 *
 * These cases drive the REAL `GitHubCodexReviewTransport`. Each submission is
 * held inside the transport's first awaited phase by a capture that never
 * settles, so the test observes pure admission concurrency: no GitHub write,
 * no model call, no network and no credentials are touched.
 *
 * RED before implementation: only the first three submissions are admitted and
 * every later one settles immediately as a capacity conflict.
 */
import assert from "node:assert/strict";

import type { GitHubApiClient } from "../../src/github/client.ts";
import {
  type CodexReviewPrepareCapabilityV1,
  GitHubCodexReviewTransport,
  type GitReviewSnapshotCaptureV1,
} from "../../src/github/codex-review-transport.ts";
import type {
  ReviewRequestSubmitV1,
  ReviewSubmitOutcomeV1,
} from "../../src/github/review-service.ts";
import type { PortResultV1 } from "../../src/contracts/ports.ts";
import { asGitSha } from "../../src/contracts/brands.ts";
import { FakeClock, REPO, REVIEWER, T0 } from "./helpers.ts";

const BASE = asGitSha("a".repeat(40));
const HEAD = asGitSha("b".repeat(40));
const PLATFORM_SLOTS = 256;

/** A capture that holds every op in its first awaited phase forever. */
function neverSettlingSnapshot(): GitReviewSnapshotCaptureV1 {
  return {
    capture: () => new Promise(() => {}),
  } as unknown as GitReviewSnapshotCaptureV1;
}

function neverPreparingReviewer(): CodexReviewPrepareCapabilityV1 {
  return {
    prepare: () => new Promise(() => {}),
  } as unknown as CodexReviewPrepareCapabilityV1;
}

function makeTransport(
  clock: FakeClock,
  maxActiveReviews?: number,
): GitHubCodexReviewTransport {
  return new GitHubCodexReviewTransport({
    client: {} as unknown as GitHubApiClient,
    repository: REPO,
    publisher: REVIEWER,
    clock,
    ownerRunId: "run-uncapped-reviews",
    snapshot: neverSettlingSnapshot(),
    reviewer: neverPreparingReviewer(),
    ...(maxActiveReviews === undefined ? {} : { maxActiveReviews }),
  });
}

function submission(index: number): ReviewRequestSubmitV1 {
  return {
    operationKey: `review-uncapped-${index}`,
    prNumber: index + 1,
    expectedHead: HEAD,
    expectedBase: BASE,
    expectedReviewer: REVIEWER,
    latestStartAt: T0 + 60_000,
    settleBy: T0 + 1_200_000,
  };
}

/** Flush the microtask/macrotask queue without advancing production time. */
function flushAdmissions(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function submitAll(
  transport: GitHubCodexReviewTransport,
  count: number,
): Promise<PortResultV1<ReviewSubmitOutcomeV1>[]> {
  const settled: PortResultV1<ReviewSubmitOutcomeV1>[] = [];
  const failures: unknown[] = [];
  for (let index = 0; index < count; index++) {
    transport.submitReview(submission(index)).then(
      (result) => settled.push(result),
      (error) => failures.push(error),
    );
  }
  await flushAdmissions();
  assert.deepEqual(failures, [], "admission must never reject");
  return settled;
}

Deno.test(
  "uncapped reviews: 256 simultaneous submissions are admitted, never clamped to three",
  async () => {
    const settled = await submitAll(
      makeTransport(new FakeClock(T0), PLATFORM_SLOTS),
      PLATFORM_SLOTS,
    );
    assert.deepEqual(
      settled,
      [],
      `only ${settled.length} of ${PLATFORM_SLOTS} submissions were refused for capacity`,
    );
  },
);

Deno.test(
  "uncapped reviews: the default transport applies no silent three-review bound",
  async () => {
    const settled = await submitAll(
      makeTransport(new FakeClock(T0)),
      PLATFORM_SLOTS,
    );
    assert.deepEqual(
      settled,
      [],
      `only ${settled.length} of ${PLATFORM_SLOTS} submissions were refused for capacity`,
    );
  },
);

Deno.test(
  "uncapped reviews control: an explicitly finite bound is still honored",
  async () => {
    const settled = await submitAll(makeTransport(new FakeClock(T0), 2), 3);
    assert.equal(settled.length, 1);
    assert.equal(settled[0].ok, false);
    if (!settled[0].ok) {
      assert.equal(settled[0].error.kind, "conflict");
    }
  },
);
