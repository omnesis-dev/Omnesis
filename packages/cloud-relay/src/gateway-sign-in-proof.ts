// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { decodeJwt } from "jose";
import { z } from "zod";
import {
  gatewayPasskeyChallenge,
  gatewayPasskeySignInProofSchema,
  googleProofNonce,
  passkeyCountersignatureNonce,
  passkeyCountersignatureSchema,
  passkeyEndorsementNonce,
  passkeyProofChallenge,
  signInProofNonce,
  signInProofSchema,
  type GatewayPasskeyPurpose,
  type SignInProof,
  type SignInPurpose,
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
 * vouched for by a sign-in this gateway already trusted. A `countersigned` sign-in is one the
 * account already had when a passkey trusted here was added, which that passkey signed for on the
 * account page.
 */
export const trustedSignInSourceSchema = z.enum([
  "link-page",
  "native-app",
  "approval",
  "endorsed",
  "countersigned",
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

/**
 * How the owner confirmed a sign-in on this gateway, in a ceremony the relay could not have made:
 *
 * - `gateway-origin`: a passkey assertion made on this gateway's own page.
 * - `android-app`: a passkey assertion made in the official Android app (an app origin no web
 *   page can produce).
 * - `native-google-approval`: the owner approved a device that signed in with Google in an
 *   official app, comparing its code.
 * - `admin-app-google`: an already paired admin app signed in with Google over its pinned
 *   connection.
 */
export const confirmedSignInViaSchema = z.enum([
  "gateway-origin",
  "android-app",
  "native-google-approval",
  "admin-app-google",
]);
export type ConfirmedSignInVia = z.infer<typeof confirmedSignInViaSchema>;
const MAX_SIGNATURE_COUNTER = 0xffff_ffff;

/**
 * A sign-in the owner confirmed on this gateway. Unlike a pin the relay's evidence may add, only a
 * ceremony on this gateway's own origin or in an official app adds one. A passkey keeps the
 * WebAuthn signature counter it last presented.
 */
export const confirmedSignInSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("google"),
      id: z.string().regex(/^[a-f0-9]{64}$/),
      at: z.number().int().positive(),
      via: confirmedSignInViaSchema,
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
      counter: z.number().int().min(0).max(MAX_SIGNATURE_COUNTER),
      at: z.number().int().positive(),
      via: confirmedSignInViaSchema,
    })
    .strict(),
]);
export type ConfirmedSignIn = z.infer<typeof confirmedSignInSchema>;

/**
 * Where a verified sign-in was made, judged only from what the gateway checked itself:
 *
 * - `relay-page`: a passkey assertion whose origin is the relay. A relay web page and the iOS app
 *   both present it, so the relay could have chosen its challenge.
 * - `gateway-origin`: a `gateway-passkey` assertion made on this gateway's own origin.
 * - `android-app`: a passkey assertion from the official Android app.
 * - `native-google`: a Google token presented by an official native app client (`azp`).
 * - `web-google`: any other Google token, which a web page could have requested.
 */
export type SignInChannel =
  "relay-page" | "gateway-origin" | "android-app" | "native-google" | "web-google";

/** The official app clients whose Google tokens count as native (see `GoogleBrowserTrust`). */
export interface NativeGoogleClients {
  ios: readonly string[];
  android: readonly string[];
}

/** A proof the gateway checked itself. `trusted` says whether a local pin vouches for its signer. */
export interface VerifiedSignIn {
  type: "google" | "passkey";
  id: string;
  trusted: boolean;
  channel: SignInChannel;
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
  /**
   * This gateway's own origin as the gateway derives it itself, or undefined when it can't vouch
   * for one (a custom domain, or a saved origin that isn't its hosted name). Without it, only an
   * official Android app can make a `gateway-passkey` assertion.
   */
  gatewayOrigin?(): string | undefined;
  /** Compiled into the gateway; never configuration and never taken from the relay. */
  nativeGoogleClients?(): NativeGoogleClients;
  now?(): number;
}

/** A `gateway-passkey` assertion the gateway checked against a key it chose itself. */
export interface VerifiedGatewayPasskey {
  id: string;
  publicKey: string;
  /** The signature counter this assertion presented; the caller keeps it with the key. */
  counter: number;
  channel: "gateway-origin" | "android-app";
}

/** The key a `gateway-passkey` assertion is checked against, with the counter last seen for it. */
export interface GatewayPasskeyKey {
  publicKey: string;
  counter: number;
}

/**
 * Refuses a WebAuthn response made inside a frame of another site. The gateway's pages never
 * frame each other, so `crossOrigin` or `topOrigin` only appear when someone else embedded one.
 */
function sameOriginCeremony(clientDataJSON: string): boolean {
  const data: unknown = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8"));
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { crossOrigin?: unknown }).crossOrigin !== true &&
    !("topOrigin" in data)
  );
}

/** Verifies sign-in proofs on the gateway. The relay carries them but can create none of them. */
export class GatewaySignInVerifier {
  private readonly now: () => number;
  constructor(private readonly options: SignInVerifierOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Undefined means unverifiable, which callers treat as "hold for a person", never as an error.
   * The proof must have been made for `purpose` (see `SignInPurpose`) on the operation `nonce`
   * names: a sign-in made to link a gateway never verifies as a device's enrollment, nor the reverse.
   */
  async verify(
    input: unknown,
    purpose: SignInPurpose,
    nonce: string,
    credentialPublicKey?: string,
  ): Promise<VerifiedSignIn | undefined> {
    const parsed = signInProofSchema.safeParse(input);
    if (!parsed.success) return undefined;
    try {
      return await this.check(parsed.data, signInProofNonce(purpose, nonce), credentialPublicKey);
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

  /**
   * The sign-in an endorsement claims as its signer, read without checking anything. It only
   * tells a caller whether verifying could succeed: an endorsement whose claimed signer is not
   * pinned here can't, so it need not be verified at all.
   */
  endorsementSigner(input: unknown): { type: "google" | "passkey"; id: string } | undefined {
    const parsed = signInProofSchema.safeParse(input);
    if (!parsed.success || parsed.data.type === "passkey-registration") return undefined;
    if (parsed.data.type === "passkey") return { type: "passkey", id: parsed.data.credential.id };
    try {
      const subject = decodeJwt(parsed.data.idToken).sub;
      return subject
        ? {
            type: "google",
            id: accountId({ issuer: "https://accounts.google.com", subject, expiresAt: 1 }),
          }
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The `signInDigest`s `signer` countersigned for `accountId` when it was added, provided
   * `signer` is pinned here with that very key; otherwise nothing. Only the passkey's own signature can say
   * this: a sign-in that vouched for the passkey (an endorsement) says nothing about itself,
   * because anyone with any Google account or passkey can make one naming a passkey they saw
   * listed. Like an endorsement it is checked as of when it was made: the passkey's key does not
   * expire and nobody can retire it.
   */
  async verifyCountersignature(
    input: unknown,
    signer: { id: string; publicKey: string },
    accountId: string,
    trusted: readonly TrustedSignIn[],
  ): Promise<readonly string[] | undefined> {
    const parsed = passkeyCountersignatureSchema.safeParse(input);
    if (
      !parsed.success ||
      parsed.data.proof.credential.id !== signer.id ||
      !trusted.some(
        (value) =>
          value.type === "passkey" &&
          value.id === signer.id &&
          value.publicKey === signer.publicKey,
      )
    )
      return undefined;
    const { proof, signIns } = parsed.data;
    try {
      const verified = await this.passkey(
        proof,
        passkeyCountersignatureNonce(accountId, signIns),
        undefined,
        trusted,
        true,
      );
      return verified?.trusted ? signIns : undefined;
    } catch {
      return undefined;
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
      channel: this.nativeGoogle(proof.idToken) ? "native-google" : "web-google",
      pin: { type: "google", id, addedAt: this.now() },
    };
  }

  /**
   * Whether an official app presented this verified token. Google names the presenting client
   * in `azp`: an Android app's token is for the web client (`aud`) and presented by the Android
   * client, an iOS app's is for and by the iOS client. A token without `azp` is never native.
   */
  private nativeGoogle(idToken: string): boolean {
    const clients = this.options.nativeGoogleClients?.();
    const { azp, aud } = decodeJwt(idToken);
    if (!clients || typeof azp !== "string") return false;
    return (
      clients.android.includes(azp) || (clients.ios.includes(azp) && [aud].flat().includes(azp))
    );
  }

  /** An official Android app origin, from this installation's registry. */
  private androidOrigin(origin: string): boolean {
    return this.options.passkeyOrigins().includes(origin);
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
    if (!sameOriginCeremony(proof.credential.response.clientDataJSON)) return undefined;
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
      channel: this.androidOrigin(result.authenticationInfo.origin) ? "android-app" : "relay-page",
      pin: { type: "passkey", id, publicKey, addedAt: this.now() },
    };
  }

  /**
   * A passkey assertion made on this gateway's own page (or in the official Android app) for
   * `purpose`, over the one-use `challenge` this gateway issued and `binding`. The caller has
   * already spent `challenge`, and chooses the key: `key` answers only for a credential id the
   * gateway holds a key for, so an assertion never brings its own. Undefined means refused.
   */
  async verifyGatewayPasskey(
    input: unknown,
    ceremony: {
      purpose: GatewayPasskeyPurpose;
      challenge: string;
      binding: string;
      key(credentialId: string): GatewayPasskeyKey | undefined;
    },
  ): Promise<VerifiedGatewayPasskey | undefined> {
    const parsed = gatewayPasskeySignInProofSchema.safeParse(input);
    if (!parsed.success || parsed.data.challenge !== ceremony.challenge) return undefined;
    const { credential } = parsed.data;
    const key = ceremony.key(credential.id);
    const gatewayOrigin = this.options.gatewayOrigin?.();
    const androidOrigins = this.options.passkeyOrigins();
    if (!key) return undefined;
    try {
      if (!sameOriginCeremony(credential.response.clientDataJSON)) return undefined;
      const rpID = bindingOrigin(this.options.relayOrigin()).hostname;
      // The challenge names the origin the browser was on, so it is checked per candidate origin.
      for (const origin of [...(gatewayOrigin ? [gatewayOrigin] : []), ...androidOrigins]) {
        const result = await verifyAuthenticationResponse({
          response: credential,
          expectedChallenge: gatewayPasskeyChallenge(
            ceremony.purpose,
            origin,
            ceremony.challenge,
            ceremony.binding,
          ),
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: {
            id: credential.id,
            publicKey: Buffer.from(key.publicKey, "base64url"),
            counter: key.counter,
          },
          requireUserVerification: true,
        }).catch(() => undefined);
        if (result?.verified)
          return {
            id: credential.id,
            publicKey: key.publicKey,
            counter: result.authenticationInfo.newCounter,
            channel: origin === gatewayOrigin ? "gateway-origin" : "android-app",
          };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** Only a new account's first passkey, at link time. It has no signature, so it is never `trusted`. */
  private async registration(
    proof: Extract<SignInProof, { type: "passkey-registration" }>,
    nonce: string,
  ): Promise<VerifiedSignIn | undefined> {
    const issuedAt = Number(proof.issuedAt);
    if (!this.fresh(issuedAt) || !sameOriginCeremony(proof.credential.response.clientDataJSON))
      return undefined;
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
      channel: this.androidOrigin(result.registrationInfo.origin) ? "android-app" : "relay-page",
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
