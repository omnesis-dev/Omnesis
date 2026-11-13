// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { googleProofNonce } from "./device-enrollment.js";
import { RelayError } from "./tunnels.js";
import type { ProofCommitment } from "./operation-proof.js";

const startSchema = z
  .object({
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    kind: z.enum(["ios", "android", "cli", "collector", "portal"]),
  })
  .strict();
const verifierSchema = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);
export type NativeAccountIntent = z.infer<typeof startSchema>;
interface Operation {
  intent: NativeAccountIntent;
  ticketHash: Buffer;
  salt: string;
  googleNonce: string;
  expiresAt: number;
  phase: "ready" | "verifying";
}

/** A native sign-in result is bound to its initiating device challenge and PKCE verifier. */
export class NativeAccountOperations {
  private readonly operations = new Map<string, Operation>();
  private closed = false;
  constructor(
    private readonly limits: { maxPending: number; ttlMs: number } = {
      maxPending: 128,
      ttlMs: 300_000,
    },
    private readonly now: () => number = Date.now,
  ) {
    if (
      !Number.isSafeInteger(limits.maxPending) ||
      limits.maxPending < 1 ||
      !Number.isSafeInteger(limits.ttlMs) ||
      limits.ttlMs < 1 ||
      limits.ttlMs > 300_000
    )
      throw new Error("Invalid native account operation limits");
  }

  start(input: unknown): {
    operationId: string;
    ticket: string;
    salt: string;
    googleNonce: string;
    expiresAt: number;
  } {
    if (this.closed) throw new RelayError(503, "Account sign-in is unavailable");
    this.prune();
    const parsed = startSchema.safeParse(input);
    if (!parsed.success) throw new RelayError(400, "Invalid native sign-in request");
    if (this.operations.size >= this.limits.maxPending)
      throw new RelayError(429, "Too many account sign-in requests");
    const operationId = randomUUID(),
      ticket = randomBytes(32).toString("base64url"),
      salt = randomBytes(32).toString("base64url");
    const googleNonce = googleProofNonce(salt, parsed.data.nonce);
    const expiresAt = this.now() + this.limits.ttlMs;
    this.operations.set(operationId, {
      intent: Object.freeze(parsed.data),
      ticketHash: digest(ticket),
      salt,
      googleNonce,
      expiresAt,
      phase: "ready",
    });
    return { operationId, ticket, salt, googleNonce, expiresAt };
  }

  /** The binding is opaque to the native authenticator and never an account-management session. */
  binding(id: string, ticket: string): string {
    if (this.current(id, ticket).phase !== "ready")
      throw new RelayError(409, "Native sign-in is already in progress");
    return createHash("sha256")
      .update(JSON.stringify(["omnesis-native-passkey-binding-v3", id, ticket]))
      .digest("base64url");
  }

  /** What a passkey signs: the device recomputes this before it prompts, and so does the gateway. */
  commitment(id: string, ticket: string): ProofCommitment {
    const operation = this.current(id, ticket);
    return {
      salt: operation.salt,
      issuedAt: String(Math.floor(this.now() / 1000)),
      nonce: operation.intent.nonce,
    };
  }

  async complete<T>(
    id: string,
    ticket: string,
    verifier: string,
    authenticate: (context: {
      intent: NativeAccountIntent;
      googleNonce: string;
      expiresAt: number;
      current(): void;
    }) => Promise<T>,
  ): Promise<T> {
    const operation = this.current(id, ticket);
    const parsed = verifierSchema.safeParse(verifier);
    if (
      !parsed.success ||
      !safeEqual(operation.intent.challenge, digest(parsed.data).toString("base64url"))
    )
      throw new RelayError(403, "Native sign-in verification refused");
    if (operation.phase !== "ready")
      throw new RelayError(409, "Native sign-in is already in progress");
    operation.phase = "verifying";
    const current = () => {
      if (this.closed || this.operations.get(id) !== operation || operation.expiresAt <= this.now())
        throw new RelayError(400, "Native sign-in expired or was cancelled");
    };
    try {
      const value = await authenticate({
        intent: operation.intent,
        googleNonce: operation.googleNonce,
        expiresAt: operation.expiresAt,
        current,
      });
      current();
      return value;
    } finally {
      if (this.operations.get(id) === operation) this.operations.delete(id);
    }
  }

  cancel(id: string, ticket: string): void {
    this.current(id, ticket);
    this.operations.delete(id);
  }
  close(): void {
    this.closed = true;
    this.operations.clear();
  }

  private current(id: string, ticket: string): Operation {
    if (this.closed) throw new RelayError(503, "Account sign-in is unavailable");
    this.prune();
    const operation = this.operations.get(id);
    if (
      !operation ||
      !/^[A-Za-z0-9_-]{43}$/.test(ticket) ||
      !timingSafeEqual(operation.ticketHash, digest(ticket))
    )
      throw new RelayError(403, "Native sign-in request is unavailable");
    return operation;
  }
  private prune(): void {
    for (const [id, operation] of this.operations)
      if (operation.expiresAt <= this.now()) this.operations.delete(id);
  }
}
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
function safeEqual(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
