// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import {
  SCOPE_SUBSCRIPTIONS_RECEIVE,
  type DeviceCapability,
  type DeviceId,
  type DeviceKind,
  type DeviceRecord,
  type Scope,
  type TokenId,
} from "@omnesis/types";
import {
  findDeviceByName,
  type AgentPairingConflictCode,
  getDevice,
  listDevices,
  peekPairing,
  resolveDeviceName,
  type PendingPairing,
} from "../../data/repositories/DeviceRepository.js";
import {
  isStalePairingWriteError,
  type PairingGenerationFence,
} from "../../data/pairing-generation-fence.js";
import { lookupAgentPairingCredential } from "../../data/repositories/TokenRepository.js";
import { HttpError } from "../errors.js";
import type { WriteGate } from "../../write-gate.js";
import type Database from "better-sqlite3";
import type { DeviceWsServer } from "../../ws.js";
import type { SourceService } from "./SourceService.js";
import type { StatusCache } from "./StatusCache.js";

type Db = Database.Database;

const log = createLogger("gateway:http").child("pairing");

interface PairedCredential {
  tokenId: TokenId;
  token: string;
  scopes: Scope[];
}

export type PairingServiceResult =
  | {
      outcome: "paired-agent";
      device: DeviceRecord;
      /** True when the pairing landed on an existing device rather than creating one. */
      reconnected: boolean;
      credentials: {
        delivery: PairedCredential;
        ingestion: PairedCredential;
        management: PairedCredential;
      };
    }
  | {
      outcome: "paired-device";
      device: DeviceRecord;
      tokenId: TokenId;
      token: string;
      scopes: Scope[];
    }
  | { outcome: "invalid"; error: string }
  | { outcome: "conflict"; error: string; code?: AgentPairingConflictCode };

export interface PairingServiceDeps {
  db: Db;
  writeGate: WriteGate;
  statusCache: Pick<StatusCache, "bump">;
  sourceService: Pick<SourceService, "clearRemovedForDeviceTypes">;
  wsServer?: Pick<DeviceWsServer, "isConnected" | "disconnectDevice">;
  now?: () => number;
}

export interface PairingServiceInput {
  pairingCode: string;
  capabilities?: DeviceCapability;
  agentIntegration?: { harness: "openclaw" | "hermes" };
  /**
   * A credential the redeeming agent host still holds for the device it is
   * already connected as. Presenting it is how a harness reconnects to its own
   * device without an explicitly bound repair code.
   */
  continuityCredential?: string;
  idempotencyKey?: string;
}

/**
 * Owns pairing-code redemption and all post-commit credential hygiene.
 *
 * HTTP routes intentionally do not coordinate repository reads, writer
 * transactions, source tombstones, or live sockets. Keeping that sequence
 * here makes the security invariant explicit: after a repair commits, every
 * socket authenticated with an old credential is evicted before the new
 * credentials leave the gateway.
 */
export class PairingService {
  constructor(private readonly deps: PairingServiceDeps) {}

  /**
   * Fence a durable mobile mutation to the exact pairing that created it.
   * The header is optional for older clients and operator sessions. When it
   * is present, both its identity and its continued existence are checked:
   * repairing a device deletes the old token row even when it adopts the same
   * durable device id.
   */
  pairingGenerationFence(
    generation: string | undefined,
    auth: { tokenId: TokenId | null; deviceId: DeviceId | null },
  ): PairingGenerationFence | undefined {
    if (generation === undefined) return undefined;
    if (!auth.tokenId || !auth.deviceId || generation !== auth.tokenId) {
      throw new HttpError(
        409,
        "STALE_PAIRING",
        "This request belongs to an older pairing. Reconnect and try again.",
      );
    }
    return { tokenId: auth.tokenId, deviceId: auth.deviceId };
  }

  static translateStaleGeneration(error: unknown): never {
    if (isStalePairingWriteError(error)) {
      throw new HttpError(
        409,
        "STALE_PAIRING",
        "This request belongs to an older pairing. Reconnect and try again.",
      );
    }
    throw error;
  }

  /** The device kind of a pending, unexpired pairing code; null for any other code. */
  pendingPairingKind(pairingCode: string): DeviceKind | null {
    const pending = peekPairing(this.deps.db, pairingCode);
    if (!pending || pending.expiresAt < (this.deps.now?.() ?? Date.now())) return null;
    return pending.kind;
  }

  async redeem(input: PairingServiceInput): Promise<PairingServiceResult> {
    const { db, writeGate: w } = this.deps;
    const preview = peekPairing(db, input.pairingCode);
    // A code that is gone or expired can still be the SAME request coming
    // back with its idempotency key after a lost response; the writer answers
    // that from the redemption receipt. Anything else is simply invalid.
    if (
      (!preview || preview.expiresAt < (this.deps.now?.() ?? Date.now())) &&
      !input.idempotencyKey
    ) {
      return { outcome: "invalid", error: "invalid or expired pairing code" };
    }

    if (preview?.kind === "agent" || (!preview && input.agentIntegration && input.idempotencyKey)) {
      return this.redeemAgent(input, preview);
    }
    if (input.agentIntegration || input.continuityCredential) {
      return {
        outcome: "invalid",
        error: "agent integration identity requires an agent pairing code",
      };
    }

    const result = await w.redeemDevicePairing({
      pairingCode: input.pairingCode,
      ...(preview ? { expectedKind: preview.kind } : {}),
      capabilities: input.capabilities ?? {},
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      onlineDeviceIds: this.deps.wsServer
        ? listDevices(db)
            .filter((device) => this.deps.wsServer!.isConnected(device.id))
            .map((device) => device.id)
        : [],
    });
    if (result.outcome === "invalid") {
      return { outcome: "invalid", error: "invalid or expired pairing code" };
    }
    if (result.outcome === "conflict") return result;

    const { device, tokenId, token } = result;
    if (result.replayed) {
      // The first attempt already did the post-commit work; a replay only
      // re-delivers the response it lost.
      log.info(`Device pairing replayed: ${device.name} (${device.kind}) id=${device.id}`);
      return { outcome: "paired-device", device, tokenId, token, scopes: result.scopes };
    }

    if (result.replacedDeviceId) {
      this.deps.wsServer?.disconnectDevice(result.replacedDeviceId);
    }

    const writeTypes = result.scopes
      .filter((scope) => scope.startsWith("write:") && scope !== "write:*")
      .map((scope) => scope.slice("write:".length));
    await this.clearRemovedBestEffort(writeTypes);

    this.deps.statusCache.bump();
    log.info(`Device paired: ${device.name} (${device.kind}) id=${device.id}`);
    return { outcome: "paired-device", device, tokenId, token, scopes: result.scopes };
  }

  private async redeemAgent(
    input: PairingServiceInput,
    pending: PendingPairing | null,
  ): Promise<PairingServiceResult> {
    const identity = input.agentIntegration;
    const capabilities = input.capabilities;
    if (!identity || !capabilities || capabilities.agentIntegration?.harness !== identity.harness) {
      return { outcome: "invalid", error: "agent integration identity is required" };
    }
    if (
      pending &&
      (pending.scopes.length !== 1 || pending.scopes[0] !== SCOPE_SUBSCRIPTIONS_RECEIVE)
    ) {
      return {
        outcome: "invalid",
        error: "agent integration pairing codes must grant only subscriptions:receive",
      };
    }

    // A spent code is either a replay the writer answers from its receipt or
    // invalid; either way there is nothing left to decide here.
    const claimed = pending ? this.claimedAgentDevice(input.continuityCredential, identity) : null;
    const bound = pending?.repairDeviceId ? getDevice(this.deps.db, pending.repairDeviceId) : null;
    if (pending?.repairDeviceId && !bound) {
      return { outcome: "conflict", error: "The selected repair device no longer exists." };
    }
    if (
      bound &&
      (bound.kind !== "agent" || bound.capabilities.agentIntegration?.harness !== identity.harness)
    ) {
      return {
        outcome: "conflict",
        error: "The selected repair device belongs to a different agent integration.",
      };
    }
    if (bound && claimed && claimed.device.id !== bound.id) {
      return {
        outcome: "conflict",
        code: "AGENT_DEVICE_MISMATCH",
        error: `This pairing code reconnects "${bound.name}", but this machine is connected as "${claimed.device.name}".`,
      };
    }

    // The device this redemption lands on: the one the administrator bound the
    // code to, or else the one this host proved it is already connected as. A
    // suggested name alone never selects an existing device — it is
    // caller-controlled, so it would let any holder of a fresh code take over
    // whichever device carries that name.
    const repairTarget = bound ?? claimed?.device ?? null;
    const resolvedName = pending
      ? (repairTarget?.name ?? resolveDeviceName(pending.name, "agent", capabilities))
      : null;
    const existing = resolvedName ? findDeviceByName(this.deps.db, resolvedName) : null;
    if (repairTarget && existing?.id !== repairTarget.id) {
      return { outcome: "conflict", error: "The selected repair device changed." };
    }
    if (!repairTarget && existing) {
      return {
        outcome: "conflict",
        code: "AGENT_DEVICE_EXISTS",
        error: `Device name "${resolvedName}" already exists. Reconnect it with a pairing code bound to that device, or pick a different name.`,
      };
    }
    // A live socket is refused only to a host that proved nothing: the proven
    // holder is the very installation behind that socket, reinstalling itself,
    // and its old sockets are evicted once the new credentials commit.
    if (repairTarget && !claimed && this.deps.wsServer?.isConnected(repairTarget.id)) {
      return {
        outcome: "conflict",
        code: "AGENT_DEVICE_ONLINE",
        error: `The agent device "${resolvedName}" is currently online and cannot be repaired.`,
      };
    }

    const paired = await this.deps.writeGate.redeemAgentIntegrationPairing({
      pairingCode: input.pairingCode,
      harness: identity.harness,
      capabilities,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(repairTarget ? { repairDeviceId: repairTarget.id } : {}),
      ...(claimed ? { continuityTokenId: claimed.tokenId } : {}),
    });
    if (paired.outcome !== "paired") return paired;
    const reconnected = paired.reconnected;

    // `disconnectDevice` removes authorization state synchronously. If an old
    // credential authenticated after the preflight check but before the
    // writer transaction committed, it cannot survive this point.
    if (repairTarget && !paired.replayed) this.deps.wsServer?.disconnectDevice(repairTarget.id);

    if (!paired.replayed) {
      await this.clearRemovedBestEffort([identity.harness]);
      this.deps.statusCache.bump();
      log.info(
        `Agent integration ${reconnected ? "reconnected" : "paired"}: ${paired.device.name} (${identity.harness}) id=${paired.device.id}${claimed ? " by its own credential" : ""}`,
      );
    }

    const credential = (entry: (typeof paired.credentials)["delivery"]): PairedCredential => ({
      tokenId: entry.id,
      token: entry.token,
      scopes: entry.scopes,
    });
    return {
      outcome: "paired-agent",
      device: paired.device,
      reconnected,
      credentials: {
        delivery: credential(paired.credentials.delivery),
        ingestion: credential(paired.credentials.ingestion),
        management: credential(paired.credentials.management),
      },
    };
  }

  /**
   * The agent device a presented credential proves this host is connected as,
   * or null when it proves nothing: absent, unknown, not one of the standing
   * credentials agent pairing mints, or belonging to a device that is not this
   * harness's agent. An unproven claim is not an error — the redemption simply
   * proceeds as a host with no prior device.
   */
  private claimedAgentDevice(
    credential: string | undefined,
    identity: { harness: "openclaw" | "hermes" },
  ): { device: DeviceRecord; tokenId: TokenId } | null {
    if (!credential) return null;
    const token = lookupAgentPairingCredential(this.deps.db, credential, identity.harness);
    const device = token ? getDevice(this.deps.db, token.deviceId) : null;
    if (
      !token ||
      !device ||
      device.revokedAt !== null ||
      device.kind !== "agent" ||
      device.capabilities.agentIntegration?.harness !== identity.harness
    ) {
      log.warn(`Agent pairing presented a credential that proves no ${identity.harness} device`);
      return null;
    }
    return { device, tokenId: token.id };
  }

  private async clearRemovedBestEffort(sourceTypes: readonly string[]): Promise<void> {
    try {
      await this.deps.sourceService.clearRemovedForDeviceTypes(sourceTypes);
    } catch (error) {
      // Pairing credentials are one-time secrets. Once committed, ancillary
      // tombstone cleanup must never turn a successful redemption into an HTTP
      // failure that discards those secrets from the caller's perspective.
      log.warn(
        `Post-pair source cleanup failed for ${sourceTypes.join(",") || "no source types"}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
