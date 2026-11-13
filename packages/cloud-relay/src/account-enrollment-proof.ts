// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { SignJWT, jwtVerify, type JWTVerifyGetKey, type JWK } from "jose";
import { z } from "zod";
import { bindingOrigin } from "./gateway-binding.js";
import type { Identity } from "./identity.js";

const scopeSchema = z
  .object({
    accountId: z.string().regex(/^[a-f0-9]{64}$/),
    gatewayId: z.string().uuid(),
    ownerAccountId: z.string().regex(/^[a-f0-9]{64}$/),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export type AccountEnrollmentScope = z.infer<typeof scopeSchema>;
const audience = "omnesis-gateway-account-enrollment-v3";
const linkAudience = "omnesis-gateway-account-link-v3";

/** A narrowly scoped account attestation cannot operate a tunnel or grant gateway device permissions. */
export class AccountEnrollmentAuthority {
  private readonly key: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly origin: string;
  readonly kid: string;
  constructor(origin: string, privateKey: KeyObject | string) {
    this.origin = bindingOrigin(origin).origin;
    this.key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
    if (this.key.type !== "private" || this.key.asymmetricKeyType !== "ed25519")
      throw new Error("Account authority requires an Ed25519 private key");
    this.publicKey = createPublicKey(this.key);
    this.kid = createHash("sha256")
      .update(this.publicKey.export({ format: "der", type: "spki" }))
      .digest("base64url");
  }

  jwks(): { keys: JWK[] } {
    return {
      keys: [
        { ...this.publicKey.export({ format: "jwk" }), kid: this.kid, alg: "EdDSA", use: "sig" },
      ],
    };
  }

  async issue(
    input: AccountEnrollmentScope,
    expiresAt = Math.floor(Date.now() / 1000) + 300,
  ): Promise<string> {
    return this.attest(input, expiresAt, false);
  }

  async issueGatewayLink(
    input: AccountEnrollmentScope,
    expiresAt = Math.floor(Date.now() / 1000) + 300,
  ): Promise<string> {
    return this.attest(input, expiresAt, true);
  }

  private async attest(
    input: AccountEnrollmentScope,
    expiresAt: number,
    linking: boolean,
  ): Promise<string> {
    const value = scopeSchema.parse(input),
      now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 300)
      throw new Error("Invalid enrollment proof lifetime");
    return new SignJWT({
      purpose: linking ? "gateway-account-link-v3" : "account-enrollment-v3",
      gatewayId: value.gatewayId,
      ownerAccountId: value.ownerAccountId,
      nonce: value.nonce,
    })
      .setProtectedHeader({ alg: "EdDSA", kid: this.kid })
      .setIssuer(this.origin)
      .setAudience(linking ? linkAudience : audience)
      .setSubject(value.accountId)
      .setIssuedAt(now)
      .setExpirationTime(expiresAt)
      .sign(this.key);
  }
}

/** Keys come from the configured relay authority, never a URL or embedded key named by the token. */
export class AccountEnrollmentVerifier {
  private readonly origin: string;
  constructor(
    origin: string,
    private readonly keys: JWTVerifyGetKey,
    private readonly gatewayId: string,
    private readonly ownerAccountId: string,
    private readonly accountId: string,
  ) {
    this.origin = bindingOrigin(origin).origin;
    scopeSchema.omit({ nonce: true }).parse({ gatewayId, ownerAccountId, accountId });
  }

  async verify(token: string, nonce?: string): Promise<Identity> {
    const identity = await verifyAttestation(
      this.origin,
      this.keys,
      this.gatewayId,
      this.ownerAccountId,
      token,
      nonce,
      false,
    );
    if (identity.subject !== this.accountId)
      throw new Error("Account enrollment proof does not match this gateway and pairing request");
    return identity;
  }
}

/** Linking attests the account chosen by the user without making that proof usable for device enrollment. */
export class AccountGatewayLinkVerifier {
  private readonly origin: string;
  constructor(
    origin: string,
    private readonly keys: JWTVerifyGetKey,
    private readonly gatewayId: string,
    private readonly ownerAccountId: string,
  ) {
    this.origin = bindingOrigin(origin).origin;
    scopeSchema
      .pick({ gatewayId: true, ownerAccountId: true })
      .parse({ gatewayId, ownerAccountId });
  }
  verify(token: string, nonce: string): Promise<Identity> {
    return verifyAttestation(
      this.origin,
      this.keys,
      this.gatewayId,
      this.ownerAccountId,
      token,
      nonce,
      true,
    );
  }
}

async function verifyAttestation(
  origin: string,
  keys: JWTVerifyGetKey,
  gatewayId: string,
  ownerAccountId: string,
  token: string,
  nonce: string | undefined,
  linking: boolean,
): Promise<Identity> {
  const { payload } = await jwtVerify(token, keys, {
    algorithms: ["EdDSA"],
    issuer: origin,
    audience: linking ? linkAudience : audience,
    requiredClaims: ["sub", "iat", "exp", "nonce", "gatewayId", "ownerAccountId"],
  });
  const claims = z
    .object({
      purpose: z.literal(linking ? "gateway-account-link-v3" : "account-enrollment-v3"),
      sub: scopeSchema.shape.accountId,
      gatewayId: z.string(),
      ownerAccountId: z.string(),
      nonce: z.string(),
      iat: z.number().int().nonnegative(),
      exp: z.number().int().positive(),
    })
    .parse(payload);
  const now = Math.floor(Date.now() / 1000);
  if (
    nonce === undefined ||
    claims.nonce !== nonce ||
    claims.gatewayId !== gatewayId ||
    claims.ownerAccountId !== ownerAccountId ||
    claims.exp > claims.iat + 300 ||
    claims.iat > now + 30
  )
    throw new Error("Account enrollment proof does not match this gateway and pairing request");
  return { issuer: `${origin}/_relay/account`, subject: claims.sub, expiresAt: claims.exp };
}
