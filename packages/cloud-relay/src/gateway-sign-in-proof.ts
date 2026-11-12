// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { decodeJwt } from "jose";
import { z } from "zod";
import {
  googleProofNonce,
  passkeyEndorsementNonce,
  passkeyProofChallenge,
  signInProofSchema,
  type SignInProof,
} from "./device-enrollment.js";
import { bindingOrigin } from "./gateway-binding.js";
import { accountId, type IdentityProvider } from "./identity.js";

/** A proof older than this is refused even when its signature still verifies. */
export const SIGN_IN_PROOF_MAX_AGE_SECONDS = 600;
const FUTURE_TOLERANCE_SECONDS = 60;

/**
 * Where a pin came from. A relay-hosted page (`link-page`, and `approval` of a sign-in made on one)
 * is only as trustworthy as the relay; a sign-in made in a native app (`native-app`) committed to
 * a nonce the device computed itself. An `endorsed` passkey was added to the account later and
 * vouched for by a sign-in this gateway already trusted.
 */
export const trustedSignInSourceSchema = z.enum([
  "link-page",
  "native-app",
  "approval",
  "endorsed",
]);
export type TrustedSignInSource = z.infer<typeof trustedSignInSourceSchema>;

export const trustedSignInSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("google"),
      id: z.string().regex(/^[a-f0-9]{64}$/),
      addedAt: z.number().int().positive(),
      source: trustedSignInSourceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("passkey"),
      id: z
        .string()
        .max(2048)
        .regex(/^[A-Za-z0-9_-]+$/),
      publicKey: z
        .string()
        .max(4096)
        .regex(/^[A-Za-z0-9_-]+$/),
      addedAt: z.number().int().positive(),
      source: trustedSignInSourceSchema,
    })
    .strict(),
]);
export type TrustedSignIn = z.infer<typeof trustedSignInSchema>;
/** A pin as a proof describes it; whoever saves it records where it came from. */
export type SignInPin = TrustedSignIn extends infer T
  ? T extends unknown
    ? Omit<T, "source">
    : never
  : never;

/** A proof the gateway checked itself. `trusted` says whether a local pin vouches for its signer. */
export interface VerifiedSignIn {
  type: "google" | "passkey";
  id: string;
  trusted: boolean;
  /**
   * For a passkey that no pin vouches for, the public key came with the request, so anyone could
   * have made it. It may hold a request for a person, but it is pinned only when the relay lists
   * this id with this key for the linked account.
   */
  pin: SignInPin;
}

export interface SignInVerifierOptions {
  /** Audiences come from this installation's registry, never from the relay. */
  google(): IdentityProvider | undefined;
  relayOrigin(): string;
  /** Android origins from this installation's registry; the relay origin is always included. */
  passkeyOrigins(): readonly string[];
  trusted(): readonly TrustedSignIn[];
  now?(): number;
}

/** Verifies sign-in proofs on the gateway. The relay carries them but can create none of them. */
export class GatewaySignInVerifier {
  private readonly now: () => number;
  constructor(private readonly options: SignInVerifierOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Undefined means unverifiable, which callers treat as "hold for a person", never as an error. */
  async verify(
    input: unknown,
    nonce: string,
    credentialPublicKey?: string,
  ): Promise<VerifiedSignIn | undefined> {
    const parsed = signInProofSchema.safeParse(input);
    if (!parsed.success) return undefined;
    try {
      return await this.check(parsed.data, nonce, credentialPublicKey);
    } catch {
      return undefined;
    }
  }

  /**
   * Whether a sign-in in `trusted` vouched for exactly this passkey. The proof is checked as of
   * when it was made, however long ago: it names one passkey and can be used for nothing else,
   * so a gateway that was offline can still accept it later.
   */
  async verifyEndorsement(
    input: unknown,
    passkey: { id: string; publicKey: string },
    trusted: readonly TrustedSignIn[],
  ): Promise<boolean> {
    const parsed = signInProofSchema.safeParse(input);
    // A passkey can't vouch for itself, and a registration carries no signature at all.
    if (
      !parsed.success ||
      parsed.data.type === "passkey-registration" ||
      (parsed.data.type === "passkey" && parsed.data.credential.id === passkey.id)
    )
      return false;
    const nonce = passkeyEndorsementNonce(passkey.id, passkey.publicKey);
    try {
      const verified =
        parsed.data.type === "google"
          ? await this.google(parsed.data, nonce, trusted, true)
          : await this.passkey(parsed.data, nonce, undefined, trusted, true);
      return verified?.trusted === true;
    } catch {
      return false;
    }
  }

  private check(
    proof: SignInProof,
    nonce: string,
    credentialPublicKey: string | undefined,
  ): Promise<VerifiedSignIn | undefined> {
    const trusted = this.options.trusted();
    if (proof.type === "google") return this.google(proof, nonce, trusted);
    if (proof.type === "passkey") return this.passkey(proof, nonce, credentialPublicKey, trusted);
    return this.registration(proof, nonce);
  }

  private async google(
    proof: Extract<SignInProof, { type: "google" }>,
    nonce: string,
    trusted: readonly TrustedSignIn[],
    anyAge = false,
  ): Promise<VerifiedSignIn | undefined> {
    const provider = this.options.google();
    if (!provider) return undefined;
    const issuedAt = decodeJwt(proof.idToken).iat;
    if (issuedAt === undefined || !this.fresh(issuedAt, anyAge)) return undefined;
    const identity = await provider.verify(
      proof.idToken,
      googleProofNonce(proof.salt, nonce),
      anyAge ? { at: issuedAt } : undefined,
    );
    const id = accountId({ ...identity, issuer: "https://accounts.google.com" });
    return {
      type: "google",
      id,
      trusted: trusted.some((value) => value.type === "google" && value.id === id),
      pin: { type: "google", id, addedAt: this.now() },
    };
  }

  private async passkey(
    proof: Extract<SignInProof, { type: "passkey" }>,
    nonce: string,
    offeredKey: string | undefined,
    trusted: readonly TrustedSignIn[],
    anyAge = false,
  ): Promise<VerifiedSignIn | undefined> {
    const issuedAt = Number(proof.issuedAt);
    if (!this.fresh(issuedAt, anyAge)) return undefined;
    const id = proof.credential.id;
    const pin = trusted.find(
      (value): value is Extract<TrustedSignIn, { type: "passkey" }> =>
        value.type === "passkey" && value.id === id,
    );
    // A pinned key always wins, so a relay can't substitute the key a pin vouches for.
    const publicKey = pin?.publicKey ?? offeredKey ?? proof.credentialPublicKey;
    if (!publicKey) return undefined;
    const origin = bindingOrigin(this.options.relayOrigin());
    const result = await verifyAuthenticationResponse({
      response: proof.credential,
      expectedChallenge: passkeyProofChallenge(proof.salt, proof.issuedAt, nonce),
      expectedOrigin: [origin.origin, ...this.options.passkeyOrigins()],
      expectedRPID: origin.hostname,
      credential: { id, publicKey: Buffer.from(publicKey, "base64url"), counter: 0 },
      requireUserVerification: true,
    });
    if (!result.verified) return undefined;
    return {
      type: "passkey",
      id,
      trusted: pin !== undefined,
      pin: { type: "passkey", id, publicKey, addedAt: this.now() },
    };
  }

  /** Only a new account's first passkey, at link time. It has no signature, so it is never `trusted`. */
  private async registration(
    proof: Extract<SignInProof, { type: "passkey-registration" }>,
    nonce: string,
  ): Promise<VerifiedSignIn | undefined> {
    const issuedAt = Number(proof.issuedAt);
    if (!this.fresh(issuedAt)) return undefined;
    const origin = bindingOrigin(this.options.relayOrigin());
    const result = await verifyRegistrationResponse({
      response: proof.credential,
      expectedChallenge: passkeyProofChallenge(proof.salt, proof.issuedAt, nonce),
      expectedOrigin: [origin.origin, ...this.options.passkeyOrigins()],
      expectedRPID: origin.hostname,
      requireUserVerification: true,
    });
    if (!result.verified) return undefined;
    const { id, publicKey } = result.registrationInfo.credential;
    return {
      type: "passkey",
      id,
      trusted: false,
      pin: {
        type: "passkey",
        id,
        publicKey: Buffer.from(publicKey).toString("base64url"),
        addedAt: this.now(),
      },
    };
  }

  private fresh(issuedAt: number, anyAge = false): boolean {
    const now = this.now();
    return (
      Number.isSafeInteger(issuedAt) &&
      issuedAt <= now + FUTURE_TOLERANCE_SECONDS &&
      (anyAge || issuedAt >= now - SIGN_IN_PROOF_MAX_AGE_SECONDS)
    );
  }
}
