// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join as fixtureJoin } from "node:path";
import { tmpdir as fixtureTmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SCOPE_ADMIN } from "@omnesis/types";
import { createFreshTestDatabase } from "../testing/fresh-database.js";
import { createDevice, replaceDeviceForRepair } from "./repositories/DeviceRepository.js";
import { createToken } from "./repositories/TokenRepository.js";
import {
  STALE_PAIRING_WRITE_ERROR,
  withPairingGenerationFence,
} from "./pairing-generation-fence.js";
import type { createDatabase } from "../db.js";

let dbPath: string;
let db: ReturnType<typeof createDatabase>;

beforeEach(() => {
  dbPath = fixtureJoin(fixtureTmpdir(), `omnesis-pairing-fence-test-${randomUUID()}.db`);
  db = createFreshTestDatabase(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

describe("pairing generation writer fence", () => {
  test("commits a mutation under the active generation", () => {
    const device = createDevice(db, { name: "fictional-phone", kind: "ios" });
    const generation = createToken(db, device.id, [SCOPE_ADMIN]);

    withPairingGenerationFence(db, { deviceId: device.id, tokenId: generation.id }, () =>
      db.prepare("UPDATE devices SET name = ? WHERE id = ?").run("renamed-phone", device.id),
    );

    expect(db.prepare("SELECT name FROM devices WHERE id = ?").get(device.id)).toEqual({
      name: "renamed-phone",
    });
  });

  test("rejects and rolls back a mutation after repair rotated the token", () => {
    const device = createDevice(db, { name: "fictional-phone", kind: "ios" });
    const oldGeneration = createToken(db, device.id, [SCOPE_ADMIN]);
    replaceDeviceForRepair(db, device.id, { name: device.name, kind: device.kind });
    createToken(db, device.id, [SCOPE_ADMIN]);

    expect(() =>
      withPairingGenerationFence(db, { deviceId: device.id, tokenId: oldGeneration.id }, () =>
        db.prepare("UPDATE devices SET name = ? WHERE id = ?").run("stale-write", device.id),
      ),
    ).toThrow(STALE_PAIRING_WRITE_ERROR);
    expect(db.prepare("SELECT name FROM devices WHERE id = ?").get(device.id)).toEqual({
      name: "fictional-phone",
    });
  });
});
