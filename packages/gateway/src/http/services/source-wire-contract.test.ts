// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SOURCE_CONTRACT_WIRE_RANGE } from "@omnesis/core";
import { AccountId, SourceType, SCOPE_WRITE_ALL, type DeviceRecord } from "@omnesis/types";
import { createDatabase, getSyncState, getWipeEpoch, setSyncState } from "../../db.js";
import { createDevice, listDevices } from "../../data/repositories/DeviceRepository.js";
import {
  createSource,
  deleteSource,
  type SourceRecord,
} from "../../data/repositories/SourceRepository.js";
import {
  promoteSourceWireContract,
  sourceWireFloor,
} from "../../data/repositories/SourceWireContractRepository.js";
import { directWriteGate } from "../../write-gate.js";
import { SourceWriteEpochFence } from "../../source-write-epoch-fence.js";
import { SourceService } from "./SourceService.js";
import { SourceDataRemovalService } from "./SourceDataRemovalService.js";
import { SourceSyncStateService } from "./SourceSyncStateService.js";
import { AnalyticsService } from "./AnalyticsService.js";
import { DocumentService } from "./DocumentService.js";
import { EventService } from "./EventService.js";
import { StatusCache } from "./StatusCache.js";
import type Database from "better-sqlite3";
import type { AnalyticsDb } from "../../analytics-db.js";

let db: Database.Database;
let dir: string;
let modern: DeviceRecord;
let older: DeviceRecord;
let source: SourceRecord;
let service: SourceService;
let fence: SourceWriteEpochFence;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-wire-contract-"));
  db = createDatabase(join(dir, "test.db"));
  const type = SourceType("example-source");
  modern = createDevice(db, {
    name: "Fictional modern collector",
    kind: "collector",
    capabilities: {
      hostableSourceTypes: [type],
      memberScopedParams: { [type]: [] },
      sourceContract: SOURCE_CONTRACT_WIRE_RANGE,
    },
  });
  older = createDevice(db, { name: "Fictional older collector", kind: "collector" });
  source = createSource(db, { type, accountId: AccountId("local"), deviceId: modern.id });
  fence = new SourceWriteEpochFence();
  const writeGate = directWriteGate(db);
  service = new SourceService({
    db,
    writeGate,
    sourceWriteEpochFence: fence,
    statusCache: new StatusCache(db),
    sourceDataRemoval: new SourceDataRemovalService({
      db,
      writeGate,
      sourceWriteEpochFence: fence,
      purgeAnnotationsFor: async () => {},
    }),
    listDevices: () => listDevices(db),
    notifySourceChange: () => {},
    syncSourceSettingsToConfig: async () => {},
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("adoption retains cursors, fences every row once, and survives reopen", async () => {
  setSyncState(db, source.id, { bookmark: 7 });
  setSyncState(db, source.id, { bookmark: 9 }, undefined, undefined, false, undefined, older.id);
  await service.adoptSourceWireContract(source.id, { deviceId: modern.id });
  expect(sourceWireFloor(db, source.id)).toBe(1);
  expect(getSyncState(db, source.id)?.cursor).toBe('{"bookmark":7}');
  expect(getSyncState(db, source.id, older.id)?.cursor).toBe('{"bookmark":9}');
  expect(getWipeEpoch(db, source.id, "")).toBe(1);
  expect(getWipeEpoch(db, source.id, older.id)).toBe(1);
  await service.adoptSourceWireContract(source.id, { deviceId: modern.id });
  expect(getWipeEpoch(db, source.id, older.id)).toBe(1);
  db.close();
  db = createDatabase(join(dir, "test.db"));
  expect(sourceWireFloor(db, source.id)).toBe(1);
});

test("legacy untouched sources and phone sources are not promoted", async () => {
  const phone = createDevice(db, { name: "Fictional phone", kind: "ios" });
  const phoneSource = createSource(db, {
    type: SourceType("example-phone"),
    accountId: AccountId("local"),
    deviceId: phone.id,
  });
  await service.adoptSourceWireContract(phoneSource.id, { deviceId: phone.id });
  await service.adoptSourceWireContract(source.id, { deviceId: older.id });
  expect(sourceWireFloor(db, source.id)).toBe(0);
  expect(sourceWireFloor(db, phoneSource.id)).toBe(0);
  expect(() => service.sourceWireAuthority([source.id], { deviceId: older.id })()).not.toThrow();
});

test("removing the source removes its floor before recreation", async () => {
  await service.adoptSourceWireContract(source.id, { deviceId: modern.id });
  expect(sourceWireFloor(db, source.id)).toBe(1);
  expect(deleteSource(db, source.id)).toBe(true);
  expect(sourceWireFloor(db, source.id)).toBe(0);
  const recreated = createSource(db, {
    type: source.type,
    accountId: source.accountId,
    deviceId: older.id,
  });
  expect(recreated.id).toBe(source.id);
  expect(() => service.sourceWireAuthority([recreated.id], { deviceId: older.id })()).not.toThrow();
});

test("an unvalidated persisted capability cannot promote a source", async () => {
  db.prepare("UPDATE devices SET capabilities = ? WHERE id = ?").run(
    JSON.stringify({ ...modern.capabilities, sourceContract: {} }),
    modern.id,
  );
  await service.adoptSourceWireContract(source.id, { deviceId: modern.id });
  expect(sourceWireFloor(db, source.id)).toBe(0);
});

test("an older device cannot read an adopted shared cursor but an operator can", async () => {
  await service.adoptSourceWireContract(source.id, { deviceId: modern.id });
  expect(() => service.cursorRowFor(source.id, { deviceId: older.id })).toThrow(
    "Upgrade this device",
  );
  expect(service.cursorRowFor(source.id, { deviceId: null })).toBe("");
});

test("an offline legacy owner is visibly blocked until its capability is restored", async () => {
  await service.adoptSourceWireContract(source.id, { deviceId: modern.id });
  db.prepare("UPDATE devices SET capabilities = ? WHERE id = ?").run(
    JSON.stringify({ ...modern.capabilities, sourceContract: undefined }),
    modern.id,
  );
  expect(service.syncStatusFor(source.id)).toMatchObject({
    state: "error",
    remediation: { restartRequired: true, summary: expect.stringContaining("upgrade") },
  });
  db.prepare("UPDATE devices SET capabilities = ? WHERE id = ?").run(
    JSON.stringify(modern.capabilities),
    modern.id,
  );
  expect(service.syncStatusFor(source.id)?.state).not.toBe("error");
});

test.each(["cursor", "analytics", "unscoped analytics", "documents", "snapshot", "delete"])(
  "a queued %s write checks authority after adoption",
  async (kind) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const promotion = fence.runSourceExclusive(source.id, async () => {
      entered();
      await held;
      promoteSourceWireContract(db, source.id, 1);
    });
    await started;
    const authority = service.sourceWireAuthority(
      kind === "unscoped analytics" ? null : [source.id],
      { deviceId: older.id },
    );
    authority(); // The request was admissible before waiting for the source fence.
    const ingestPage = vi.fn();
    const analytics = new AnalyticsService(
      { ingestPage } as unknown as AnalyticsDb,
      undefined,
      false,
      undefined,
      fence,
    );
    const cursors = new SourceSyncStateService({
      db,
      writeGate: directWriteGate(db),
      sourceWriteEpochFence: fence,
    });
    const writeGate = directWriteGate(db);
    const documents = new DocumentService({
      db,
      writeGate,
      sourceWriteEpochFence: fence,
      events: new EventService(db, undefined, false),
      sourceDataRemoval: new SourceDataRemovalService({
        db,
        writeGate,
        sourceWriteEpochFence: fence,
        purgeAnnotationsFor: async () => {},
      }),
    });
    const operations: Record<string, () => Promise<unknown>> = {
      cursor: () =>
        cursors.setLegacyState(source.id, { overwritten: true }, {}, undefined, "", authority),
      documents: () =>
        documents.upsertWithCursor({
          callerScopes: [SCOPE_WRITE_ALL],
          assertSourceWireAuthority: authority,
          body: {
            providerId: "example",
            sourceId: source.id,
            hasMore: false,
            cursor: { overwritten: true },
          },
        }),
      snapshot: () =>
        documents.reconcile(
          "example",
          source.id,
          [],
          undefined,
          false,
          "",
          "",
          undefined,
          undefined,
          undefined,
          authority,
        ),
      delete: () =>
        documents.deleteByIds(
          "example",
          source.id,
          ["example"],
          undefined,
          false,
          "",
          "",
          authority,
        ),
    };
    const pending = operations[kind]
      ? operations[kind]()
      : analytics.ingest(
          {
            tableName: "example_rows",
            records: [],
            ...(kind === "analytics" ? { sourceId: source.id } : {}),
          },
          authority,
        );
    const assertion = expect(pending).rejects.toThrow("Upgrade this device");
    release();
    await promotion;
    await assertion;
    expect(getSyncState(db, source.id)).toBeNull();
    expect(ingestPage).not.toHaveBeenCalled();
  },
);
