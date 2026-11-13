// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { enrollmentOpaque } from "./device-enrollment.js";
import { keyBindingOwnerAccount } from "./gateway-key-auth.js";
import {
  OperationProof,
  type AccountOperationBroker,
  type ProofEvidence,
  type RedeemedProof,
} from "./operation-proof.js";
import { RelayError } from "./tunnels.js";
import type { AccountBrowserAccount } from "./account-browser-broker.js";
import type { AccountEnrollmentAuthority } from "./account-enrollment-proof.js";
import type { GatewayDirectory } from "./gateway-directory.js";

const startSchema = z.object({ nonce: enrollmentOpaque }).strict();
const browserCookie = "__Host-omnesis-account-browser";
/** A gateway accepts a sign-in proof for ten minutes, so the operation lives no longer. */
const OPERATION_SECONDS = 600;
/** The longest attestation the enrollment authority signs. */
const ATTESTATION_SECONDS = 300;
const digest = (value: string) => createHash("sha256").update(value).digest();
const now = () => Math.floor(Date.now() / 1000);

interface Operation {
  nonce: string;
  proof: OperationProof;
  browserHash: Buffer;
  expiresAt: number;
}

/**
 * The account page's own sign-in, bound to a device key the page made for a gateway's portal.
 * The proof leaves once, to the browser that signed in, for a gateway of the signed-in account;
 * the gateway still verifies it and decides whether the browser joins.
 */
export class PortalSignIn implements AccountOperationBroker {
  private readonly operations = new Map<string, Operation>();
  private readonly maxPending: number;
  private closed = false;
  constructor(
    private readonly options: {
      directory: Pick<GatewayDirectory, "select">;
      authority?: AccountEnrollmentAuthority;
      assertAccount(account: AccountBrowserAccount): void;
      assertCurrent(): void;
      maxPending?: number;
    },
  ) {
    this.maxPending = options.maxPending ?? 256;
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1 || this.maxPending > 4096)
      throw new Error("Invalid portal sign-in limits");
  }

  start(input: unknown, cookieHeader: string): { operationId: string; expiresAt: number } {
    this.assertOpen();
    this.prune();
    const parsed = startSchema.safeParse(input),
      browser = browserValue(cookieHeader);
    if (!parsed.success || !browser) throw new RelayError(400, "Invalid portal sign-in request");
    if (this.operations.size >= this.maxPending)
      throw new RelayError(429, "Too many portal sign-in requests");
    const operationId = randomUUID(),
      expiresAt = now() + OPERATION_SECONDS;
    this.operations.set(operationId, {
      nonce: parsed.data.nonce,
      proof: new OperationProof(parsed.data.nonce),
      browserHash: digest(browser),
      expiresAt,
    });
    return { operationId, expiresAt };
  }

  describe(id: string, cookieHeader: string): { ready: boolean } {
    return { ready: !this.browser(id, cookieHeader).proof.needed() };
  }
  proofCommitment(id: string, cookieHeader: string) {
    return this.signingIn(id, cookieHeader).proof.commitment();
  }
  googleProofNonce(id: string, cookieHeader: string) {
    return this.signingIn(id, cookieHeader).proof.googleNonce();
  }
  recordProof(id: string, cookieHeader: string, evidence: ProofEvidence): void {
    this.signingIn(id, cookieHeader).proof.record(evidence);
  }
  confirm(): never {
    throw new RelayError(400, "A portal sign-in has nothing to confirm");
  }

  /** Until the proof is taken, a refusal here leaves the operation as it was. */
  async handoff(
    id: string,
    cookieHeader: string,
    account: AccountBrowserAccount,
    gatewayId: string,
  ): Promise<RedeemedProof & { identityToken: string; publicOrigin: string }> {
    const operation = this.browser(id, cookieHeader);
    this.options.assertAccount(account);
    operation.proof.assertFrom(account.accountId);
    const binding = this.options.directory.select(
      account.accountId,
      new URLSearchParams({ gatewayId }),
    );
    const ownerAccountId = keyBindingOwnerAccount(binding);
    if (!ownerAccountId) throw new RelayError(409, "Gateway needs an account-enrollment update");
    if (!this.options.authority) throw new RelayError(503, "Account enrollment is unavailable");
    const identityToken = await this.options.authority.issue(
      {
        accountId: account.accountId,
        gatewayId: binding.gatewayId,
        ownerAccountId,
        nonce: operation.nonce,
      },
      Math.min(operation.expiresAt, now() + ATTESTATION_SECONDS),
    );
    // Another request may have spent or cancelled the operation while the attestation was signed.
    if (this.operations.get(id) !== operation)
      throw new RelayError(403, "Portal sign-in is unavailable");
    this.options.assertAccount(account);
    this.operations.delete(id);
    return { identityToken, ...operation.proof.take(), publicOrigin: binding.publicOrigin };
  }

  close(): void {
    this.closed = true;
    this.operations.clear();
  }

  private signingIn(id: string, cookieHeader: string): Operation {
    const operation = this.browser(id, cookieHeader);
    if (!operation.proof.needed())
      throw new RelayError(409, "Portal sign-in is no longer waiting for a sign-in");
    return operation;
  }
  private browser(id: string, cookieHeader: string): Operation {
    this.assertOpen();
    this.prune();
    const operation = this.operations.get(id),
      browser = browserValue(cookieHeader);
    if (!operation || !browser || !timingSafeEqual(digest(browser), operation.browserHash))
      throw new RelayError(403, "Portal sign-in is unavailable");
    return operation;
  }
  private assertOpen(): void {
    if (this.closed) throw new RelayError(503, "Portal sign-in is unavailable");
    this.options.assertCurrent();
  }
  private prune(): void {
    for (const [id, operation] of this.operations)
      if (operation.expiresAt <= now()) this.operations.delete(id);
  }
}

/** The account page's browser cookie, when the request carries exactly one well-formed value. */
function browserValue(header: string): string | undefined {
  const values = header
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(browserCookie + "="))
    .map((value) => value.slice(browserCookie.length + 1));
  return values.length === 1 && enrollmentOpaque.safeParse(values[0]).success
    ? values[0]
    : undefined;
}
