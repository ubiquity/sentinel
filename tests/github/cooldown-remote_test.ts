import assert from "node:assert/strict";
import {
  FakeGitExecutor,
  FakeReviewService,
  httpRespond,
  makePort,
  pullWire,
  REVIEWER,
  SHA1,
  SHA2,
} from "./helpers.ts";
import {
  type GitHubCooldownGateV1,
  portError,
  portOk,
} from "../../src/contracts/ports.ts";

Deno.test("github remote git/review gate and ambiguity handling", async () => {
  for (
    const mode of [
      "initial",
      "before-push",
      "after-ambiguous",
      "typed-error",
      "record-failure",
    ]
  ) {
    let blocked = mode === "initial";
    let recorded = 0;
    const git = new FakeGitExecutor();
    const metadata = {
      kind: "secondary",
      observedAt: 1786000000000,
      retryNotBefore: 1786000060000,
      observationId: "a".repeat(64),
      fallback: true,
    } as const;
    const gate: GitHubCooldownGateV1 = {
      beforeRequest: () =>
        Promise.resolve(
          blocked ? portError("rate_limited", "cooldown") : portOk(undefined),
        ),
      recordRateLimit: (_id, m) => {
        recorded++;
        assert.deepEqual(m, metadata);
        return Promise.resolve(
          mode === "record-failure"
            ? portError("unavailable", "state fault")
            : portOk(undefined),
        );
      },
    };
    const ref = "refs/heads/sentinel/fixture";
    if (mode === "before-push") {
      git.refs.set(ref, SHA1);
      git.isAncestor = () => {
        blocked = true;
        return Promise.resolve(portOk(true));
      };
    }
    if (mode === "after-ambiguous") {
      git.nextPush = { status: "ambiguous" };
      git.ambiguousAppliesEffect = true;
      const push = git.push.bind(git);
      git.push = async (...args) => {
        const result = await push(...args);
        blocked = true;
        return result;
      };
    }
    if (mode === "typed-error" || mode === "record-failure") {
      git.readRemoteRef = () =>
        Promise.resolve(portError("rate_limited", "remote throttle", metadata));
    }
    const { port } = makePort({ git, cooldownGate: gate });
    const result = await port.pushHead(
      ref,
      SHA2,
      mode === "before-push" ? SHA1 : null,
    );
    if (mode === "initial") {
      assert.equal(result.ok, false);
      assert.equal(git.remoteReads.length, 0);
      assert.equal(git.pushes.length, 0);
    }
    if (mode === "before-push") {
      assert.equal(result.ok, false);
      assert.equal(git.remoteReads.length, 1);
      assert.equal(git.pushes.length, 0);
    }
    if (mode === "after-ambiguous") {
      assert.deepEqual(result, portOk("ambiguous"));
      assert.equal(git.remoteReads.length, 1);
      assert.equal(git.pushes.length, 1);
      assert.equal(git.refs.get(ref), SHA2);
    }
    if (mode === "typed-error" || mode === "record-failure") {
      assert.equal(recorded, 1);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(
          result.error.kind,
          mode === "record-failure" ? "unavailable" : "rate_limited",
        );
        if (mode === "typed-error") {
          assert.deepEqual(result.error.rateLimit, metadata);
        }
      }
    }
  }
  for (const mode of ["submit", "observe"]) {
    let checks = 0;
    const review = new FakeReviewService();
    const gate: GitHubCooldownGateV1 = {
      beforeRequest: () =>
        Promise.resolve(
          ++checks > 2
            ? portError("rate_limited", "cooldown")
            : portOk(undefined),
        ),
      recordRateLimit: () => Promise.resolve(portOk(undefined)),
    };
    const { port, transport } = makePort({
      review,
      cooldownGate: gate,
      script: [httpRespond("GET", "/pulls/1", 200, pullWire())],
    });
    const result = mode === "submit"
      ? await port.requestReview({
        operationKey: "review:work-1",
        prNumber: 1,
        expectedHead: SHA1,
        expectedBase: SHA2,
        expectedReviewer: REVIEWER,
      })
      : await port.observeReview({
        operationKey: "review:work-1",
        prNumber: 1,
        head: SHA1,
      });
    assert.equal(result.ok, false);
    assert.equal(transport.requests.length, 1);
    assert.equal(review.submits.length, 0);
    assert.equal(review.reads.length, 0);
    assert.equal(checks, 3);
  }
  console.log("PASS 7 actual remote Git/review gate and ambiguity cases");
});
