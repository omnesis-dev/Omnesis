// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DeviceId } from "@omnesis/types";

export interface SyncLeaseGrant {
  granted: true;
  holder: DeviceId;
  expiresAt: number;
}

export interface SyncLeaseDenial {
  granted: false;
  /** `held`: another device's lease is live; `incumbent`: it lapsed, but its holder is online and preferred. */
  reason: "held" | "incumbent";
  holder: DeviceId;
  expiresAt: number;
}

export type SyncLeaseDecision = SyncLeaseGrant | SyncLeaseDenial;

/** Re-evaluated after write-fence admission; held stable through the commit. */
export interface SourcePageWriteAuthority {
  deletionAuthority: boolean;
  reconcileAuthority: boolean;
  resetReplicaCursors?: true;
}

export interface SyncLeaseHolder {
  deviceId: DeviceId;
  expiresAt: number;
  /** The lease lapsed without renewal; its holder is still the incumbent. */
  expired: boolean;
}

interface Lease {
  holder: DeviceId;
  expiresAt: number;
}

/**
 * The sync lease of sources that several devices host: one device syncs a
 * handoff source at a time, and one device is the deletion authority of a
 * replicated source. Leases live in memory — a gateway restart frees every
 * source, and the next tick claims it again — and expire without a timer:
 * a claim finds a lapsed lease and takes it over.
 *
 * On contention the incumbent is preferred: a lapsed lease whose holder is
 * still online is refused to others for one further window, so a device
 * that merely paused between pages keeps its warm caches and its half-done
 * bootstrap instead of handing them to a sibling.
 */
export class SyncLeaseRegistry {
  private readonly leases = new Map<string, Lease>();

  constructor(
    private readonly opts: {
      ttlMs: () => number;
      isOnline: (deviceId: DeviceId) => boolean;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Claim the lease for `deviceId`; a holder's claim renews it. */
  claim(sourceId: string, deviceId: DeviceId): SyncLeaseDecision {
    const now = this.now();
    const ttl = this.opts.ttlMs();
    const lease = this.leases.get(sourceId);
    if (lease && lease.holder === deviceId) {
      lease.expiresAt = now + ttl;
      return { granted: true, holder: deviceId, expiresAt: lease.expiresAt };
    }
    if (lease && lease.expiresAt > now) {
      return { granted: false, reason: "held", holder: lease.holder, expiresAt: lease.expiresAt };
    }
    if (lease && now < lease.expiresAt + ttl && this.opts.isOnline(lease.holder)) {
      return {
        granted: false,
        reason: "incumbent",
        holder: lease.holder,
        expiresAt: lease.expiresAt,
      };
    }
    const expiresAt = now + ttl;
    this.leases.set(sourceId, { holder: deviceId, expiresAt });
    return { granted: true, holder: deviceId, expiresAt };
  }

  /** Extend the holder's lease; false when `deviceId` does not hold it. */
  renew(sourceId: string, deviceId: DeviceId): boolean {
    const lease = this.leases.get(sourceId);
    if (!lease || lease.holder !== deviceId) return false;
    lease.expiresAt = this.now() + this.opts.ttlMs();
    return true;
  }

  /** Give the lease up; a released lease carries no incumbent preference. */
  release(sourceId: string, deviceId: DeviceId): boolean {
    const lease = this.leases.get(sourceId);
    if (!lease || lease.holder !== deviceId) return false;
    this.leases.delete(sourceId);
    return true;
  }

  holderOf(sourceId: string): SyncLeaseHolder | null {
    const lease = this.leases.get(sourceId);
    if (!lease) return null;
    return {
      deviceId: lease.holder,
      expiresAt: lease.expiresAt,
      expired: lease.expiresAt <= this.now(),
    };
  }

  /** Every lease a device holds is dropped — it left, was revoked, or was forgotten. */
  releaseAll(deviceId: DeviceId): void {
    for (const [sourceId, lease] of this.leases) {
      if (lease.holder === deviceId) this.leases.delete(sourceId);
    }
  }

  forgetSource(sourceId: string): void {
    this.leases.delete(sourceId);
  }
}
