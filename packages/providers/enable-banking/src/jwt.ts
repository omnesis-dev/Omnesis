// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-request application JWT for the Enable Banking API
 * (https://enablebanking.com/docs/api/quick-start/).
 *
 * The claims are pinned by the API contract:
 *   header  `{ typ: "JWT", alg: "RS256", kid: <application_id> }`
 *   payload `{ iss: "enablebanking.com", aud: "api.enablebanking.com",
 *              iat: <epoch s, backdated 60s for clock skew>,
 *              exp: <epoch s> + 3600 }`
 *
 * Signed with the application's RSA private key (the PEM downloaded at app
 * registration) via node:crypto — no external JWT dependency.
 */

import { createSign } from "node:crypto";

/** Token lifetime Enable Banking expects: one hour from the current time. */
export const EB_JWT_TTL_SECONDS = 3600;

/**
 * Clock-skew allowance: `iat` is backdated by this much so a local clock
 * running slightly ahead of Enable Banking's servers never produces an
 * iat-in-the-future token (EB would 401 it, which would park the source in
 * sticky needs-auth for what is really clock skew). `exp` stays relative to
 * the real current time, and `exp - iat` stays far under EB's 86400s cap.
 */
export const EB_JWT_IAT_BACKDATE_SECONDS = 60;

export interface EnableBankingJwtOptions {
  /** Enable Banking application id — becomes the `kid` header. */
  applicationId: string;
  /** RSA private key, PEM (PKCS#8 or PKCS#1). */
  privateKeyPem: string;
  /** Current epoch seconds; `iat` is this − 60 (skew allowance), `exp` this + 3600. */
  nowEpochSeconds: number;
}

function base64url(input: string | Buffer): string {
  return (typeof input === "string" ? Buffer.from(input, "utf-8") : input).toString("base64url");
}

export function signEnableBankingJwt(opts: EnableBankingJwtOptions): string {
  const now = Math.floor(opts.nowEpochSeconds);
  const header = { typ: "JWT", alg: "RS256", kid: opts.applicationId };
  const payload = {
    iss: "enablebanking.com",
    aud: "api.enablebanking.com",
    iat: now - EB_JWT_IAT_BACKDATE_SECONDS,
    exp: now + EB_JWT_TTL_SECONDS,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(opts.privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}
