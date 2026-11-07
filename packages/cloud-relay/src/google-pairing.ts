// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { accountId, type IdentityProvider } from "./identity.js";
import { RelayError } from "./tunnels.js";

export const googlePairingRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    kind: z.enum(["ios", "android", "collector", "cli", "portal"]),
    name: z.string().trim().min(1).max(80),
    secret: z.string().regex(/^[a-f0-9]{64}$/),
    identityToken: z.string().min(1).max(16_384),
  })
  .strict();
export type GooglePairingRequest = z.infer<typeof googlePairingRequestSchema>;
type RequestIdentity = Omit<GooglePairingRequest, "identityToken">;
const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/** A stolen routing ID token cannot be replayed without the client's private random secret. */
export function googlePairingNonce(value: RequestIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "omnesis-device-pairing-v2",
        value.requestId,
        value.kind,
        value.name,
        digest(value.secret).toString("hex"),
      ]),
    )
    .digest("base64url");
}

/** Compare on an independently trusted device. The relay cannot substitute a certificate silently. */
export function googlePairingVerificationCode(
  value: Pick<RequestIdentity, "requestId" | "secret">,
  gatewayFingerprint: string,
): string {
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(gatewayFingerprint);
  const raw = digest(
    JSON.stringify([
      "omnesis-pairing-sas-v2",
      gatewayFingerprint,
      value.requestId,
      digest(value.secret).toString("hex"),
    ]),
  )
    .toString("hex")
    .slice(0, 20)
    .toUpperCase();
  return raw.match(/.{4}/g)!.join("-");
}

interface Pending {
  requestId: string;
  kind: GooglePairingRequest["kind"];
  name: string;
  secretHash: Buffer;
  verificationCode: string;
  gatewayFingerprint: string;
  createdAt: number;
  expiresAt: number;
  state: "verifying" | "pending" | "approving" | "approved" | "denied";
  pairingCode?: string;
  decision?: Promise<void>;
}

/** Gateway-only approval. Google identifies a request; the owner still chooses every grant. */
export class GooglePairingRequests {
  private readonly requests = new Map<string, Pending>();
  constructor(
    private readonly options: {
      identity: IdentityProvider;
      ownerAccountId: string;
      gatewayFingerprint: () => string;
      createPairing(request: {
        kind: GooglePairingRequest["kind"];
        name: string;
        expiresAt: number;
      }): Promise<{ pairingCode: string; expiresAt: number }>;
      ttlMs?: number;
      maxPending?: number;
    },
  ) {
    for (const value of [options.ttlMs ?? 600_000, options.maxPending ?? 32])
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
        throw new Error("Invalid Google pairing limits");
    if (!/^[a-f0-9]{64}$/.test(options.ownerAccountId)) throw new Error("Invalid owner account");
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(options.gatewayFingerprint());
  }

  async start(input: unknown): Promise<ReturnType<GooglePairingRequests["poll"]>> {
    const value = googlePairingRequestSchema.parse(input);
    this.prune();
    const previous = this.requests.get(value.requestId);
    if (previous) {
      if (previous.kind !== value.kind || previous.name !== value.name)
        throw new RelayError(409, "Pairing request already exists");
      return this.poll(value.requestId, value.secret);
    }
    if (this.requests.size >= (this.options.maxPending ?? 32))
      throw new RelayError(429, "Too many pending pairing requests");
    const fingerprint = this.options.gatewayFingerprint();
    const request: Pending = {
      requestId: value.requestId,
      name: value.name,
      kind: value.kind,
      secretHash: digest(value.secret),
      createdAt: Date.now(),
      verificationCode: googlePairingVerificationCode(value, fingerprint),
      gatewayFingerprint: fingerprint,
      expiresAt: Date.now() + (this.options.ttlMs ?? 600_000),
      state: "verifying",
    };
    this.requests.set(value.requestId, request);
    try {
      const identity = await this.options.identity.verify(
        value.identityToken,
        googlePairingNonce(value),
      );
      if (accountId(identity) !== this.options.ownerAccountId)
        throw new RelayError(403, "Identity does not match the gateway owner");
      if (request.expiresAt <= Date.now() || this.requests.get(value.requestId) !== request)
        throw new RelayError(404, "Pairing request expired");
      request.state = "pending";
      return this.poll(value.requestId, value.secret);
    } catch (error) {
      if (this.requests.get(value.requestId) === request) this.requests.delete(value.requestId);
      throw error;
    }
  }

  poll(
    requestId: string,
    secret: string,
  ): {
    status: "pending" | "approved" | "denied";
    verificationCode: string;
    expiresAt: number;
    pairingCode?: string;
  } {
    this.prune();
    const row = this.requests.get(requestId);
    if (!row || row.state === "verifying" || !timingSafeEqual(row.secretHash, digest(secret)))
      throw new RelayError(404, "Pairing request not found");
    const status = row.state === "approving" ? "pending" : row.state;
    return {
      status,
      verificationCode: row.verificationCode,
      expiresAt: row.expiresAt,
      ...(row.state === "approved" ? { pairingCode: row.pairingCode! } : {}),
    };
  }

  list(): Array<{
    requestId: string;
    kind: GooglePairingRequest["kind"];
    name: string;
    status: string;
    verificationCode: string;
    expiresAt: number;
  }> {
    this.prune();
    return [...this.requests.values()]
      .filter((row) => row.state !== "verifying")
      .map((row) => ({
        requestId: row.requestId,
        kind: row.kind,
        name: row.name,
        status: row.state,
        verificationCode: row.verificationCode,
        expiresAt: row.expiresAt,
      }));
  }

  async decide(requestId: string, approve: boolean): Promise<void> {
    this.prune();
    const row = this.requests.get(requestId);
    if (!row || row.state === "verifying") throw new RelayError(404, "Pairing request not found");
    if (row.gatewayFingerprint !== this.options.gatewayFingerprint())
      throw new RelayError(409, "Gateway certificate changed; start pairing again");
    if (row.state === "approving") {
      if (!approve) throw new RelayError(409, "Pairing approval already in progress");
      return row.decision;
    }
    if (row.state !== "pending") throw new RelayError(409, "Pairing request already decided");
    if (!approve) {
      row.state = "denied";
      return;
    }
    row.state = "approving";
    row.decision = Promise.resolve()
      .then(() =>
        this.options.createPairing({
          kind: row.kind,
          name: row.name,
          expiresAt: row.expiresAt,
        }),
      )
      .then((result) => {
        if (row.expiresAt <= Date.now() || this.requests.get(requestId) !== row)
          throw new RelayError(404, "Pairing request expired");
        row.pairingCode = result.pairingCode;
        row.expiresAt = Math.min(row.expiresAt, result.expiresAt);
        row.state = "approved";
      })
      .catch((error: unknown) => {
        row.state = "pending";
        throw error;
      });
    return row.decision;
  }

  private prune(): void {
    for (const [id, row] of this.requests)
      if (row.expiresAt <= Date.now()) this.requests.delete(id);
  }
}
