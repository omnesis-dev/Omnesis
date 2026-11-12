// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { passkeyEndorsementNonce } from "./device-enrollment.js";
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
  expiresAt: number;
}

/**
 * A passkey created for an existing account waits here until a sign-in the account already has
 * vouches for it. That sign-in commits to the new passkey's id and public key, so each gateway can
 * check the vouching itself and trust the passkey without taking the relay's word for it. It also
 * shows the person is present, which is why adding needs no earlier confirmation.
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
      expiresAt: this.now() + this.ttl,
    });
    return id;
  }

  describe(id: string, cookieHeader: string) {
    const parked = this.current(id, cookieHeader);
    return { label: parked.registration.label, needsProof: parked.proof.needed() };
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
