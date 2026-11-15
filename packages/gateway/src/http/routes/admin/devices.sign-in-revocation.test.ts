// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { defaultScopesForDeviceKind } from "@omnesis/types";
import { createDatabase } from "../../../db.js";
import {
  createPairing,
  getDevice,
  redeemDevicePairing,
} from "../../../data/repositories/DeviceRepository.js";
import { directWriteGate } from "../../../write-gate.js";
import { revokeDevicesJoinedWithSignIn } from "./devices.js";
import type Database from "better-sqlite3";
import type { DeviceId } from "@omnesis/types";

let db: Database.Database;
let path: string;

beforeEach(() => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  path = `/tmp/omnesis-sign-in-revocation-${randomUUID()}.db`;
  db = createDatabase(path);
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
});

function joined(signInId: string, key: string): DeviceId {
  const pending = createPairing(db, {
    kind: "cli",
    scopes: defaultScopesForDeviceKind("cli"),
    enrollment: { method: "automatic", signIn: "passkey", signInId, devicePublicKey: key },
  });
  const result = redeemDevicePairing(db, {
    pairingCode: pending.pairingCode,
    expectedKind: "cli",
    capabilities: { suggestedName: key },
  });
  if (result.outcome !== "paired") throw new Error(result.outcome);
  return result.device.id;
}

test("revokes, disconnects and releases every live device that joined with the sign-in, and nothing else", async () => {
  const first = joined("fictional-passkey", "key-one");
  const second = joined("fictional-passkey", "key-two");
  const other = joined("another-passkey", "key-three");
  const deps = {
    db,
    writeGate: directWriteGate(db),
    wsServer: { disconnectDevice: vi.fn() },
    sourceService: { releaseDeviceLeases: vi.fn(async () => undefined) },
    statusCache: { bump: vi.fn() },
  };
  const revoked = await revokeDevicesJoinedWithSignIn(deps as never, "fictional-passkey");
  expect(revoked).toEqual([first, second].sort());
  for (const id of revoked) {
    expect(getDevice(db, id)?.revokedAt).not.toBeNull();
    expect(deps.wsServer.disconnectDevice).toHaveBeenCalledWith(id);
    expect(deps.sourceService.releaseDeviceLeases).toHaveBeenCalledWith(id);
  }
  expect(getDevice(db, other)?.revokedAt).toBeNull();
  expect(deps.statusCache.bump).toHaveBeenCalledTimes(1);

  // Nothing left to revoke: nothing changes, and the status is left alone.
  expect(await revokeDevicesJoinedWithSignIn(deps as never, "fictional-passkey")).toEqual([]);
  expect(deps.statusCache.bump).toHaveBeenCalledTimes(1);
});

test("a device revoked meanwhile is skipped", async () => {
  const id = joined("fictional-passkey", "key-one");
  const deps = {
    db,
    writeGate: { revokeDevice: vi.fn(async () => false) },
    sourceService: { releaseDeviceLeases: vi.fn() },
    statusCache: { bump: vi.fn() },
  };
  expect(await revokeDevicesJoinedWithSignIn(deps as never, "fictional-passkey")).toEqual([]);
  expect(deps.writeGate.revokeDevice).toHaveBeenCalledWith(id);
  expect(deps.sourceService.releaseDeviceLeases).not.toHaveBeenCalled();
  expect(deps.statusCache.bump).not.toHaveBeenCalled();
});
