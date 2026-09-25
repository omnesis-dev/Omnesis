// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { getDevice, listDevices } from "../../data/repositories/DeviceRepository.js";
import { deviceIdForToken, listTokens } from "../../data/repositories/TokenRepository.js";
import type Database from "better-sqlite3";
import type { DeviceId, DeviceRecord, Scope, TokenId } from "@omnesis/types";

/** The identity a request authenticated as, as the auth middleware parses it. */
export interface RequestIdentity {
  tokenId: TokenId | null;
  deviceId: DeviceId | null;
  scopes: readonly Scope[];
}

/** Resolved caller identity, as `/whoami` and the doctor's auth section report it. */
export interface WhoAmI {
  tokenId: TokenId | null;
  deviceId: DeviceId | null;
  deviceName: string | null;
  scopes: Scope[];
}

type Db = Database.Database;

/**
 * Read-side device + token lookups (routes only call services).
 *
 * Thin façade over `DeviceRepository` + `TokenRepository` so admin/
 * routes (devices.ts, sources.ts, tokens.ts) and routes/status.ts
 * don't import the repositories directly. Write paths still go through
 * `WriteGate` (the writer-worker boundary); reads land here.
 */
export class DeviceService {
  constructor(private readonly db: Db) {}

  getById(id: DeviceId): DeviceRecord | null {
    return getDevice(this.db, id);
  }

  /** Names are unique per gateway; revoked rows keep theirs. */
  listDevices(): DeviceRecord[] {
    return listDevices(this.db);
  }

  listTokens(deviceId?: DeviceId) {
    return listTokens(this.db, deviceId);
  }

  /**
   * Resolve who a request authenticated as.
   *
   * A token does not always carry its device on the auth context (a portal
   * session doesn't resolve one), so an unset `deviceId` falls back to the
   * device the token was issued to — that fallback is what lets the portal
   * pin its "This device" card. A session with no device at all resolves to
   * nulls rather than an error; callers report that as its own state.
   *
   * `/whoami` and the doctor's auth section both read identity through
   * here, so the two can't drift into disagreeing about the same request.
   */
  resolveWhoAmI(auth: RequestIdentity): WhoAmI {
    const deviceId =
      auth.deviceId ?? (auth.tokenId ? deviceIdForToken(this.db, auth.tokenId) : null);
    return {
      tokenId: auth.tokenId,
      deviceId,
      deviceName: deviceId ? (this.getById(deviceId)?.name ?? null) : null,
      scopes: [...auth.scopes],
    };
  }
}
