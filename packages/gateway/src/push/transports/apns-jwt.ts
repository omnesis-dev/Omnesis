// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * JWT signer for direct APNs token-based auth. Apple requires the JWT to be
 * ES256 (ECDSA P-256 / SHA-256) signed with the .p8 private key the
 * developer downloaded from "Keys" in the Apple Developer portal. The
 * signature must be in JWS "raw" form — concatenated 32-byte R || S,
 * not the ASN.1 DER blob that OpenSSL emits by default. Node 24's
 * `crypto.createSign({ dsaEncoding: "ieee-p1363" })` returns exactly
 * that shape, so no manual DER unwinding is required.
 *
 * The minted JWT is reusable for many requests inside the lifetime
 * window — Apple's docs say "less than one hour"; the client caches
 * for ~45 min to stay well clear of that ceiling.
 */

import { createSign } from "node:crypto";

export interface SignApnsJwtOptions {
  /** Contents of the .p8 file as a UTF-8 string (PEM with EC PRIVATE KEY block). */
  keyPem: string;
  /** Apple-issued 10-char key id (set as `kid` header claim). */
  keyId: string;
  /** Apple Developer team id (set as `iss` body claim). */
  teamId: string;
  /** Test-time injection point for `iat`. Defaults to floor(Date.now()/1000). */
  nowSeconds?: number;
}

/**
 * Build a signed APNs auth-token JWT. The output is the
 * `<base64-header>.<base64-claims>.<base64-signature>` tuple that
 * goes directly into the `authorization: bearer <jwt>` header on
 * every APNs request.
 */
export function signApnsJwt(opts: SignApnsJwtOptions): string {
  const iat = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: opts.keyId }));
  const claims = base64url(JSON.stringify({ iss: opts.teamId, iat }));
  const signingInput = `${header}.${claims}`;

  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const sigBuf = signer.sign({ key: opts.keyPem, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${base64urlBuffer(sigBuf)}`;
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlBuffer(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
