// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createPublicKey, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { bindingOrigin } from "./gateway-binding.js";
import { RelayError } from "./tunnels.js";

/**
 * An invite lets one person create one Omnesis account on a relay. Its operator signs it offline
 * with an Ed25519 key the relay never holds; the relay knows only the public half, so it can check
 * an invite but cannot make one. An invite is a JWS compact token:
 *
 *   base64url({"alg":"EdDSA","typ":"omnesis-invite"}) "." base64url(claims) "." base64url(signature)
 *
 * with claims `{ aud, jti, iat, exp }`: the relay origin it is for, a random 128-bit id, and when
 * it was issued and expires. The relay records the id when an account is created with it, so an
 * invite creates at most one account.
 */
export const INVITE_TYPE = "omnesis-invite";
/** Where an invite link opens on the relay. The token travels in the fragment, never to a server. */
export const INVITE_PAGE_PATH = "/invite";
/** Longest an invite may be valid for, so a forgotten link cannot stay usable for ever. */
export const MAX_INVITE_LIFETIME_SECONDS = 366 * 86_400;
/** How far ahead of the relay's clock an issuing machine's clock may run. */
const CLOCK_SKEW_SECONDS = 300;
const MAX_TOKEN_LENGTH = 1024;
const tokenPattern = /^[A-Za-z0-9_-]{1,200}\.[A-Za-z0-9_-]{1,700}\.[A-Za-z0-9_-]{86}$/;
const keyPattern = /^[A-Za-z0-9_-]{43}$/;
const inviteIdPattern = /^[A-Za-z0-9_-]{22}$/;
const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: INVITE_TYPE })).toString(
  "base64url",
);

const claimsSchema = z
  .object({
    aud: z.string().min(1).max(512),
    jti: z.string().regex(inviteIdPattern),
    iat: z.number().int().nonnegative().safe(),
    exp: z.number().int().positive().safe(),
  })
  .strict();

export type InviteRefusal = "invite-invalid" | "invite-expired" | "invite-used";
const refusalMessages: Record<InviteRefusal, string> = {
  "invite-invalid": "This invite isn't valid",
  "invite-expired": "This invite has expired",
  "invite-used": "This invite was already used",
};
/** The one word the response carries is the reason, so a gateway can say which it was. */
export class InviteRefused extends RelayError {
  constructor(readonly reason: InviteRefusal) {
    super(403, refusalMessages[reason], reason);
  }
}

/** An invite whose signature, audience and lifetime were checked. */
export interface VerifiedInvite {
  id: string;
  expiresAt: number;
}

/**
 * The token in what a person pasted: the whole link, the link's fragment, or the bare token.
 * Anything else is no invite at all.
 */
export function inviteToken(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed.length > MAX_TOKEN_LENGTH + 512) return undefined;
  const token = trimmed.slice(trimmed.lastIndexOf("#") + 1);
  return token.length <= MAX_TOKEN_LENGTH && tokenPattern.test(token) ? token : undefined;
}

/** Public keys are configured as unpadded base64url of the raw 32-byte Ed25519 key. */
export function invitePublicKey(value: string): KeyObject {
  if (!keyPattern.test(value)) throw new Error("Invalid invite public key");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: value }, format: "jwk" });
}

/** The raw public key, in the form `invitePublicKey` reads. */
export function invitePublicKeyValue(key: KeyObject): string {
  const { x } = key.export({ format: "jwk" });
  if (key.asymmetricKeyType !== "ed25519" || typeof x !== "string")
    throw new Error("Invite keys are Ed25519");
  return x;
}

/** Checks invites for one relay origin against any of its configured public keys. */
export class InviteVerifier {
  readonly origin: string;
  private readonly keys: readonly KeyObject[];
  constructor(origin: string, keys: readonly string[]) {
    if (keys.length === 0 || keys.length > 8)
      throw new Error("Invites need between one and eight public keys");
    this.origin = bindingOrigin(origin).origin;
    this.keys = keys.map(invitePublicKey);
  }

  /** Throws `InviteRefused`; whether the invite was already used is the caller's ledger to say. */
  verify(input: string, now = Math.floor(Date.now() / 1000)): VerifiedInvite {
    const token = inviteToken(input);
    if (!token) throw new InviteRefused("invite-invalid");
    const [encodedHeader, encodedClaims, encodedSignature] = token.split(".") as [
      string,
      string,
      string,
    ];
    const signature = Buffer.from(encodedSignature, "base64url");
    const signed = Buffer.from(`${encodedHeader}.${encodedClaims}`);
    if (encodedHeader !== header || !this.keys.some((key) => verify(null, signed, key, signature)))
      throw new InviteRefused("invite-invalid");
    let claims: z.infer<typeof claimsSchema>;
    try {
      claims = claimsSchema.parse(JSON.parse(Buffer.from(encodedClaims, "base64url").toString()));
    } catch {
      throw new InviteRefused("invite-invalid");
    }
    if (
      claims.aud !== this.origin ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > MAX_INVITE_LIFETIME_SECONDS ||
      claims.iat > now + CLOCK_SKEW_SECONDS
    )
      throw new InviteRefused("invite-invalid");
    if (claims.exp <= now) throw new InviteRefused("invite-expired");
    return { id: claims.jti, expiresAt: claims.exp };
  }
}

/**
 * Signs an invite. The operator's own tool does this offline; the relay never calls it. It lives
 * here so tests and test relays make invites in exactly the format the relay checks.
 */
export function signInvite(
  privateKey: KeyObject,
  options: { origin: string; expiresAt: number; issuedAt?: number; id?: string },
): string {
  const claims = {
    aud: bindingOrigin(options.origin).origin,
    jti: options.id ?? randomBytes(16).toString("base64url"),
    iat: options.issuedAt ?? Math.floor(Date.now() / 1000),
    exp: options.expiresAt,
  };
  const input = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
}

/** The link a person is sent: the relay's invite page with the token in its fragment. */
export function inviteLink(origin: string, token: string): string {
  return `${new URL(INVITE_PAGE_PATH, bindingOrigin(origin).origin).href}#${token}`;
}
