import assert from "node:assert/strict";
import { GitHubApiClient } from "../../src/github/client.ts";
import { GitHubInstallationTokenProvider } from "../../src/github/auth.ts";
import { portOk } from "../../src/contracts/ports.ts";

Deno.test("github rate-limit persistence settlement", async () => {
  let release!: () => void;
  let started!: () => void;
  let settled = false;
  const pending = new Promise<void>((resolve) => release = resolve);
  const recordStarted = new Promise<void>((resolve) => started = resolve);
  const client = new GitHubApiClient({
    repository: { owner: "uos", name: "fixture", installationId: 42 },
    apiBaseUrl: "https://api.github.com",
    clock: { now: () => 1786000000000 },
    requestDeadlineMs: 20,
    cooldownGate: {
      beforeRequest: () => Promise.resolve(portOk(undefined)),
      recordRateLimit: async () => {
        started();
        await pending;
        return portOk(undefined);
      },
    },
    auth: {
      authorizationHeader: () => Promise.resolve(portOk("Bearer synthetic")),
    },
    http: () =>
      Promise.resolve({
        status: 429,
        headers: new Headers({ "retry-after": "120" }),
        bodyText: "",
      }),
  });
  const operation = client.listOpenIssues().finally(() => settled = true);
  try {
    await Promise.race([
      recordStarted,
      operation.then(() => {
        throw new Error("client returned without recording the observed limit");
      }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(
      settled,
      false,
      "client returned while durable rate-limit persistence was unsettled",
    );
  } finally {
    release();
    await operation;
  }
  console.log("PASS rate-limit persistence settles before caller can continue");
  let authRelease!: () => void;
  let authStarted!: () => void;
  let authSettled = false;
  const authPending = new Promise<void>((resolve) => authRelease = resolve);
  const authRecording = new Promise<void>((resolve) => authStarted = resolve);
  const provider = new GitHubInstallationTokenProvider({
    appId: 1,
    repository: { owner: "uos", name: "fixture", installationId: 42 },
    clock: { now: () => 1786000000000 },
    signDeadlineMs: 20,
    cooldownGate: {
      beforeRequest: () => Promise.resolve(portOk(undefined)),
      recordRateLimit: async () => {
        authStarted();
        await authPending;
        return portOk(undefined);
      },
    },
    signer: { signJwt: () => Promise.resolve(portOk("synthetic-jwt")) },
    http: () =>
      Promise.resolve({
        status: 429,
        headers: new Headers({ "retry-after": "120" }),
        bodyText: "",
      }),
  });
  const authOperation = provider.authorizationHeader().finally(() =>
    authSettled = true
  );
  try {
    await Promise.race([
      authRecording,
      authOperation.then(() => {
        throw new Error("token provider returned without recording rate limit");
      }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(
      authSettled,
      false,
      "token provider returned while rate-limit persistence was unsettled",
    );
  } finally {
    authRelease();
    await authOperation;
  }
  console.log("PASS token-provider rate-limit persistence settlement");
});
