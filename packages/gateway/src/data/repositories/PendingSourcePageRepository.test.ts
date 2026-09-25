// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "vitest";
import { AccountId, ProviderId, SourceType } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createDevice } from "./DeviceRepository.js";
import {
  addSourceMember,
  createSource,
  deleteSource,
  removeSourceMember,
} from "./SourceRepository.js";
import {
  beginSyncAttempt,
  bumpWipeEpoch,
  getSyncState,
  resetMemberCursor,
} from "./SyncStateRepository.js";
import { upsertWithCursor } from "./DocumentRepository.js";
import {
  preparePendingSourcePage,
  getPendingSourcePage,
  acknowledgePendingSourcePage,
} from "./PendingSourcePageRepository.js";

let dir: string;
let db: ReturnType<typeof createDatabase>;
let source: ReturnType<typeof createSource>;
let device: ReturnType<typeof createDevice>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-pending-page-"));
  db = createDatabase(join(dir, "state.db"));
  device = createDevice(db, { name: "Example collector", kind: "collector" });
  source = createSource(db, {
    type: SourceType("example"),
    accountId: AccountId("local"),
    deviceId: device.id,
  });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const prepare = (cursorRow = "") => {
  const args = {
    sourceId: source.id,
    cursorRow,
    deviceId: device.id,
    writeEpoch: beginSyncAttempt(db, source.id, cursorRow),
    id: randomUUID(),
    payload: { result: { cursor: { bookmark: 7 }, hasMore: false } },
  };
  expect(preparePendingSourcePage(db, args)?.id).toBe(args.id);
  return args;
};

test("a new attempt reuses exact prepared output across database reopen", () => {
  const first = prepare();
  db.close();
  db = createDatabase(join(dir, "state.db"));
  const nextEpoch = beginSyncAttempt(db, source.id);
  expect(
    preparePendingSourcePage(db, {
      ...first,
      id: randomUUID(),
      writeEpoch: nextEpoch,
      payload: { changed: true },
    }),
  ).toEqual({ id: first.id, payload: first.payload, cursorCommitted: false });
  expect(preparePendingSourcePage(db, first)).toBeNull();
});

test("cursor commit retains journal until matched acknowledgement and does not replay documents", () => {
  const page = prepare();
  expect(acknowledgePendingSourcePage(db, page)).toBe(false);
  const args = {
    providerId: ProviderId("example"),
    sourceId: source.id,
    hasMore: false,
    documents: [],
    cursor: { bookmark: 7 },
    wipeEpoch: page.writeEpoch,
    pendingPageId: page.id,
  };
  upsertWithCursor(db, args);
  expect(getPendingSourcePage(db, source.id, "")?.cursorCommitted).toBe(true);
  upsertWithCursor(db, { ...args, cursor: { bookmark: 999 } });
  expect(getSyncState(db, source.id)?.cursor).toBe('{"bookmark":7}');
  expect(acknowledgePendingSourcePage(db, { ...page, id: randomUUID() })).toBe(false);
  expect(acknowledgePendingSourcePage(db, page)).toBe(true);
  expect(getPendingSourcePage(db, source.id, "")).toBeNull();
});

test.each(["wipe", "member-reset", "delete"] as const)("%s cancels retained page", (action) => {
  const row = action === "member-reset" ? device.id : "";
  prepare(row);
  if (action === "wipe") bumpWipeEpoch(db, source.id);
  else if (action === "member-reset") resetMemberCursor(db, source.id, row);
  else deleteSource(db, source.id);
  expect(getPendingSourcePage(db, source.id, row)).toBeNull();
});

test("detaching the preparer cancels its shared-row page without removing sibling source", () => {
  const sibling = createDevice(db, { name: "Example sibling", kind: "collector" });
  db.prepare("UPDATE sources SET multi_device_mode = 'handoff' WHERE id = ?").run(source.id);
  addSourceMember(db, source.id, sibling.id);
  prepare();
  expect(removeSourceMember(db, source.id, device.id).removed).toBe(true);
  expect(getPendingSourcePage(db, source.id, "")).toBeNull();
});
