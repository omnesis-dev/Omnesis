// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { relayOrigin } from "./network.js";

export interface Identity {
  issuer: string;
  subject: string;
  expiresAt: number;
}

/** Providers establish identity only. They never mint gateway grants. */
export interface IdentityProvider {
  verify(token: string, nonce?: string): Promise<Identity>;
}

const identityClaims = z.object({
  iss: z.string().min(1).max(512),
  sub: z.string().min(1).max(255),
  exp: z.number().int().positive(),
});

export function googleIdentityProvider(
  audience: string | readonly string[],
  keys: JWTVerifyGetKey = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs")),
  options: { authorizedParties?: readonly string[] } = {},
): IdentityProvider {
  const audiences = typeof audience === "string" ? [audience] : [...audience];
  if (!audiences.length || audiences.length > 16 || audiences.some((value) => !value.trim()))
    throw new Error("A Google client ID is required");
  const authorizedParties = [...(options.authorizedParties ?? audiences)];
  if (
    !authorizedParties.length ||
    authorizedParties.length > 16 ||
    authorizedParties.some((value) => !value.trim())
  )
    throw new Error("Trusted Google authorized party client IDs are required");
  return {
    async verify(token, nonce) {
      const { payload } = await jwtVerify(token, keys, {
        algorithms: ["RS256"],
        issuer: ["accounts.google.com", "https://accounts.google.com"],
        audience: audiences,
        maxTokenAge: "1h",
        requiredClaims: ["iss", "sub", "exp", "iat"],
      });
      const claims = identityClaims.parse(payload);
      if (
        payload.azp !== undefined &&
        (typeof payload.azp !== "string" || !authorizedParties.includes(payload.azp))
      )
        throw new Error("Untrusted Google authorized party");
      if (nonce !== undefined && payload.nonce !== nonce)
        throw new Error("Identity nonce mismatch");
      // Both Google issuer spellings identify the same account.
      return { issuer: "https://accounts.google.com", subject: claims.sub, expiresAt: claims.exp };
    },
  };
}

/** Explicit, signed local-test identity; never usable by a public listener. */
export function localIdentityProvider(secret: Uint8Array, bind: string): IdentityProvider {
  if (bind !== "127.0.0.1" && bind !== "::1") {
    throw new Error("Mock identity requires a loopback listener");
  }
  requireSecret(secret);
  return {
    async verify(token, nonce) {
      const { payload } = await jwtVerify(token, secret, {
        algorithms: ["HS256"],
        issuer: "omnesis-local-test",
        audience: "omnesis-cloud-relay",
        requiredClaims: ["sub", "exp", "iat"],
      });
      const claims = identityClaims.parse(payload);
      if (nonce !== undefined && payload.nonce !== nonce)
        throw new Error("Identity nonce mismatch");
      return { issuer: claims.iss, subject: claims.sub, expiresAt: claims.exp };
    },
  };
}

export function requireSecret(secret: Uint8Array): void {
  if (secret.length < 32) throw new Error("Relay signing keys require at least 32 bytes");
}

export function accountId(identity: Identity): string {
  return createHash("sha256")
    .update(JSON.stringify([identity.issuer, identity.subject]))
    .digest("hex");
}

/** Short-lived relay-only credentials, distinct from gateway Authorization. */
export class RelaySessions {
  constructor(
    private readonly secret: Uint8Array,
    private readonly ttlSeconds = 3600,
  ) {
    requireSecret(secret);
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 3600) {
      throw new Error("Session lifetime must be between 1 and 3600 seconds");
    }
  }

  async issue(
    identity: Identity,
  ): Promise<{ token: string; expiresAt: number; accountId: string }> {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = Math.min(identity.expiresAt, now + this.ttlSeconds);
    if (expiresAt <= now) throw new Error("Identity has expired");
    const id = accountId(identity);
    const token = await new SignJWT({ purpose: "relay-routing-v1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("omnesis-cloud-relay")
      .setAudience("omnesis-cloud-relay")
      .setSubject(id)
      .setIssuedAt(now)
      .setExpirationTime(expiresAt)
      .sign(this.secret);
    return { token, expiresAt, accountId: id };
  }

  async issueEnrollmentInvitation(
    gatewayId: string,
    origin: string,
    ttlSeconds = 3600,
  ): Promise<string> {
    const id = z.string().uuid().parse(gatewayId).toLowerCase();
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 3600)
      throw new Error("Enrollment invitation lifetime must be between 1 and 3600 seconds");
    return new SignJWT({
      purpose: "gateway-enrollment-v2",
      gatewayId: id,
      relayOrigin: relayOrigin(origin).origin,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("omnesis-cloud-relay")
      .setAudience("omnesis-gateway-enrollment-v2")
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.secret);
  }

  async verifyEnrollmentInvitation(
    token: string,
    gatewayId: string,
    origin: string,
  ): Promise<void> {
    const { payload } = await jwtVerify(token, this.secret, {
      algorithms: ["HS256"],
      issuer: "omnesis-cloud-relay",
      audience: "omnesis-gateway-enrollment-v2",
      maxTokenAge: "1h",
      requiredClaims: ["exp", "iat", "gatewayId", "relayOrigin", "purpose"],
    });
    const value = z
      .object({
        purpose: z.literal("gateway-enrollment-v2"),
        gatewayId: z.string().uuid(),
        relayOrigin: z.string(),
        exp: z.number().int().positive(),
        iat: z.number().int().nonnegative(),
      })
      .parse(payload);
    if (
      value.gatewayId !== z.string().uuid().parse(gatewayId).toLowerCase() ||
      value.relayOrigin !== relayOrigin(origin).origin ||
      value.exp > value.iat + 3600
    )
      throw new Error("Enrollment invitation does not match this gateway and relay");
  }

  async verify(token: string): Promise<{ accountId: string; expiresAt: number }> {
    const { payload } = await jwtVerify(token, this.secret, {
      algorithms: ["HS256"],
      issuer: "omnesis-cloud-relay",
      audience: "omnesis-cloud-relay",
      requiredClaims: ["sub", "exp", "iat"],
    });
    const claims = z
      .object({
        sub: z.string().regex(/^[a-f0-9]{64}$/),
        exp: z.number().int().positive(),
        purpose: z.literal("relay-routing-v1"),
      })
      .parse(payload);
    return { accountId: claims.sub, expiresAt: claims.exp };
  }
}
