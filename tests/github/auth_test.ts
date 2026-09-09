// GitHub App token provider suite: WebCrypto RS256 signing (PKCS#8 and
// PKCS#1), injection sanitization, exact access-token endpoint use,
// clock-aware cache/refresh and sanitized failures that never leak the token
// or key material. All fixtures are synthetic.
import assert from "node:assert/strict";

import type { PortResultV1 } from "../../src/contracts/ports.ts";
import {
  createInjectedJwtSigner,
  createWebCryptoJwtSigner,
  extractPkcs1DerFromPkcs8,
  GitHubInstallationTokenProvider,
  pkcs1ToPkcs8Der,
} from "../../src/github/auth.ts";
import type { JwtClaimsV1 } from "../../src/github/auth.ts";
import {
  accessTokenWire,
  FakeClock,
  FakeCooldownGate,
  httpRespond,
  REPO,
  ScriptedHttpTransport,
  SyntheticJwtSigner,
  T0,
} from "./helpers.ts";

function pemOf(label: string, der: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...der));
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${
    lines.join("\n")
  }\n-----END ${label}-----`;
}

function generatedKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
}

async function verifyJwt(
  publicKey: CryptoKey,
  jwt: string,
): Promise<{ header: Record<string, unknown>; claims: JwtClaimsV1 }> {
  const parts = jwt.split(".");
  assert.equal(parts.length, 3);
  const signingInput = `${parts[0]}.${parts[1]}`;
  const signature = atob(parts[2].replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(signature.length);
  for (let i = 0; i < signature.length; i++) bytes[i] = signature.charCodeAt(i);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    bytes,
    new TextEncoder().encode(signingInput),
  );
  assert.equal(ok, true);
  const header = JSON.parse(
    atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")),
  ) as Record<string, unknown>;
  const claims = JSON.parse(
    atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
  ) as JwtClaimsV1;
  return { header, claims };
}

Deno.test("webcrypto signer: signs valid RS256 JWTs from a PKCS#8 PEM", async () => {
  const pair = await generatedKeyPair();
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const pem = pemOf("PRIVATE KEY", new Uint8Array(pkcs8));
  const created = await createWebCryptoJwtSigner(pem, "key-1");
  assert.ok(created.ok);
  if (!created.ok) return;
  const signed = await created.value.signJwt({
    iat: 1700000000,
    exp: 1700000600,
    iss: "12345",
  });
  assert.ok(signed.ok);
  if (!signed.ok) return;
  const verified = await verifyJwt(pair.publicKey, signed.value);
  assert.equal(verified.header.alg, "RS256");
  assert.equal(verified.header.kid, "key-1");
  assert.equal(verified.claims.iss, "12345");
  assert.equal(verified.claims.exp - verified.claims.iat, 600);
});

Deno.test("webcrypto signer: PKCS#1 PEM is wrapped into PKCS#8 and round-trips", async () => {
  const pair = await generatedKeyPair();
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  const pkcs1 = extractPkcs1DerFromPkcs8(pkcs8);
  assert.ok(pkcs1 !== null);
  const rewrapped = pkcs1ToPkcs8Der(pkcs1);
  assert.ok(rewrapped !== null);
  assert.deepEqual(rewrapped, pkcs8);
  const pem = pemOf("RSA PRIVATE KEY", pkcs1);
  const created = await createWebCryptoJwtSigner(pem);
  assert.ok(created.ok);
  if (!created.ok) return;
  const signed = await created.value.signJwt({
    iat: 1700000000,
    exp: 1700000600,
    iss: "12345",
  });
  assert.ok(signed.ok);
  if (!signed.ok) return;
  const verified = await verifyJwt(pair.publicKey, signed.value);
  assert.equal(verified.header.kid, undefined);
});

Deno.test("webcrypto signer: unsupported/private formats are rejected without content", async () => {
  const bad = await createWebCryptoJwtSigner("not a pem");
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.error.kind, "invalid");
  assert.ok(!bad.error.detail.includes("not a pem"));
  const ec = await createWebCryptoJwtSigner(
    pemOf("EC PRIVATE KEY", new Uint8Array([0x30, 0x03])),
  );
  assert.equal(ec.ok, false);
  if (ec.ok) return;
  assert.equal(ec.error.kind, "invalid");
});

Deno.test("injected signer: claims are validated and thrown errors sanitized", async () => {
  const throwing = createInjectedJwtSigner(() => {
    throw new Error("secret key path /home/host/key.pem");
  });
  const result = await throwing.signJwt({
    iat: 1700000000,
    exp: 1700000600,
    iss: "1",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "unavailable");
    assert.ok(!result.error.detail.includes("key.pem"));
  }
  const bad = await throwing.signJwt({ iat: -1, exp: 1700000600, iss: "1" });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.kind, "invalid");
});

function providerWith(
  transport: ScriptedHttpTransport,
  signer: SyntheticJwtSigner,
  clock: FakeClock,
  overrides: {
    appId?: number;
    jwtLifetimeMs?: number;
    refreshSkewMs?: number;
    jwtSkewMs?: number;
  } = {},
): GitHubInstallationTokenProvider {
  return new GitHubInstallationTokenProvider({
    appId: overrides.appId ?? 12345,
    repository: REPO,
    apiBaseUrl: "https://api.github.com",
    http: transport.fetch.bind(transport),
    clock,
    cooldownGate: new FakeCooldownGate(),
    signer: { signJwt: signer.signJwt.bind(signer) },
    jwtLifetimeMs: overrides.jwtLifetimeMs ?? 10 * 60_000,
    refreshSkewMs: overrides.refreshSkewMs ?? 60_000,
    jwtSkewMs: overrides.jwtSkewMs ?? 60_000,
  });
}

Deno.test("token provider: exchanges the exact endpoint and caches until refresh", async () => {
  const script = new ScriptedHttpTransport([
    httpRespond(
      "POST",
      "/app/installations/42/access_tokens",
      201,
      accessTokenWire(
        "ghs_synthetic_token_0001",
        new Date(T0 + 10 * 60_000).toISOString(),
      ),
    ),
  ]);
  const clock = new FakeClock(T0);
  const signer = new SyntheticJwtSigner("synthetic-signature-0000");
  const provider = providerWith(script, signer, clock);

  const first = await provider.authorizationHeader();
  assert.ok(first.ok);
  if (!first.ok) return;
  assert.equal(first.value, "Bearer ghs_synthetic_token_0001");
  assert.equal(signer.calls.length, 1);
  assert.equal(script.requests.length, 1);
  const request = script.requests[0];
  assert.equal(request.method, "POST");
  assert.equal(
    request.url,
    "https://api.github.com/app/installations/42/access_tokens",
  );
  assert.equal(request.body, "{}");
  const jwt = request.headers.get("authorization") ?? "";
  assert.ok(jwt.startsWith("Bearer "));
  const parts = jwt.slice("Bearer ".length).split(".");
  const header = JSON.parse(
    atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")),
  ) as Record<string, unknown>;
  assert.equal(header.alg, "RS256");
  const claims = JSON.parse(
    atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
  ) as JwtClaimsV1;
  const skewSeconds = Math.floor(60_000 / 1000);
  assert.equal(claims.iat, Math.floor(T0 / 1000) - skewSeconds);
  assert.equal(claims.exp - claims.iat, 600);
  assert.equal(claims.iss, "12345");

  // Cached: no second exchange while fresh.
  const second = await provider.authorizationHeader();
  assert.ok(second.ok);
  if (!second.ok) return;
  assert.equal(second.value, "Bearer ghs_synthetic_token_0001");
  assert.equal(script.requests.length, 1);
  assert.equal(signer.calls.length, 1);
});

Deno.test("token provider: clock-aware refresh just before expiry", async () => {
  const expiry = new Date(T0 + 120_000).toISOString();
  const script = new ScriptedHttpTransport([
    httpRespond(
      "POST",
      "/app/installations/42/access_tokens",
      201,
      accessTokenWire("ghs_synthetic_token_0001", expiry),
    ),
    httpRespond(
      "POST",
      "/app/installations/42/access_tokens",
      201,
      accessTokenWire("ghs_synthetic_token_0002", expiry),
    ),
  ]);
  const clock = new FakeClock(T0);
  const signer = new SyntheticJwtSigner("synthetic.jwt.0000");
  const provider = providerWith(script, signer, clock, {
    jwtLifetimeMs: 120_000,
    refreshSkewMs: 30_000,
    jwtSkewMs: 0,
  });
  const first = await provider.authorizationHeader();
  assert.ok(first.ok);
  if (!first.ok) return;
  // Fresh at T0+89s (expiry T0+120s minus 30s margin).
  clock.advance(89_000);
  const cached = await provider.authorizationHeader();
  assert.ok(cached.ok);
  if (!cached.ok) return;
  assert.equal(cached.value, "Bearer ghs_synthetic_token_0001");
  assert.equal(script.requests.length, 1);
  // At T0+91s the margin is gone: a new exchange happens.
  clock.advance(2_000);
  const refreshed = await provider.authorizationHeader();
  assert.ok(refreshed.ok);
  if (!refreshed.ok) return;
  assert.equal(refreshed.value, "Bearer ghs_synthetic_token_0002");
  assert.equal(script.requests.length, 2);
  assert.equal(signer.calls.length, 2);
});

Deno.test("token provider: sanitized failures never leak token or key material", async () => {
  const script = new ScriptedHttpTransport([
    httpRespond(
      "POST",
      "/app/installations/42/access_tokens",
      401,
      errorBody("Bad credentials"),
    ),
  ]);
  const clock = new FakeClock(T0);
  const signer = new SyntheticJwtSigner("synthetic-signature-0000");
  const provider = providerWith(script, signer, clock);
  const result = await provider.authorizationHeader();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "auth_failed");
  assert.ok(!result.error.detail.includes("synthetic-signature"));
  assert.ok(!result.error.detail.includes("synthetic"));
  assert.ok(!result.error.detail.includes("Bad credentials"));
  assert.equal(script.requests.length, 1);
});

Deno.test("token provider: malformed token response is invalid, expired is invalid", async () => {
  const malformed = new ScriptedHttpTransport([
    httpRespond("POST", "/app/installations/42/access_tokens", 201, {
      token: 42,
      expires_at: "2099-01-01T00:00:00Z",
    }),
  ]);
  const clock = new FakeClock(T0);
  const signer = new SyntheticJwtSigner();
  const provider = providerWith(malformed, signer, clock);
  const result = await provider.authorizationHeader();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "invalid");

  const expired = new ScriptedHttpTransport([
    httpRespond(
      "POST",
      "/app/installations/42/access_tokens",
      201,
      accessTokenWire("ghs_synthetic_token_0001", "2020-01-01T00:00:00Z"),
    ),
  ]);
  const provider2 = providerWith(
    expired,
    new SyntheticJwtSigner(),
    new FakeClock(T0),
  );
  const result2 = await provider2.authorizationHeader();
  assert.equal(result2.ok, false);
  if (result2.ok) return;
  assert.equal(result2.error.kind, "invalid");
});

Deno.test("token provider: network loss and signer failure map to sanitized unavailable", async () => {
  const script = new ScriptedHttpTransport([{
    kind: "throw",
    method: "POST",
    urlPart: "/access_tokens",
  }]);
  const provider = providerWith(
    script,
    new SyntheticJwtSigner(),
    new FakeClock(T0),
  );
  const result = await provider.authorizationHeader();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "unavailable");
  assert.ok(!result.error.detail.includes("connection loss"));

  const signerFail = new SyntheticJwtSigner("synthetic.jwt.0000", {
    kind: "unavailable",
    detail: "signing backend lost",
  });
  const provider2 = providerWith(
    new ScriptedHttpTransport(),
    signerFail,
    new FakeClock(T0),
  );
  const result2 = await provider2.authorizationHeader();
  assert.equal(result2.ok, false);
  if (result2.ok) return;
  assert.equal(result2.error.kind, "unavailable");
  assert.ok(!result2.error.detail.includes("lost"));
});

function errorBody(message: string): unknown {
  return { message, documentation_url: "https://docs.github.com/rest" };
}

// Compile-time guard: the provider satisfies the auth provider interface.
const _authProvider: GitHubInstallationTokenProvider = providerWith(
  new ScriptedHttpTransport(),
  new SyntheticJwtSigner(),
  new FakeClock(T0),
);
const _asAuth: PortResultV1<string> = await _authProvider.authorizationHeader();
