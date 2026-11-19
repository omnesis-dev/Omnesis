// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Collectors that ask to join from one of the owner's own Tailscale devices.
 *
 * Tailscale vouches for whose machine the request comes from; the owner's
 * join policy decides what happens next. "automatic" admits the collector at
 * once. "ask" holds the request until the owner approves it on a phone or in
 * the portal. "off" refuses it, so the collector pairs with a code as before.
 *
 * Admission never writes a device directly: it mints an ordinary one-use
 * pairing code for a collector and redeems it through the same path every
 * pairing takes, at the moment the collector comes to collect its
 * credentials. A held request that nobody collects creates nothing.
 *
 * Requests live in memory for ten minutes. A restart forgets them, and the
 * collector simply asks again.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  assertNever,
  tailscaleNodeIdentity,
  type TailscaleJoinPolicy,
  type TailscaleJoinRequest,
} from "@omnesis/core";
import type { DeviceCapability, DeviceId, Scope, TokenId } from "@omnesis/types";
import type { TailnetPeer } from "./caller.js";

export const JOIN_REQUEST_TTL_MS = 10 * 60 * 1000;
/** Requests waiting at once, across all devices. */
export const MAX_WAITING = 16;
/** Requests waiting at once from one tailnet device. */
export const MAX_WAITING_PER_NODE = 2;

/** What a joining collector receives: the same answer a pairing redemption gives. */
export interface JoinCredentials {
  device: { id: DeviceId; name: string; kind: "collector" };
  tokenId: TokenId;
  token: string;
  scopes: Scope[];
}

export type RedeemResult =
  { outcome: "paired-device"; credentials: JoinCredentials } | { outcome: "failed"; error: string };

/** The identity a Tailscale device proves to the gateway: its stable node id. */
function tailnetDeviceIdentity(peer: TailnetPeer): string {
  return tailscaleNodeIdentity(peer.nodeId);
}

export interface JoinRequestDeps {
  /**
   * Admit the collector proving `identity`. `approved` says the owner said yes;
   * see PairingService.admitProvenCollector.
   */
  admit(input: {
    identity: string;
    approved: boolean;
    capabilities: DeviceCapability;
  }): Promise<RedeemResult>;
  /**
   * When the owner last revoked a device proving this identity, or null. Such
   * a machine waits for the owner even when joins are automatic, and an
   * approval given before that revocation no longer counts.
   */
  revokedAt(identity: string): number | null;
  /** Tell the owner's phones a request is waiting. */
  notifyWaiting(request: JoinRequestView): void;
  /** Tell the owner's phones a collector joined with nobody approving it. */
  notifyJoined(device: { id: DeviceId; name: string }): void;
  /**
   * The requests waiting for the owner changed: one arrived or was decided.
   * Lapsing is not reported; each request carries its own expiry.
   */
  onWaitingChanged?(): void;
  now?: () => number;
}

/** A waiting request as the owner sees it. */
export type JoinRequestView = TailscaleJoinRequest;

interface JoinRequest {
  id: string;
  secretHash: Buffer;
  peer: TailnetPeer;
  name: string;
  capabilities: DeviceCapability;
  requestedAt: number;
  expiresAt: number;
  state: "waiting" | "approved" | "denied" | "joined";
  /** Set while an approved request is being redeemed, so two polls redeem once. */
  admitting?: Promise<RedeemResult>;
  /** When the owner approved it. */
  approvedAt?: number;
}

export type JoinOutcome =
  | { status: "joined"; credentials: JoinCredentials }
  | { status: "pending"; requestId: string; secret: string; expiresAt: string }
  | { status: "refused"; code: JoinRefusal; message: string };

export type JoinRefusal = "not-owner" | "joining-off" | "too-many-requests" | "join-failed";

export type PollOutcome =
  | { status: "pending"; expiresAt: string }
  | { status: "joined"; credentials: JoinCredentials }
  | { status: "denied" }
  | { status: "gone" }
  | { status: "failed"; message: string };

function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/** The machine's short name: the first label of its tailnet name. */
function machineName(peer: TailnetPeer): string {
  return peer.nodeName.split(".")[0] || peer.nodeName;
}

export class TailscaleJoinRequests {
  private readonly requests = new Map<string, JoinRequest>();

  constructor(private readonly deps: JoinRequestDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, request] of this.requests) {
      if (request.expiresAt <= now) this.requests.delete(id);
    }
  }

  /** Waiting requests, oldest first. */
  list(): JoinRequestView[] {
    this.sweep();
    return [...this.requests.values()]
      .filter((r) => r.state === "waiting")
      .sort((a, b) => a.requestedAt - b.requestedAt)
      .map((r) => this.view(r));
  }

  /**
   * A collector on the owner's tailnet asks to join. `peer` is what Tailscale
   * said about the calling machine; only the owner's own untagged devices get
   * past the first check.
   */
  async request(input: {
    peer: TailnetPeer | undefined;
    policy: TailscaleJoinPolicy;
    /** The collector's name; its machine's name when it gives none. */
    name?: string;
    capabilities: DeviceCapability;
  }): Promise<JoinOutcome> {
    this.sweep();
    const peer = input.peer;
    if (!peer?.sameOwner) {
      return {
        status: "refused",
        code: "not-owner",
        message:
          "Only the gateway owner's own Tailscale devices can join this way. Pair this collector with a pairing code instead.",
      };
    }
    if (input.policy === "off") {
      return {
        status: "refused",
        code: "joining-off",
        message:
          "Joining through Tailscale is turned off on this gateway. Pair this collector with a pairing code instead.",
      };
    }
    const name = input.name ?? machineName(peer);
    const capabilities: DeviceCapability = {
      ...input.capabilities,
      suggestedName: name,
    };
    const identity = tailnetDeviceIdentity(peer);
    // A machine whose device the owner revoked asks again, whatever the policy.
    if (input.policy === "automatic" && this.deps.revokedAt(identity) === null) {
      const result = await this.admit({ identity, approved: false, capabilities });
      if (result.outcome === "failed") {
        return { status: "refused", code: "join-failed", message: result.error };
      }
      this.deps.notifyJoined(result.credentials.device);
      return { status: "joined", credentials: result.credentials };
    }

    const waiting = [...this.requests.values()].filter((r) => r.state === "waiting");
    if (
      waiting.length >= MAX_WAITING ||
      waiting.filter((r) => r.peer.nodeId === peer.nodeId).length >= MAX_WAITING_PER_NODE
    ) {
      return {
        status: "refused",
        code: "too-many-requests",
        message:
          "Too many join requests are waiting. Approve or deny them first, or wait ten minutes.",
      };
    }
    const now = this.now();
    const secret = randomBytes(32).toString("base64url");
    const request: JoinRequest = {
      id: randomUUID(),
      secretHash: hashSecret(secret),
      peer,
      name,
      capabilities,
      requestedAt: now,
      expiresAt: now + JOIN_REQUEST_TTL_MS,
      state: "waiting",
    };
    this.requests.set(request.id, request);
    this.deps.notifyWaiting(this.view(request));
    this.deps.onWaitingChanged?.();
    return {
      status: "pending",
      requestId: request.id,
      secret,
      expiresAt: new Date(request.expiresAt).toISOString(),
    };
  }

  /** The owner's decision; false when the request is gone or already decided. */
  decide(id: string, approve: boolean): boolean {
    this.sweep();
    const request = this.requests.get(id);
    if (!request || request.state !== "waiting") return false;
    request.state = approve ? "approved" : "denied";
    if (approve) request.approvedAt = this.now();
    this.deps.onWaitingChanged?.();
    return true;
  }

  /**
   * The collector checks on its request. It must present the secret it was
   * given and come from the same tailnet device that asked. An approved
   * request is redeemed here, once; the credentials are handed out on that
   * poll and the request is then forgotten.
   */
  async poll(input: {
    id: string;
    secret: string;
    peer: TailnetPeer | undefined;
  }): Promise<PollOutcome> {
    this.sweep();
    const request = this.requests.get(input.id);
    if (!request || !input.peer || input.peer.nodeId !== request.peer.nodeId)
      return { status: "gone" };
    if (!timingSafeEqual(hashSecret(input.secret), request.secretHash)) return { status: "gone" };
    switch (request.state) {
      case "waiting":
        return { status: "pending", expiresAt: new Date(request.expiresAt).toISOString() };
      case "denied":
        this.requests.delete(request.id);
        return { status: "denied" };
      case "joined":
        return { status: "gone" };
      case "approved": {
        const identity = tailnetDeviceIdentity(request.peer);
        const revokedAt = this.deps.revokedAt(identity);
        if (
          request.admitting === undefined &&
          revokedAt !== null &&
          revokedAt >= request.approvedAt!
        ) {
          // The owner removed this machine's device after saying yes.
          this.requests.delete(request.id);
          request.state = "denied";
          return { status: "denied" };
        }
        request.admitting ??= this.admit({
          identity,
          approved: true,
          capabilities: request.capabilities,
        });
        const result = await request.admitting;
        // Two polls may wait on the same redemption; only the first hands
        // the credentials out.
        if (request.state !== "approved") return { status: "gone" };
        this.requests.delete(request.id);
        if (result.outcome === "failed") {
          request.state = "denied";
          return { status: "failed", message: result.error };
        }
        request.state = "joined";
        return { status: "joined", credentials: result.credentials };
      }
      default:
        return assertNever(request.state);
    }
  }

  /** Admit, reporting any failure as an outcome rather than a rejection. */
  private admit(input: Parameters<JoinRequestDeps["admit"]>[0]): Promise<RedeemResult> {
    return this.deps.admit(input).catch((err: unknown) => ({
      outcome: "failed" as const,
      error: `The gateway could not admit this collector: ${err instanceof Error ? err.message : String(err)}`,
    }));
  }

  private view(request: JoinRequest): JoinRequestView {
    return {
      id: request.id,
      name: request.name,
      kind: "collector",
      machine: machineName(request.peer),
      ...(request.peer.os ? { os: request.peer.os } : {}),
      login: request.peer.login,
      requestedAt: new Date(request.requestedAt).toISOString(),
      expiresAt: new Date(request.expiresAt).toISOString(),
    };
  }
}
