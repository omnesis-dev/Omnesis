// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { constants, createPublicKey, verify, type JsonWebKey, type KeyObject } from "node:crypto";

import {
  defaultPublicFetchDependencies,
  fetchPublicJson,
  type PublicFetchDependencies,
} from "./public-json-fetch.js";
import type { VerifiedClientAssertion } from "./types.js";

/** RFC 7523 §2.2: the `client_assertion_type` for a JWT client assertion. */
export const JWT_BEARER_CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/** Asymmetric JWS algorithms a client may sign its assertion with. */
export const SUPPORTED_CLIENT_ASSERTION_ALGORITHMS = ["RS256", "PS256", "ES256"] as const;
type AssertionAlgorithm = (typeof SUPPORTED_CLIENT_ASSERTION_ALGORITHMS)[number];

const MAX_ASSERTION_LENGTH = 8 * 1_024;
const MAX_JWKS_BYTES = 16 * 1_024;
const MAX_JWKS_KEYS = 16;
const MAX_JWKS_CACHE_ENTRIES = 256;
/** Tolerated clock difference between the client and the gateway. */
const CLOCK_SKEW_SECONDS = 60;
/** An assertion is a one-request credential; one valid for longer is refused. */
const MAX_ASSERTION_LIFETIME_SECONDS = 5 * 60;
/** How soon an unknown `kid` may trigger another fetch of the same key set. */
const MIN_JWKS_REFETCH_INTERVAL_MS = 30_000;
const MAX_REPLAY_ENTRIES = 10_000;
const MIN_RSA_MODULUS_BITS = 2_048;

export class ClientAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientAssertionError";
  }
}

export interface ClientAssertionExpectation {
  clientId: string;
  jwksUri: string;
  /** Values `aud` may carry: the issuer and the endpoint URLs that identify this server. */
  audiences: readonly string[];
}

interface JwksCacheEntry {
  keys: JsonWebKey[];
  expiresAt: number;
  fetchedAt: number;
}

/**
 * Verifies RFC 7523 client assertions for `private_key_jwt` clients.
 *
 * Key sets are fetched behind the same SSRF boundary as metadata documents,
 * cached for as long as the publisher allows (at most five minutes), and
 * refetched once when an assertion names a key the cached set lacks — which is
 * how a client's key rotation is picked up — but no more often than every
 * thirty seconds per key set, so a stream of bogus key ids cannot turn every
 * request into an outbound fetch.
 *
 * Each `jti` is accepted once until its assertion expires. The replay cache is
 * in memory and bounded: the gateway is a single process, and an entry is only
 * written after the signature verifies, so only a holder of the client's
 * private key can fill it. At the bound the oldest entry is evicted; since
 * every assertion lives at most five minutes, that entry is close to expiring.
 */
export class ClientAssertionVerifier {
  private readonly jwksCache = new Map<string, JwksCacheEntry>();
  private readonly inFlight = new Map<string, Promise<JwksCacheEntry>>();
  private readonly seenJtis = new Map<string, number>();

  constructor(
    private readonly dependencies: PublicFetchDependencies = defaultPublicFetchDependencies,
  ) {}

  async verify(
    assertion: string,
    expected: ClientAssertionExpectation,
  ): Promise<VerifiedClientAssertion> {
    const parsed = parseCompactJws(assertion);
    const { header, claims } = parsed;
    const nowMs = this.dependencies.now();
    const now = Math.floor(nowMs / 1_000);
    checkClaims(claims, expected, now);

    let entry = await this.keySet(expected.jwksUri, false);
    let key = selectKey(entry.keys, header);
    if (!key && nowMs - entry.fetchedAt >= MIN_JWKS_REFETCH_INTERVAL_MS) {
      entry = await this.keySet(expected.jwksUri, true);
      key = selectKey(entry.keys, header);
    }
    if (!key)
      throw new ClientAssertionError("No key in the client's key set matches the assertion.");
    if (!signatureVerifies(header.alg, key, parsed.signingInput, parsed.signature)) {
      throw new ClientAssertionError("Client assertion signature is invalid.");
    }

    this.recordJti(expected.clientId, claims.jti as string, claims.exp as number, now);
    return { method: "private_key_jwt", clientId: expected.clientId, jwksUri: expected.jwksUri };
  }

  private async keySet(jwksUri: string, forceRefresh: boolean): Promise<JwksCacheEntry> {
    const cached = this.jwksCache.get(jwksUri);
    if (!forceRefresh && cached && cached.expiresAt > this.dependencies.now()) return cached;
    const pending = this.inFlight.get(jwksUri);
    if (pending) return pending;
    const fetching = this.fetchKeySet(jwksUri).finally(() => this.inFlight.delete(jwksUri));
    this.inFlight.set(jwksUri, fetching);
    return fetching;
  }

  private async fetchKeySet(jwksUri: string): Promise<JwksCacheEntry> {
    const document = await fetchPublicJson(new URL(jwksUri), this.dependencies, {
      label: "Client JWKS",
      maxBytes: MAX_JWKS_BYTES,
    });
    const value = document.value;
    if (
      typeof value !== "object" ||
      value === null ||
      !Array.isArray((value as { keys?: unknown }).keys)
    ) {
      throw new ClientAssertionError("Client JWKS is not a key set.");
    }
    const keys = ((value as { keys: unknown[] }).keys as unknown[])
      .filter((key): key is JsonWebKey => typeof key === "object" && key !== null)
      .slice(0, MAX_JWKS_KEYS);
    const fetchedAt = this.dependencies.now();
    // Always remembered, even with no cache lifetime, so the refetch interval
    // still applies to a publisher that forbids caching.
    const entry = { keys, fetchedAt, expiresAt: fetchedAt + document.cacheAgeMs };
    this.jwksCache.delete(jwksUri);
    if (this.jwksCache.size >= MAX_JWKS_CACHE_ENTRIES) {
      const oldest = this.jwksCache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.jwksCache.delete(oldest);
    }
    this.jwksCache.set(jwksUri, entry);
    return entry;
  }

  private recordJti(clientId: string, jti: string, exp: number, now: number): void {
    for (const [seen, expiresAt] of this.seenJtis) {
      if (expiresAt >= now) break;
      this.seenJtis.delete(seen);
    }
    const replayKey = `${clientId}\u0000${jti}`;
    const seenUntil = this.seenJtis.get(replayKey);
    if (seenUntil !== undefined && seenUntil >= now) {
      throw new ClientAssertionError("Client assertion jti was already used.");
    }
    if (this.seenJtis.size >= MAX_REPLAY_ENTRIES) {
      const oldest = this.seenJtis.keys().next().value as string | undefined;
      if (oldest !== undefined) this.seenJtis.delete(oldest);
    }
    this.seenJtis.set(replayKey, exp + CLOCK_SKEW_SECONDS);
  }
}

/**
 * The `sub` an assertion claims, read without verifying it. Only used to name
 * the client whose registration — and so whose key set — verifies the
 * assertion; every claim is checked again after the signature is.
 */
export function unverifiedAssertionSubject(assertion: string): string | null {
  try {
    const { claims } = parseCompactJws(assertion);
    return typeof claims.sub === "string" && claims.sub.length > 0 ? claims.sub : null;
  } catch {
    return null;
  }
}

interface ParsedJws {
  header: { alg: AssertionAlgorithm; kid?: string };
  claims: Record<string, unknown>;
  signingInput: Buffer;
  signature: Buffer;
}

function parseCompactJws(assertion: string): ParsedJws {
  if (assertion.length > MAX_ASSERTION_LENGTH) {
    throw new ClientAssertionError("Client assertion is too large.");
  }
  const parts = assertion.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))) {
    throw new ClientAssertionError("Client assertion is not a compact JWS.");
  }
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  const header = decodeJsonObject(encodedHeader);
  const claims = decodeJsonObject(encodedClaims);
  if (!header || !claims) throw new ClientAssertionError("Client assertion is not a compact JWS.");
  if (
    typeof header.alg !== "string" ||
    !(SUPPORTED_CLIENT_ASSERTION_ALGORITHMS as readonly string[]).includes(header.alg)
  ) {
    throw new ClientAssertionError("Client assertion algorithm is not supported.");
  }
  if (header.crit !== undefined) {
    throw new ClientAssertionError("Client assertion carries unsupported critical headers.");
  }
  if (header.kid !== undefined && typeof header.kid !== "string") {
    throw new ClientAssertionError("Client assertion key id is invalid.");
  }
  return {
    header: {
      alg: header.alg as AssertionAlgorithm,
      ...(header.kid !== undefined ? { kid: header.kid as string } : {}),
    },
    claims,
    signingInput: Buffer.from(`${encodedHeader}.${encodedClaims}`, "ascii"),
    signature: Buffer.from(encodedSignature, "base64url"),
  };
}

function decodeJsonObject(encoded: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function checkClaims(
  claims: Record<string, unknown>,
  expected: ClientAssertionExpectation,
  now: number,
): void {
  if (claims.iss !== expected.clientId || claims.sub !== expected.clientId) {
    throw new ClientAssertionError("Client assertion issuer and subject must be the client.");
  }
  const audiences =
    typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
  if (!audiences.some((aud) => typeof aud === "string" && expected.audiences.includes(aud))) {
    throw new ClientAssertionError("Client assertion audience does not name this server.");
  }
  if (!isNumericDate(claims.exp)) {
    throw new ClientAssertionError("Client assertion has no expiry.");
  }
  if (claims.exp <= now - CLOCK_SKEW_SECONDS) {
    throw new ClientAssertionError("Client assertion has expired.");
  }
  if (claims.exp > now + MAX_ASSERTION_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS) {
    throw new ClientAssertionError("Client assertion lifetime is too long.");
  }
  if (claims.iat !== undefined) {
    if (!isNumericDate(claims.iat) || claims.iat > now + CLOCK_SKEW_SECONDS) {
      throw new ClientAssertionError("Client assertion issue time is invalid.");
    }
    if (claims.exp - claims.iat > MAX_ASSERTION_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS) {
      throw new ClientAssertionError("Client assertion lifetime is too long.");
    }
  }
  if (
    claims.nbf !== undefined &&
    (!isNumericDate(claims.nbf) || claims.nbf > now + CLOCK_SKEW_SECONDS)
  ) {
    throw new ClientAssertionError("Client assertion is not yet valid.");
  }
  if (typeof claims.jti !== "string" || claims.jti.length === 0 || claims.jti.length > 256) {
    throw new ClientAssertionError("Client assertion needs a jti.");
  }
}

function isNumericDate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The key the header names by `kid`, or the set's only usable key when the
 * header names none. A key must be a public signing key of the algorithm's
 * type, and must not declare a different algorithm or a non-signing use.
 */
function selectKey(keys: readonly JsonWebKey[], header: ParsedJws["header"]): KeyObject | null {
  const usable = keys.filter((key) => keyAcceptsAlgorithm(key, header.alg));
  const candidates =
    header.kid !== undefined
      ? usable.filter((key) => (key as { kid?: unknown }).kid === header.kid)
      : usable;
  if (candidates.length !== 1) return null;
  const jwk = candidates[0]!;
  try {
    const key = createPublicKey({ key: publicMembers(jwk), format: "jwk" });
    if (
      key.asymmetricKeyType === "rsa" &&
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_MODULUS_BITS
    ) {
      return null;
    }
    return key;
  } catch {
    return null;
  }
}

function keyAcceptsAlgorithm(jwk: JsonWebKey, alg: AssertionAlgorithm): boolean {
  const declared = jwk as { alg?: unknown; use?: unknown; key_ops?: unknown };
  if (declared.alg !== undefined && declared.alg !== alg) return false;
  if (declared.use !== undefined && declared.use !== "sig") return false;
  if (
    declared.key_ops !== undefined &&
    !(Array.isArray(declared.key_ops) && declared.key_ops.includes("verify"))
  ) {
    return false;
  }
  if (alg === "ES256") return jwk.kty === "EC" && jwk.crv === "P-256";
  return jwk.kty === "RSA";
}

/** Only the public members, so a key set that leaks private material still yields a public key. */
function publicMembers(jwk: JsonWebKey): JsonWebKey {
  return jwk.kty === "EC"
    ? { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y }
    : { kty: "RSA", n: jwk.n, e: jwk.e };
}

function signatureVerifies(
  alg: AssertionAlgorithm,
  key: KeyObject,
  signingInput: Buffer,
  signature: Buffer,
): boolean {
  try {
    switch (alg) {
      case "RS256":
        return verify("sha256", signingInput, key, signature);
      case "PS256":
        return verify(
          "sha256",
          signingInput,
          {
            key,
            padding: constants.RSA_PKCS1_PSS_PADDING,
            saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
          },
          signature,
        );
      case "ES256":
        return (
          signature.byteLength === 64 &&
          verify("sha256", signingInput, { key, dsaEncoding: "ieee-p1363" }, signature)
        );
    }
  } catch {
    return false;
  }
}
