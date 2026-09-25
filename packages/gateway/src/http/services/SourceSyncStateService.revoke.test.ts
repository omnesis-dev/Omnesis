// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AccountId, SourceType } from "@omnesis/types";
import { createDatabase, getSyncState, setSyncError } from "../../db.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createSource } from "../../data/repositories/SourceRepository.js";
import { SourceWriteEpochFence } from "../../source-write-epoch-fence.js";
import { directWriteGate, type WriteGate } from "../../write-gate.js";
import { SourceSyncStateService } from "./SourceSyncStateService.js";
import type Database from "better-sqlite3";

describe("SourceSyncStateService attempt revocation", () => {
  let sqlite: Database.Database;
  let sqlitePath: string;
  let gate: WriteGate;

  beforeEach(() => {
    sqlitePath = `/tmp/omnesis-test-${randomUUID()}.db`;
    sqlite = createDatabase(sqlitePath);
    gate = directWriteGate(sqlite);
  });

  afterEach(() => {
    sqlite.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      if (existsSync(sqlitePath + suffix)) unlinkSync(sqlitePath + suffix);
    }
  });

  function seedSource(): string {
    const device = createDevice(sqlite, { name: "fictional-collector", kind: "collector" });
    const source = createSource(sqlite, {
      type: SourceType("fictional-calendar"),
      accountId: AccountId("fictional-calendar-account"),
      deviceId: device.id,
    });
    return source.id;
  }

  function service(fence: SourceWriteEpochFence): SourceSyncStateService {
    return new SourceSyncStateService({
      db: sqlite,
      writeGate: gate,
      sourceWriteEpochFence: fence,
    });
  }

  test("a timed-out sync revoked after a gateway restart cannot commit its in-flight page", async () => {
    const sourceId = seedSource();
    const attemptId = randomUUID();
    const epoch = await service(new SourceWriteEpochFence()).beginAttempt(sourceId, attemptId);
    expect(epoch).toBe(1);

    // The sync hits its wall-clock timeout. The collector records the failure
    // and revokes the attempt's write authority — but the gateway restarted
    // in the meantime, so it holds no in-memory record of the claim and the
    // epoch the collector supplies is the only one left.
    setSyncError(sqlite, sourceId, "Sync timed out after 60m");
    const restarted = service(new SourceWriteEpochFence());
    await expect(restarted.revokeAttempt(sourceId, epoch, attemptId)).resolves.toBe(true);

    // The abandoned attempt's page lands late: it must not clear the persisted
    // error or stamp a fresh successful sync.
    await expect(restarted.setLegacyState(sourceId, { page: "2" }, {}, epoch)).resolves.toBe(false);
    const state = getSyncState(sqlite, sourceId);
    expect(state?.last_error).toBe("Sync timed out after 60m");
    expect(state?.last_synced_at).toBeNull();
  });
});
