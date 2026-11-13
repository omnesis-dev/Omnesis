// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
  X509Certificate,
} from "node:crypto";
import { relayOrigin } from "./network.js";
import { bindingOrigin } from "./gateway-binding.js";
import { validateKeyRegistration, tlsKeySignatureAlgorithm } from "./gateway-key-auth.js";
import { verifyRecoveryReceipt, type TrustedRecoveryPolicy } from "./recovery-verifier.js";
import {
  independentDnsRequestSchema,
  independentDnsCompletionSchema,
  independentDnsRequestDigest,
  independentDnsTranscript,
  type IndependentDnsRequest,
  type IndependentDnsChallenge,
} from "./independent-dns-contract.js";
import { RelayError } from "./tunnels.js";
import type { AcmeDnsChallenges } from "./acme-dns.js";

export interface IndependentDnsServiceOptions {
  origin: string | (() => string);
  policy: TrustedRecoveryPolicy;
  dns: AcmeDnsChallenges;
  maxChallenges?: number;
  challengeTtlMs?: number;
}
interface Pending {
  request: IndependentDnsRequest;
  challenge: IndependentDnsChallenge;
}

/** No relay sessions, account database or Google claims are authority at this independent boundary. */
export class IndependentDnsService {
  private readonly pending = new Map<string, Pending>();
  private readonly origin: () => string;
  private closed = false;
  constructor(private readonly options: IndependentDnsServiceOptions) {
    const supplied = options.origin;
    if (typeof supplied === "string") relayOrigin(supplied);
    this.origin = () => relayOrigin(typeof supplied === "string" ? supplied : supplied()).origin;
    for (const [value, max] of [
      [options.maxChallenges ?? 32, 32],
      [options.challengeTtlMs ?? 60_000, 60_000],
    ])
      if (!Number.isSafeInteger(value) || value! <= 0 || value! > max!)
        throw new Error("Invalid independent DNS limits");
  }
  challenge(input: unknown): IndependentDnsChallenge {
    if (this.closed) throw new RelayError(503, "Independent DNS broker is closed");
    for (const [id, row] of this.pending)
      if (row.challenge.expiresAt <= Date.now()) this.pending.delete(id);
    if (this.pending.size >= (this.options.maxChallenges ?? 32))
      throw new RelayError(429, "DNS proof capacity reached");
    const request = independentDnsRequestSchema.parse(input);
    request.registration = validateKeyRegistration(request.registration);
    verifyRecoveryReceipt(request.recoveryReceipt, this.options.policy, request.registration);
    const challenge: IndependentDnsChallenge = {
      protocol: "omnesis-independent-dns-v1",
      brokerOrigin: this.origin(),
      challengeId: randomUUID(),
      nonce: randomBytes(32).toString("hex"),
      requestDigest: independentDnsRequestDigest(request),
      expiresAt: Date.now() + (this.options.challengeTtlMs ?? 60_000),
    };
    this.pending.set(challenge.challengeId, { request, challenge });
    return { ...challenge };
  }
  async complete(
    input: unknown,
    signal: AbortSignal,
  ): Promise<{ id: string; expiresAt: number } | { removed: true }> {
    signal.throwIfAborted();
    if (this.closed) throw new RelayError(503, "Independent DNS broker is closed");
    const value = independentDnsCompletionSchema.parse(input);
    const row = this.pending.get(value.challengeId);
    if (!row) throw new RelayError(401, "DNS proof is missing or expired");
    this.pending.delete(value.challengeId);
    if (row.challenge.expiresAt <= Date.now())
      throw new RelayError(401, "DNS proof is missing or expired");
    const { request, challenge } = row;
    verifyRecoveryReceipt(request.recoveryReceipt, this.options.policy, request.registration);
    const owner = createPublicKey(request.registration.ownerPublicKey);
    const tls = new X509Certificate(request.registration.certificate).publicKey;
    if (
      !verify(
        null,
        independentDnsTranscript(challenge, "owner"),
        owner,
        Buffer.from(value.ownerSignature, "base64url"),
      ) ||
      !verify(
        tlsKeySignatureAlgorithm(tls),
        independentDnsTranscript(challenge, "tls"),
        tls,
        Buffer.from(value.tlsSignature, "base64url"),
      )
    )
      throw new RelayError(401, "Independent DNS key proof was refused");
    signal.throwIfAborted();
    // Lease authority belongs to the exact receipt binding, even when an owner has multiple gateways.
    const account = createHash("sha256")
      .update(
        JSON.stringify([
          "omnesis-independent-dns-lease-v1",
          request.recoveryReceipt.payload.accountId,
          request.registration.gatewayId,
          request.registration.publicOrigin,
        ]),
      )
      .digest("hex");
    if (request.operation.type === "create")
      return this.options.dns.create(
        account,
        bindingOrigin(request.recoveryReceipt.payload.publicOrigin).hostname,
        request.operation.value,
        signal,
      );
    await this.options.dns.remove(account, request.operation.leaseId);
    return { removed: true };
  }
  close(): void {
    this.closed = true;
    this.pending.clear();
  }
}
