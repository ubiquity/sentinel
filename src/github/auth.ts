/**
 * GitHub App installation-token access.
 *
 * Trusted constructor injection only: the caller supplies the App identity
 * (app id + installation id) and a signing capability — either a WebCrypto
 * RS256 JWT signer built from a private key PEM (`createWebCryptoJwtSigner`)
 * or an injected signer (`createInjectedJwtSigner`). No environment variable
 * default exists in this module; no key material is read from process
 * environment, files, fixtures or logs.
 *
 * The provider mints a short-lived JWT (GitHub App authentication), exchanges
 * it at the exact installation access-token endpoint
 * (`POST /app/installations/{installation_id}/access_tokens`), caches the
 * installation token until shortly before its expiry and refreshes
 * clock-aware on demand. The only value that ever leaves the provider is the
 * `Authorization` header for GitHub API requests; the raw token and the
 * private key never appear in errors, logs, URLs or returned values.
 *
 * Failures are sanitized typed port errors: no response body, URL, header
 * value, token or key material is ever echoed.
 */

import type { GitHubRateLimitV1 } from "../contracts/github-cooldown.ts";
import type {
  Clock,
  GitHubCooldownGateV1,
  PortResultV1,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import {
  expectPositiveInt,
  expectRecord,
  expectString,
  fail,
  MaxText,
  tryParse,
} from "../contracts/validation.ts";
import type { HttpTransportV1 } from "./http.ts";
import { createDeadline } from "./http.ts";
import { classifyGitHubRateLimit } from "./rate-limit.ts";

/** Finite default bound on one JWT signing operation (hangs cannot block). */
export const DEFAULT_SIGN_DEADLINE_MS = 15_000;

// ---------------------------------------------------------------------------
// JWT signing
// ---------------------------------------------------------------------------

export interface JwtClaimsV1 {
  /** Issued-at epoch seconds. */
  iat: number;
  /** Expiry epoch seconds; strictly greater than iat. */
  exp: number;
  /** GitHub App id as a decimal string (`iss` claim). */
  iss: string;
}

/**
 * RS256 JWT signing capability. Production uses the WebCrypto implementation
 * over the App private key PEM; tests inject a synthetic signer and never
 * touch a real key.
 */
export interface JwtSignerV1 {
  signJwt(claims: JwtClaimsV1): Promise<PortResultV1<string>>;
}

export function createInjectedJwtSigner(
  sign: (claims: JwtClaimsV1) => Promise<string>,
  label = "injected signer",
): JwtSignerV1 {
  return {
    async signJwt(claims: JwtClaimsV1): Promise<PortResultV1<string>> {
      try {
        if (!Number.isSafeInteger(claims.iat) || claims.iat < 0) {
          return portError("invalid", "invalid jwt claims");
        }
        if (!Number.isSafeInteger(claims.exp) || claims.exp <= claims.iat) {
          return portError("invalid", "invalid jwt claims");
        }
        const signed = await sign(claims);
        if (
          typeof signed !== "string" || signed.length === 0 ||
          signed.includes("\n") || signed.includes("\r")
        ) {
          return portError("invalid", "signer returned a malformed token");
        }
        return portOk(signed);
      } catch {
        // The signer's own implementation detail is never propagated: no
        // path, no key material, no raw message.
        return portError("unavailable", `${label} failed`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// PEM / DER helpers (WebCrypto path)
// ---------------------------------------------------------------------------

const PEM_LABEL_RE =
  /^-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----\s*$/;

function decodePem(pem: string): { label: string; der: Uint8Array } | null {
  const match = PEM_LABEL_RE.exec(pem);
  if (match === null) return null;
  const base64 = match[2].replace(/[^A-Za-z0-9+/=]/g, "");
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return null;
  }
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  if (der.length === 0) return null;
  return { label: match[1], der };
}

/**
 * Read one DER TLV at `offset`: returns the tag, the content byte range and
 * the offset of the next element. Malformed input returns null.
 */
export function readTlv(
  bytes: Uint8Array,
  offset: number,
): {
  tag: number;
  contentStart: number;
  contentEnd: number;
  next: number;
} | null {
  if (offset + 2 > bytes.length) return null;
  const tag = bytes[offset];
  const lengthByte = bytes[offset + 1];
  if ((lengthByte & 0x80) === 0) {
    const length = lengthByte;
    const contentStart = offset + 2;
    if (contentStart + length > bytes.length) return null;
    return {
      tag,
      contentStart,
      contentEnd: contentStart + length,
      next: contentStart + length,
    };
  }
  const width = lengthByte & 0x7f;
  if (width === 0 || width > 4 || offset + 2 + width > bytes.length) {
    return null;
  }
  let length = 0;
  for (let i = 0; i < width; i++) length = length * 256 + bytes[offset + 2 + i];
  if (length < 128) return null; // non-canonical long form
  const contentStart = offset + 2 + width;
  if (contentStart + length > bytes.length) return null;
  return {
    tag,
    contentStart,
    contentEnd: contentStart + length,
    next: contentStart + length,
  };
}

function encodeLength(length: number): Uint8Array {
  if (length < 128) return Uint8Array.of(length);
  const bytes: number[] = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value = Math.floor(value / 256);
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function encodeTlv(tag: number, content: Uint8Array): Uint8Array {
  const length = encodeLength(content.length);
  const out = new Uint8Array(1 + length.length + content.length);
  out[0] = tag;
  out.set(length, 1);
  out.set(content, 1 + length.length);
  return out;
}

/** PKCS#1 `RSAPrivateKey` -> PKCS#8 `PrivateKeyInfo` (rsaEncryption). */
export function pkcs1ToPkcs8Der(pkcs1: Uint8Array): Uint8Array | null {
  const root = readTlv(pkcs1, 0);
  if (root === null || root.tag !== 0x30 || root.next !== pkcs1.length) {
    return null;
  }
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const algId = Uint8Array.from([
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00,
  ]);
  const body = new Uint8Array([
    ...version,
    ...algId,
    ...encodeTlv(0x04, pkcs1),
  ]);
  return encodeTlv(0x30, body);
}

/**
 * Extract the PKCS#1 `RSAPrivateKey` DER from inside a PKCS#8
 * `PrivateKeyInfo`. Used by tests to prove the wrap round-trips exactly and
 * by the production signer path only as a normalized-input convenience.
 */
export function extractPkcs1DerFromPkcs8(pkcs8: Uint8Array): Uint8Array | null {
  const root = readTlv(pkcs8, 0);
  if (root === null || root.tag !== 0x30 || root.next !== pkcs8.length) {
    return null;
  }
  let offset = root.contentStart;
  const version = readTlv(pkcs8, offset);
  if (version === null || version.tag !== 0x02) return null;
  offset = version.next;
  const alg = readTlv(pkcs8, offset);
  if (alg === null || alg.tag !== 0x30) return null;
  offset = alg.next;
  const key = readTlv(pkcs8, offset);
  if (key === null || key.tag !== 0x04 || key.next !== root.contentEnd) {
    return null;
  }
  return pkcs8.slice(key.contentStart, key.contentEnd);
}

function isAsciiNonControl(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value);
}

/**
 * WebCrypto RS256 signer built from an App private key PEM. Supports both
 * PKCS#8 (`BEGIN PRIVATE KEY`) and PKCS#1 (`BEGIN RSA PRIVATE KEY`) — the
 * latter is wrapped into PKCS#8 because the WebCrypto import format for RSA
 * private keys is PKCS#8. `keyId` (optional) is a non-secret `kid` claim.
 *
 * The returned signer never reveals key material: failures are sanitized
 * typed port errors (no path, no PEM fragment, no raw WebCrypto message).
 */
export async function createWebCryptoJwtSigner(
  pem: string,
  keyId?: string,
): Promise<PortResultV1<JwtSignerV1>> {
  if (typeof pem !== "string" || pem.length === 0) {
    return portError("invalid", "missing private key");
  }
  if (pem.length > 65_536) {
    return portError("invalid", "private key too large");
  }
  const decoded = decodePem(pem);
  if (decoded === null) {
    return portError("invalid", "unsupported private key format");
  }
  let der: Uint8Array;
  if (decoded.label === "PRIVATE KEY") {
    der = decoded.der;
  } else if (decoded.label === "RSA PRIVATE KEY") {
    const wrapped = pkcs1ToPkcs8Der(decoded.der);
    if (wrapped === null) {
      return portError("invalid", "unsupported private key format");
    }
    der = wrapped;
  } else {
    return portError("invalid", "unsupported private key format");
  }
  let key: CryptoKey;
  try {
    // Re-copy to a fresh ArrayBuffer-backed view: WebCrypto's BufferSource
    // typing requires a non-shared buffer.
    const importable = new Uint8Array(der);
    key = await crypto.subtle.importKey(
      "pkcs8",
      importable,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    return portError("invalid", "private key could not be imported");
  }
  if (keyId !== undefined && !isAsciiNonControl(keyId)) {
    return portError("invalid", "invalid key id");
  }
  return portOk(
    createInjectedJwtSigner(async (claims) => {
      const header = {
        alg: "RS256",
        typ: "JWT",
        ...(keyId === undefined ? {} : { kid: keyId }),
      };
      const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${
        base64UrlEncode(JSON.stringify(claims))
      }`;
      const signature = await crypto.subtle.sign(
        { name: "RSASSA-PKCS1-v1_5" },
        key,
        new TextEncoder().encode(signingInput),
      );
      return `${signingInput}.${
        base64UrlEncodeBytes(new Uint8Array(signature))
      }`;
    }, "webcrypto jwt signer"),
  );
}

export function base64UrlEncode(text: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(text));
}

export function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/g,
    "",
  );
}

// ---------------------------------------------------------------------------
// Installation token provider
// ---------------------------------------------------------------------------

/** Exact installation access-token endpoint path (REST). */
export const INSTALLATION_ACCESS_TOKEN_PATH =
  "/app/installations/{installation_id}/access_tokens";

/** Default JWT lifetime: ten minutes (GitHub Apps standard practice). */
export const DEFAULT_JWT_LIFETIME_MS = 10 * 60_000;
/** Default JWT backdate: one minute of clock skew. */
export const DEFAULT_JWT_SKEW_MS = 60_000;
/** Default refresh margin: refresh 60s before the token expires. */
export const DEFAULT_REFRESH_SKEW_MS = 60_000;

export interface InstallationTokenOptionsV1 {
  /** GitHub App id (JWT `iss` claim). */
  appId: number;
  repository: RepositoryIdentityV1;
  /** REST API base (default `https://api.github.com`). */
  apiBaseUrl?: string;
  http: HttpTransportV1;
  clock: Clock;
  /**
   * Durable cooldown gate checked before any cached token, signing or token
   * HTTP. Required trusted capability: no permissive production default.
   */
  cooldownGate: GitHubCooldownGateV1;
  signer: JwtSignerV1;
  jwtLifetimeMs?: number;
  jwtSkewMs?: number;
  refreshSkewMs?: number;
  /** Finite bound on one signing operation (default 15s); a hung injected
   * signer cannot block the provider indefinitely. */
  signDeadlineMs?: number;
}

export interface InstallationTokenV1 {
  token: string;
  expiresAt: number;
}

/**
 * The authorization capability the REST client needs: the exact Authorization
 * header value for GitHub API requests. The raw installation token never
 * leaves the provider.
 */
export interface GitHubAuthProviderV1 {
  authorizationHeader(): Promise<PortResultV1<string>>;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const TOKEN_RE = /^[A-Za-z0-9_\-]{20,256}$/;

/**
 * One installation access token cache plus clock-aware refresh. The cache is
 * per-instance (one installation); expiry checks use the injected clock, so
 * tests control refresh deterministically. The token is never exposed: only
 * the Authorization header value leaves the instance.
 */
export class GitHubInstallationTokenProvider {
  private readonly apiBaseUrl: string;
  private readonly jwtLifetimeMs: number;
  private readonly jwtSkewMs: number;
  private readonly refreshSkewMs: number;
  private readonly signDeadlineMs: number;
  private cached: CachedToken | null = null;

  constructor(private readonly options: InstallationTokenOptionsV1) {
    if (!Number.isSafeInteger(options.appId) || options.appId < 1) {
      throw new TypeError("appId must be a positive integer");
    }
    expectPositiveInt(options.repository.installationId, "installationId");
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
    this.jwtLifetimeMs = options.jwtLifetimeMs ?? DEFAULT_JWT_LIFETIME_MS;
    this.jwtSkewMs = options.jwtSkewMs ?? DEFAULT_JWT_SKEW_MS;
    this.refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    this.signDeadlineMs = options.signDeadlineMs ?? DEFAULT_SIGN_DEADLINE_MS;
    if (!Number.isSafeInteger(this.signDeadlineMs) || this.signDeadlineMs < 1) {
      throw new TypeError("signDeadlineMs must be a positive integer");
    }
    if (
      !Number.isSafeInteger(this.jwtLifetimeMs) || this.jwtLifetimeMs < 60_000
    ) {
      throw new TypeError("jwtLifetimeMs must be at least 60 seconds");
    }
    if (!Number.isSafeInteger(this.jwtSkewMs) || this.jwtSkewMs < 0) {
      throw new TypeError("jwtSkewMs must be nonnegative");
    }
    if (this.jwtSkewMs >= this.jwtLifetimeMs) {
      throw new TypeError("jwtSkewMs must be below jwtLifetimeMs");
    }
    if (!Number.isSafeInteger(this.refreshSkewMs) || this.refreshSkewMs < 0) {
      throw new TypeError("refreshSkewMs must be nonnegative");
    }
  }

  /**
   * Return the exact `Authorization` header for GitHub API requests
   * (`Bearer <installation token>`). The raw token is never returned,
   * logged or embedded in an error.
   */
  async authorizationHeader(): Promise<PortResultV1<string>> {
    // The durable cooldown gate is checked before any cached-token
    // short-circuit, signing or token HTTP: a blocked installation never
    // reaches the network through this provider either.
    const gate = await this.checkGate();
    if (gate !== null) return gate;
    const now = this.options.clock.now();
    if (
      this.cached !== null &&
      now < this.cached.expiresAt - this.refreshSkewMs
    ) {
      return portOk(`Bearer ${this.cached.token}`);
    }
    const token = await this.fetchFreshInstallationToken(now);
    if (!token.ok) return token;
    // Only a successfully exchanged token is ever cached; a failure (rate
    // limit included) never poisons or refreshes the cache.
    this.cached = {
      token: token.value.token,
      expiresAt: token.value.expiresAt,
    };
    return portOk(`Bearer ${token.value.token}`);
  }

  /** Exposed for tests: the cached token expiry, never the raw value. */
  cachedExpiresAt(): number | null {
    return this.cached === null ? null : this.cached.expiresAt;
  }

  private async fetchFreshInstallationToken(
    now: number,
  ): Promise<PortResultV1<InstallationTokenV1>> {
    const iatSeconds = Math.floor((now - this.jwtSkewMs) / 1000);
    const lifetimeSeconds = Math.floor(this.jwtLifetimeMs / 1000);
    const deadline = createDeadline(this.signDeadlineMs);
    let signed: PortResultV1<string>;
    try {
      const signPromise = Promise.resolve().then(() =>
        this.options.signer.signJwt({
          iat: iatSeconds,
          exp: iatSeconds + lifetimeSeconds,
          iss: String(this.options.appId),
        })
      );
      // A signer that settles after the deadline must never surface as an
      // unhandled rejection.
      signPromise.catch(() => {});
      try {
        signed = await deadline.race(signPromise);
      } catch {
        return portError("unavailable", "jwt signing failed");
      }
    } finally {
      deadline.dispose();
    }
    if (!signed.ok) {
      // The signer's failure is sanitized: no signer-specific text, key path
      // or token material crosses this boundary.
      return portError(
        signed.error.kind === "invalid" ? "invalid" : "unavailable",
        "jwt signing failed",
      );
    }
    // The gate is re-checked immediately before the token HTTP: signing may
    // have taken long enough for the cooldown state to change, and a blocked
    // installation must never issue the token request.
    const gateAgain = await this.checkGate();
    if (gateAgain !== null) return gateAgain;
    const url = `${this.apiBaseUrl}${
      INSTALLATION_ACCESS_TOKEN_PATH.replace(
        "{installation_id}",
        String(this.options.repository.installationId),
      )
    }`;
    let response;
    try {
      response = await this.options.http({
        method: "POST",
        url,
        headers: authHeaders(`Bearer ${signed.value}`),
        body: "{}",
      });
    } catch {
      return portError("unavailable", "installation token request failed");
    }
    // Classify the response with the injected clock: a confirmed rate limit
    // is durably recorded before the typed error propagates, and the
    // observation is never encoded in a detail string. Generic 403 stays an
    // auth failure. A thrown classifier or failed recording is the sanitized
    // unavailable failure — nothing token-shaped ever escapes.
    let rateLimit: GitHubRateLimitV1 | null;
    try {
      rateLimit = await classifyGitHubRateLimit(
        response,
        this.options.clock.now(),
      );
    } catch {
      return portError("unavailable", "installation token request failed");
    }
    if (rateLimit !== null) {
      if (!(await this.recordRateLimit(rateLimit))) {
        return portError("unavailable", "installation token request failed");
      }
      return portError(
        "rate_limited",
        "installation token request rate limited",
        rateLimit,
      );
    }
    if (response.status === 200 || response.status === 201) {
      return parseAccessTokenResponse(
        response.bodyText,
        this.options.clock.now(),
      );
    }
    if (response.status === 401 || response.status === 403) {
      return portError(
        "auth_failed",
        "installation token request was rejected",
      );
    }
    if (response.status === 404) {
      return portError("not_found", "installation was not found");
    }
    if (response.status === 429) {
      return portError(
        "rate_limited",
        "installation token request rate limited",
      );
    }
    return portError("unavailable", "installation token request failed");
  }

  /**
   * Await the durable gate read, bounded by a fresh existing-duration sign
   * deadline: a hung gate cannot block the provider, and a gate that settles
   * late (after its bound fired) never leads to a request. A thrown gate is
   * the sanitized static unavailable failure. A blocked installation returns
   * the gate's own typed error, preserved.
   */
  private async checkGate(): Promise<PortResultV1<never> | null> {
    const deadline = createDeadline(this.signDeadlineMs);
    try {
      let result: PortResultV1<void>;
      try {
        const gatePromise = Promise.resolve().then(() =>
          this.options.cooldownGate.beforeRequest(
            this.options.repository.installationId,
          )
        );
        // A gate that settles after the deadline fired must never surface as
        // an unhandled rejection.
        gatePromise.catch(() => {});
        result = await deadline.race(gatePromise);
      } catch {
        return portError("unavailable", "installation token request failed");
      }
      if (deadline.fired()) {
        return portError("unavailable", "installation token request failed");
      }
      if (!result.ok) return { ok: false, error: result.error };
      return null;
    } finally {
      deadline.dispose();
    }
  }

  /**
   * Durably record an observed rate limit before any later token request.
   * Persistence is awaited to settlement directly — no sign deadline or
   * timer races it, so the observation cannot be abandoned. A
   * thrown/rejected gate or failed persistence is false (the caller
   * overrides with unavailable and no further request may start).
   */
  private async recordRateLimit(
    rateLimit: GitHubRateLimitV1,
  ): Promise<boolean> {
    try {
      return (await this.options.cooldownGate.recordRateLimit(
        this.options.repository.installationId,
        rateLimit,
      )).ok;
    } catch {
      return false;
    }
  }
}

function authHeaders(header: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  map.set("authorization", header);
  map.set("accept", "application/vnd.github+json");
  map.set("x-github-api-version", "2022-11-28");
  map.set("content-type", "application/json");
  return map;
}

function parseAccessTokenResponse(
  bodyText: string,
  now: number,
): PortResultV1<InstallationTokenV1> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return portError("invalid", "installation token response is malformed");
  }
  const checked = tryParse((value: unknown) => {
    const obj = expectRecord(value, "$");
    const token = expectString(obj.token, "$.token", MaxText.token);
    if (!TOKEN_RE.test(token)) {
      fail("$.token", "invalid_pattern", "expected an installation token");
    }
    const expiresAtText = obj.expires_at;
    if (typeof expiresAtText !== "string") {
      fail("$.expires_at", "wrong_type", "expected expiry timestamp");
    }
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(
        expiresAtText,
      )
    ) {
      fail("$.expires_at", "invalid_timestamp", "expected ISO-8601 expiry");
    }
    const expiresAt = Date.parse(expiresAtText);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
      fail("$.expires_at", "invalid_timestamp", "expected a future expiry");
    }
    return { token, expiresAt };
  }, parsed);
  if (!checked.ok) {
    return portError("invalid", "installation token response is malformed");
  }
  return portOk(checked.value);
}
