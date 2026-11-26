// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AccountId, SourceId, SourceType, type SyncRemediation } from "@omnesis/types";
import { createDatabase } from "./db.js";
import { createFreshTestDatabase } from "./testing/fresh-database.js";
import { createDevice } from "./data/repositories/DeviceRepository.js";
import { addSourceMember, createSourceWithId } from "./data/repositories/SourceRepository.js";
import {
  clearSyncError,
  listSyncStateSummaries,
  setSyncError,
} from "./data/repositories/SyncStateRepository.js";
import { deriveDisplayStatus, SyncStatusRegistry } from "./sync-status.js";

test("a shared-cursor access refusal survives restart only for its authenticated reporter until recovery", () => {
  const directory = mkdtempSync(join(tmpdir(), "omnesis-permission-retry-"));
  const path = join(directory, "gateway.db");
  let db = createFreshTestDatabase(path);
  try {
    const device = createDevice(db, { name: "Invented collecting computer", kind: "collector" });
    const sibling = createDevice(db, { name: "Invented sibling computer", kind: "collector" });
    const sourceId = SourceId("example-source:local");
    createSourceWithId(db, sourceId, {
      type: SourceType("example-source"),
      accountId: AccountId("local"),
      deviceId: device.id,
      multiDeviceMode: "handoff",
    });
    expect(addSourceMember(db, sourceId, sibling.id)).toBe(true);
    const remedy: SyncRemediation = {
      summary: "Allow selected folder access",
      steps: ["Review source access."],
      restartRequired: false,
      access: {
        status: "denied",
        checkedAt: "2026-01-01T00:00:00.000Z",
        scopeDigest: "a".repeat(64),
        target: "unverified",
      },
    };
    setSyncError(db, sourceId, "invented-private-detail", "", remedy, device.id);
    db.close();
    db = createDatabase(path);
    const registry = new SyncStatusRegistry();
    registry.update({ sourceId, deviceId: device.id, state: "syncing", lastUpdated: Date.now() });
    const row = listSyncStateSummaries(db).find((value) => value.source_id === sourceId)!;
    expect(row).toMatchObject({ device_id: "", last_error_device_id: device.id });
    const retry = deriveDisplayStatus(sourceId, registry.get(sourceId), row, { enabled: true });
    expect(retry).toMatchObject({
      remediation: remedy,
      errorMessage: "Collection access is blocked on this computer",
    });
    expect(JSON.stringify(retry)).not.toContain("invented-private-detail");
    for (const reporter of [sibling.id, undefined]) {
      setSyncError(db, sourceId, "invented-other-detail", "", remedy, reporter);
      const different = listSyncStateSummaries(db).find((value) => value.source_id === sourceId)!;
      expect(different.last_error_device_id).toBe(reporter ?? null);
      expect(
        deriveDisplayStatus(sourceId, registry.get(sourceId), different, { enabled: true })
          .remediation,
      ).toBeUndefined();
    }
    const legacyRetry = { sourceId, state: "syncing" as const, lastUpdated: Date.now() };
    const unattributed = listSyncStateSummaries(db).find((value) => value.source_id === sourceId)!;
    expect(unattributed.last_error_device_id).toBeNull();
    for (const legacyRow of [unattributed, { ...unattributed, last_error_device_id: undefined }]) {
      expect(
        deriveDisplayStatus(sourceId, legacyRetry, legacyRow, { enabled: true }).remediation,
      ).toBeUndefined();
    }
    registry.update({ sourceId, deviceId: device.id, state: "completed", lastUpdated: Date.now() });
    clearSyncError(db, sourceId, "");
    const recovered = listSyncStateSummaries(db).find((value) => value.source_id === sourceId)!;
    expect(
      deriveDisplayStatus(sourceId, registry.get(sourceId), recovered, { enabled: true })
        .remediation,
    ).toBeUndefined();
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
