// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  googleProofNonce,
  passkeyProofChallenge,
  signInProofSchema,
  type SignInProof,
} from "./device-enrollment.js";
import { RelayError } from "./tunnels.js";
import type { AccountBrowserAccount } from "./account-browser-broker.js";

export interface ProofCommitment {
  salt: string;
  issuedAt: string;
  nonce: string;
}
export type ProofEvidence =
  | { type: "google"; accountId: string; idToken: string; nonce: string }
  | {
      type: "passkey";
      accountId: string;
      challenge: string;
      credential: unknown;
      credentialPublicKey: string;
    }
  | { type: "passkey-registration"; accountId: string; challenge: string; credential: unknown };
export interface RedeemedProof {
  signInProof: SignInProof;
  credentialPublicKey?: string;
}

/** What the account page needs from any operation that a browser completes by signing in. */
export interface AccountOperationBroker {
  describe(id: string, cookieHeader: string): object;
  proofCommitment(id: string, cookieHeader: string): ProofCommitment;
  googleProofNonce(id: string, cookieHeader: string): string;
  recordProof(id: string, cookieHeader: string, evidence: ProofEvidence): void;
  /** Only operations that can create an account: the person chooses to create one or sign in. */
  setIntent?(id: string, cookieHeader: string, intent: "create" | "existing"): void;
  confirm(
    id: string,
    cookieHeader: string,
    account: AccountBrowserAccount,
  ): { location: string; cookie: string } | Promise<{ location: string; cookie: string }>;
}

const digest = (value: string) => createHash("sha256").update(value).digest();
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/**
 * The sign-in one operation is waiting for. It lives only in memory on that operation and leaves
 * it once, at redemption. A sign-in made for any other operation fails the commitment check.
 */
export class OperationProof {
  private readonly salt = randomBytes(32).toString("base64url");
  private readonly issuedAt = String(Math.floor(Date.now() / 1000));
  private recorded?: { accountId: string; proof: RedeemedProof };
  constructor(private readonly nonce: string) {}

  commitment(): ProofCommitment {
    return { salt: this.salt, issuedAt: this.issuedAt, nonce: this.nonce };
  }
  googleNonce(): string {
    return googleProofNonce(this.salt, this.nonce);
  }
  needed(): boolean {
    return this.recorded === undefined;
  }

  record(evidence: ProofEvidence): void {
    if (evidence.type === "google") {
      if (!same(evidence.nonce, this.googleNonce()))
        throw new RelayError(403, "This sign-in was made for another request");
      this.recorded = {
        accountId: evidence.accountId,
        proof: {
          signInProof: signInProofSchema.parse({
            type: "google",
            idToken: evidence.idToken,
            salt: this.salt,
          }),
        },
      };
      return;
    }
    if (!same(evidence.challenge, passkeyProofChallenge(this.salt, this.issuedAt, this.nonce)))
      throw new RelayError(403, "This sign-in was made for another request");
    const common = { salt: this.salt, issuedAt: this.issuedAt, credential: evidence.credential };
    this.recorded = {
      accountId: evidence.accountId,
      proof:
        evidence.type === "passkey"
          ? {
              signInProof: signInProofSchema.parse({
                type: "passkey",
                credentialPublicKey: evidence.credentialPublicKey,
                ...common,
              }),
              credentialPublicKey: evidence.credentialPublicKey,
            }
          : { signInProof: signInProofSchema.parse({ type: "passkey-registration", ...common }) },
    };
  }

  /** The cookie and the proof must name one account, so nobody can spend another account's sign-in. */
  assertFrom(accountId: string): void {
    if (this.recorded?.accountId !== accountId)
      throw new RelayError(409, "Sign in on this request before continuing");
  }

  /** Callers run this only after `assertFrom` has passed. */
  take(): RedeemedProof {
    const { proof } = this.recorded!;
    this.recorded = undefined;
    return proof;
  }
}
