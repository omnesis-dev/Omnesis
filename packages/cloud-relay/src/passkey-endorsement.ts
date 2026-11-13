// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  passkeyCountersignatureNonce,
  passkeyEndorsementNonce,
  type CountersignedSignIns,
  type PasskeyCountersignature,
} from "./device-enrollment.js";
import {
  OperationProof,
  type AccountOperationBroker,
  type ProofEvidence,
} from "./operation-proof.js";
import { RelayError } from "./tunnels.js";
import type { OmnesisAccounts, PasskeyRegistration } from "./omnesis-accounts.js";

const browserCookie = "__Host-omnesis-account-browser";
const digest = (value: string) => createHash("sha256").update(value).digest();
interface Parked {
  accountId: string;
  registration: PasskeyRegistration;
  browserHash: Buffer;
  proof: OperationProof;
  /** The new passkey's own signature over the account's other sign-ins, as they were when parked. */
  countersignature: { signIns: CountersignedSignIns; proof: OperationProof };
  expiresAt: number;
}

/**
 * A passkey created for an existing account waits here until a sign-in the account already has
 * vouches for it. That sign-in commits to the new passkey's id and public key, so each gateway can
 * check the vouching itself and trust the passkey without taking the relay's word for it. It also
 * shows the person is present, which is why adding needs no earlier confirmation.
 *
 * The new passkey also signs once, committing to the account's other sign-ins: its
 * countersignature. A gateway that trusts the new passkey checks that signature against its own
 * pin and trusts those sign-ins too. The vouching can't do this in reverse: anyone can make a
 * sign-in that names a passkey they saw listed, but only the passkey's holder can sign with it.
 */
export class PasskeyEndorsements implements AccountOperationBroker {
  private readonly parked = new Map<string, Parked>();
  private closed = false;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly maxPending: number;
  constructor(
    private readonly accounts: OmnesisAccounts,
    options: { now?: () => number; ttlMs?: number; maxPending?: number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttl = options.ttlMs ?? 300_000;
    this.maxPending = options.maxPending ?? 128;
  }

  /** Holds a verified new passkey for the browser that created it. Nothing is stored yet. */
  park(browser: string, accountId: string, registration: PasskeyRegistration): string {
    if (this.closed) throw new RelayError(503, "Passkey service is closed");
    for (const [id, value] of this.parked)
      if (value.expiresAt <= this.now()) this.parked.delete(id);
    if (this.parked.size >= this.maxPending) throw new RelayError(429, "Too many passkey requests");
    const id = randomUUID();
    const signIns: CountersignedSignIns = {
      google: this.accounts.federatedDigests(accountId, "google"),
      passkeys: this.accounts
        .passkeyKeys(accountId)
        .map(({ id, publicKey }) => ({ id, publicKey })),
    };
    this.parked.set(id, {
      accountId,
      registration,
      browserHash: digest(browser),
      proof: new OperationProof(
        passkeyEndorsementNonce(
          registration.credential.id,
          Buffer.from(registration.credential.publicKey).toString("base64url"),
        ),
      ),
      countersignature: {
        signIns,
        proof: new OperationProof(passkeyCountersignatureNonce(accountId, signIns)),
      },
      expiresAt: this.now() + this.ttl,
    });
    return id;
  }

  describe(id: string, cookieHeader: string) {
    const parked = this.current(id, cookieHeader);
    return {
      label: parked.registration.label,
      needsProof: parked.proof.needed(),
      needsCountersignature: parked.countersignature.proof.needed(),
    };
  }
  /** What the new passkey signs, and the stored credential its signature is checked against. */
  countersigning(id: string, cookieHeader: string) {
    const parked = this.current(id, cookieHeader);
    return {
      accountId: parked.accountId,
      credential: parked.registration.credential,
      commitment: parked.countersignature.proof.commitment(),
    };
  }
  /** Keeps the new passkey's verified signature, and the counter it reached, for storing with it. */
  recordCountersignature(
    id: string,
    cookieHeader: string,
    evidence: { challenge: string; credential: unknown; counter: number },
  ): void {
    const parked = this.current(id, cookieHeader),
      { credential } = parked.registration;
    parked.countersignature.proof.record({
      type: "passkey",
      accountId: parked.accountId,
      challenge: evidence.challenge,
      credential: evidence.credential,
      credentialPublicKey: Buffer.from(credential.publicKey).toString("base64url"),
    });
    credential.counter = Math.max(credential.counter, evidence.counter);
  }
  proofCommitment(id: string, cookieHeader: string) {
    return this.current(id, cookieHeader).proof.commitment();
  }
  googleProofNonce(id: string, cookieHeader: string) {
    return this.current(id, cookieHeader).proof.googleNonce();
  }
  /** The account's other passkeys: the only ones that can vouch for the new one. */
  endorsers(id: string, cookieHeader: string): string[] {
    const parked = this.current(id, cookieHeader);
    return this.accounts.list(parked.accountId).passkeys.map((key) => key.id);
  }
  recordProof(id: string, cookieHeader: string, evidence: ProofEvidence): void {
    const parked = this.current(id, cookieHeader);
    // Only a sign-in the account already had can vouch, and only for its own account.
    if (evidence.type === "passkey-registration" || evidence.accountId !== parked.accountId)
      throw new RelayError(403, "Confirm with a sign-in this Omnesis account already has");
    parked.proof.record(evidence);
  }
  confirm(): never {
    throw new RelayError(400, "Finish adding the passkey on the account page");
  }

  /** Stores the passkey with the sign-in that vouched for it. */
  complete(id: string, cookieHeader: string, account: { accountId: string; version: number }) {
    const parked = this.current(id, cookieHeader);
    if (account.accountId !== parked.accountId)
      throw new RelayError(409, "Sign in to the Omnesis account you are adding this passkey to");
    parked.proof.assertFrom(account.accountId);
    this.parked.delete(id);
    this.accounts.registerPasskey(
      account.accountId,
      parked.registration,
      false,
      account.version,
      undefined,
      parked.proof.take().signInProof,
      this.countersignature(parked),
    );
    return { id: parked.registration.credential.id };
  }

  cancel(id: string, cookieHeader: string): void {
    this.current(id, cookieHeader);
    this.parked.delete(id);
  }
  close(): void {
    this.closed = true;
    this.parked.clear();
  }

  /** Absent when the page skipped it: the passkey is then trusted only in the forward direction. */
  private countersignature(parked: Parked): PasskeyCountersignature | undefined {
    const { proof, signIns } = parked.countersignature;
    if (proof.needed()) return undefined;
    const { signInProof } = proof.take();
    if (signInProof.type !== "passkey") return undefined;
    return {
      // The key is the passkey's own, which every gateway that can use this has pinned.
      proof: {
        type: "passkey",
        salt: signInProof.salt,
        issuedAt: signInProof.issuedAt,
        credential: signInProof.credential,
      },
      google: [...signIns.google],
      passkeys: signIns.passkeys.map(({ id, publicKey }) => ({ id, publicKey })),
    };
  }

  private current(id: string, cookieHeader: string): Parked {
    const parked = this.parked.get(id);
    const values = cookieHeader
      .split(";")
      .map((value) => value.trim())
      .filter((value) => value.startsWith(browserCookie + "="));
    if (
      this.closed ||
      !parked ||
      parked.expiresAt <= this.now() ||
      values.length !== 1 ||
      !timingSafeEqual(digest(values[0]!.slice(browserCookie.length + 1)), parked.browserHash)
    )
      throw new RelayError(403, "This passkey is no longer waiting to be confirmed");
    return parked;
  }
}
