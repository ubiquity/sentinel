import assert from "node:assert/strict";
import { GitHubInstallationTokenProvider } from "../../src/github/auth.ts";
import {
  type GitHubCooldownGateV1,
  portError,
  portOk,
} from "../../src/contracts/ports.ts";

Deno.test("github token provider cooldown gate ordering", async () => {
  const now = 1786000000000;
  for (
    const mode of [
      "before-sign",
      "after-sign",
      "rate-response",
      "persist-failure",
    ]
  ) {
    const order: string[] = [];
    let checks = 0;
    const gate: GitHubCooldownGateV1 = {
      beforeRequest: () => {
        checks++;
        order.push("gate");
        return Promise.resolve(
          mode === "before-sign" || mode === "after-sign" && checks === 2
            ? portError("rate_limited", "cooldown")
            : portOk(undefined),
        );
      },
      recordRateLimit: (_id, metadata) => {
        order.push("record");
        assert.equal(metadata.retryNotBefore, now + 180000);
        return Promise.resolve(
          mode === "persist-failure"
            ? portError("unavailable", "state fault")
            : portOk(undefined),
        );
      },
    };
    const provider = new GitHubInstallationTokenProvider({
      appId: 1,
      repository: { owner: "uos", name: "fixture", installationId: 42 },
      clock: { now: () => now },
      cooldownGate: gate,
      signer: {
        signJwt: () => {
          order.push("sign");
          return Promise.resolve(portOk("synthetic-jwt"));
        },
      },
      http: () => {
        order.push("http");
        return Promise.resolve({
          status: 429,
          headers: new Headers({ "retry-after": "180" }),
          bodyText: "sensitive synthetic diagnostic must not be echoed",
        });
      },
    });
    const result = await provider.authorizationHeader();
    assert.equal(result.ok, false);
    if (mode === "before-sign") assert.deepEqual(order, ["gate"]);
    if (mode === "after-sign") {
      assert.deepEqual(order, ["gate", "sign", "gate"]);
    }
    if (mode === "rate-response" || mode === "persist-failure") {
      assert.deepEqual(order, ["gate", "sign", "gate", "http", "record"]);
      if (!result.ok) {
        assert.equal(
          result.error.kind,
          mode === "persist-failure" ? "unavailable" : "rate_limited",
        );
        assert.equal(result.error.detail.includes("sensitive"), false);
        if (mode === "rate-response") {
          assert.equal(result.error.rateLimit?.retryNotBefore, now + 180000);
        }
      }
    }
  }
  console.log(
    "PASS 4 actual token-provider gate/sign/request/persistence cases",
  );
});
