// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-request JWT for the Coinbase Advanced Trade API
 * (https://docs.cdp.coinbase.com/ — REST authentication).
 *
 * Coinbase authenticates every request with a FRESH short-lived JWT (the JWT,
 * not the CDP key, is what expires — at 120s). The key never leaves the
 * collector; only the minted JWT travels on the wire as
 * `Authorization: Bearer <jwt>`.
 *
 * Pinned by the API contract:
 *   header  `{ typ: "JWT", alg, kid: <key id>, nonce: <random hex> }`
 *   payload `{ sub: <key id>, iss: "cdp", nbf: <epoch s>, exp: <nbf + 120>,
 *              uri: "<METHOD> <host><path>" }`  (uri has NO scheme)
 *
 * Two CDP key algorithms are supported:
 *   - ES256 — an EC P-256 ("prime256v1") private key, the Advanced-Trade
 *     default. The JWS signature must be the raw 64-byte r‖s concatenation
 *     (JOSE / IEEE-P1363), NOT the DER/ASN.1 form `crypto.sign` emits by
 *     default — hence `dsaEncoding: "ieee-p1363"`.
 *   - EdDSA — an Ed25519 private key (CDP's newer default). Ed25519 signs the
 *     message directly (no separate digest), so the algorithm argument to
 *     `crypto.sign` is `null` and it already returns the raw 64-byte signature.
 *
 * Signed via node:crypto only — no external JWT dependency.
 */

import { randomBytes, sign as cryptoSign, createPrivateKey } from "node:crypto";
import type { KeyObject } from "node:crypto";

/** JWT lifetime Coinbase expects: 120 seconds from `nbf`. */
export const COINBASE_JWT_TTL_SECONDS = 120;

/**
 * Clock-skew allowance: `nbf` is backdated by this much so a local clock
 * running slightly ahead of Coinbase's servers never mints an nbf-in-the-future
 * token (Coinbase would reject it, which for a routine clock skew would look
 * like an auth failure). `exp` stays relative to the real current time, so the
 * effective acceptance window is `[now − skew, now + 120]` and `exp − nbf`
 * stays at/below the 120s the API allows.
 */
export const COINBASE_JWT_NBF_BACKDATE_SECONDS = 5;

/** Supported JOSE `alg` values, keyed off the parsed private-key type. */
export type CoinbaseJwtAlg = "ES256" | "EdDSA";

export interface CoinbaseJwtRequest {
  /** Uppercase HTTP method, e.g. `"GET"`. */
  method: string;
  /** API host with no scheme, e.g. `"api.coinbase.com"`. */
  host: string;
  /** Request path beginning with `/`, e.g. `"/api/v3/brokerage/accounts"`. */
  path: string;
}

export interface CoinbaseJwtOptions {
  /**
   * CDP key id (key name). For Advanced-Trade keys this is the path-shaped
   * `organizations/{org_id}/apiKeys/{key_id}`. Becomes both the `kid` header
   * and the `sub` claim.
   */
  keyId: string;
  /**
   * The CDP private key, PEM. ES256 keys are an EC PEM; EdDSA keys are an
   * Ed25519 PEM. The key type is detected from the parsed key, so the caller
   * does not declare the algorithm.
   */
  privateKeyPem: string;
  /** The request the JWT authorizes (method/host/path). */
  request: CoinbaseJwtRequest;
  /** Current epoch seconds; `nbf` is this − skew, `exp` is this + 120. */
  nowEpochSeconds: number;
  /**
   * Override the per-JWT nonce. Defaults to fresh 16-byte hex. Injectable so
   * tests can assert a deterministic header; production never passes it.
   */
  nonce?: string;
}

function base64url(input: string | Buffer): string {
  return (typeof input === "string" ? Buffer.from(input, "utf-8") : input).toString("base64url");
}

/**
 * The JOSE URI claim: `"<METHOD> <host><path>"` — uppercase method, a single
 * space, host then path, and crucially NO scheme (Coinbase rejects a `https://`
 * prefix). Exported for the client to build the exact same string it requests.
 */
export function coinbaseJwtUri(req: CoinbaseJwtRequest): string {
  return `${req.method.toUpperCase()} ${req.host}${req.path}`;
}

/**
 * Map a parsed private key to its JOSE `alg`. Coinbase CDP keys are either
 * EC P-256 (→ ES256) or Ed25519 (→ EdDSA); anything else is unsupported and
 * throws rather than minting a token the API will reject.
 */
function algForKey(key: KeyObject): CoinbaseJwtAlg {
  if (key.asymmetricKeyType === "ec") {
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (curve && curve !== "prime256v1") {
      throw new Error(
        `Coinbase JWT: EC key uses curve "${curve}", but Coinbase ES256 requires P-256 (prime256v1)`,
      );
    }
    return "ES256";
  }
  if (key.asymmetricKeyType === "ed25519") {
    return "EdDSA";
  }
  throw new Error(
    `Coinbase JWT: unsupported key type "${key.asymmetricKeyType ?? "unknown"}" — supply an EC P-256 (ES256) or Ed25519 (EdDSA) CDP key`,
  );
}

/**
 * Parse the pasted CDP private key into a KeyObject, tolerant of how the key
 * actually arrives. The Coinbase key file delivers the PEM as a JSON string
 * with escaped newlines (a `BEGIN … PRIVATE KEY` block joined by literal `\n`),
 * and a user who copies that value lands here with literal `\n` (backslash-n)
 * sequences that `createPrivateKey` can't decode — surfacing as the opaque
 * `error:1E08010C:DECODER routines::unsupported`. A value that passed through
 * JSON twice arrives with `\\n` instead, so any run of backslashes before the
 * `n` counts: a PEM body is base64 and never holds one. Restore real newlines
 * (idempotent for an already multi-line PEM), strip surrounding quotes/space,
 * and on a genuinely unparseable key throw an actionable message instead of the
 * raw OpenSSL code.
 */
function parsePrivateKeyPem(raw: string): KeyObject {
  const pem = raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\+r\\+n/g, "\n")
    .replace(/\\+n/g, "\n")
    .trim();
  try {
    return createPrivateKey(pem);
  } catch (err) {
    throw new Error(
      "Coinbase: could not parse the API private key. Paste the CDP key's private key — the " +
        "full `BEGIN … PRIVATE KEY` … `END … PRIVATE KEY` block from the downloaded key file " +
        "(a CDP key from portal.cdp.coinbase.com, not a legacy API key).",
      { cause: err },
    );
  }
}

/**
 * Mint a per-request Coinbase JWT. Detects ES256 vs EdDSA from the key,
 * emits a JOSE-formatted (raw r‖s, never DER) signature for ES256, and returns
 * the compact `header.payload.signature` string ready for `Bearer`.
 */
export function signCoinbaseJwt(opts: CoinbaseJwtOptions): string {
  const key = parsePrivateKeyPem(opts.privateKeyPem);
  const alg = algForKey(key);

  const now = Math.floor(opts.nowEpochSeconds);
  const nonce = opts.nonce ?? randomBytes(16).toString("hex");

  const header = { typ: "JWT", alg, kid: opts.keyId, nonce };
  const payload = {
    sub: opts.keyId,
    iss: "cdp",
    nbf: now - COINBASE_JWT_NBF_BACKDATE_SECONDS,
    exp: now + COINBASE_JWT_TTL_SECONDS,
    uri: coinbaseJwtUri(opts.request),
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const data = Buffer.from(signingInput, "utf-8");

  // ES256 → SHA-256 digest with the JOSE raw-(r‖s) encoding; EdDSA → the
  // algorithm is null (Ed25519 signs the message itself) and already raw.
  const signature =
    alg === "ES256"
      ? cryptoSign("sha256", data, { key, dsaEncoding: "ieee-p1363" })
      : cryptoSign(null, data, key);

  return `${signingInput}.${base64url(signature)}`;
}
