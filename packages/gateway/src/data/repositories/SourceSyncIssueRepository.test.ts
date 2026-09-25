// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, test } from "vitest";
import { AccountId, SourceType, type SyncIssue } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createDevice } from "./DeviceRepository.js";
import {
  createSource,
  addSourceMember,
  removeSourceMember,
  deleteSource,
  updateSource,
} from "./SourceRepository.js";
import { listSourceSyncIssues, replaceSourceSyncIssues } from "./SourceSyncIssueRepository.js";

const issue: SyncIssue = {
  code: "snapshot-withheld",
  scope: "partition",
  kind: "unknown",
  count: 1,
  subject: "Whole-source deletion detection",
  message: "Example partition could not be read",
};
let dir: string;
let db: ReturnType<typeof createDatabase>;
let a: ReturnType<typeof createDevice>;
let b: ReturnType<typeof createDevice>;
let source: ReturnType<typeof createSource>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-sync-issues-"));
  db = createDatabase(join(dir, "state.db"));
  a = createDevice(db, { name: "Example alpha", kind: "collector" });
  b = createDevice(db, { name: "Example beta", kind: "collector" });
  source = createSource(db, {
    type: SourceType("example"),
    accountId: AccountId("local"),
    deviceId: a.id,
    multiDeviceMode: "replicated",
  });
  addSourceMember(db, source.id, b.id);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("warnings and first observation survive restart and wording changes", () => {
  replaceSourceSyncIssues(db, source.id, a.id, [issue], 100);
  db.close();
  db = createDatabase(join(dir, "state.db"));
  replaceSourceSyncIssues(db, source.id, a.id, [{ ...issue, message: "Still incomplete" }], 200);
  expect(listSourceSyncIssues(db, source.id).get(a.id)).toEqual([
    { ...issue, message: "Still incomplete", since: 100 },
  ]);
  replaceSourceSyncIssues(db, source.id, a.id, [], 300);
  replaceSourceSyncIssues(db, source.id, a.id, [issue], 400);
  expect(listSourceSyncIssues(db, source.id).get(a.id)?.[0]?.since).toBe(400);
});
test("a sibling recovery cannot clear another member's warning", () => {
  replaceSourceSyncIssues(db, source.id, a.id, [issue]);
  replaceSourceSyncIssues(db, source.id, b.id, [issue]);
  replaceSourceSyncIssues(db, source.id, b.id, []);
  expect([...listSourceSyncIssues(db, source.id).keys()]).toEqual([a.id]);
});
test("detach/removal clear diagnoses and queued former-member reports cannot recreate them", () => {
  replaceSourceSyncIssues(db, source.id, b.id, [issue]);
  removeSourceMember(db, source.id, b.id);
  replaceSourceSyncIssues(db, source.id, b.id, [issue]);
  expect(listSourceSyncIssues(db, source.id).size).toBe(0);
  replaceSourceSyncIssues(db, source.id, a.id, [issue]);
  deleteSource(db, source.id);
  replaceSourceSyncIssues(db, source.id, a.id, [issue]);
  expect(listSourceSyncIssues(db, source.id).size).toBe(0);
});

test("re-homing retains only the new owner's diagnosis", () => {
  replaceSourceSyncIssues(db, source.id, a.id, [issue], 100);
  replaceSourceSyncIssues(db, source.id, b.id, [issue], 200);
  updateSource(db, source.id, { deviceId: b.id });
  replaceSourceSyncIssues(db, source.id, a.id, [issue], 300);
  expect([...listSourceSyncIssues(db, source.id).keys()]).toEqual([b.id]);
  expect(listSourceSyncIssues(db, source.id).get(b.id)?.[0]?.since).toBe(200);
});

test("a partial assessment clears only its exact diagnostic key across restart", () => {
  const first = { ...issue, code: "invalid-snapshot", subject: "table_one" };
  const second = { ...first, subject: "table_two" };
  replaceSourceSyncIssues(db, source.id, a.id, [issue, first, second], 100);
  replaceSourceSyncIssues(db, source.id, b.id, [first], 100);
  replaceSourceSyncIssues(db, source.id, a.id, [], 200, [
    { code: first.code, scope: first.scope, subject: first.subject },
  ]);
  db.close();
  db = createDatabase(join(dir, "state.db"));
  expect(listSourceSyncIssues(db, source.id).get(a.id)).toEqual([
    { ...issue, since: 100 },
    { ...second, since: 100 },
  ]);
  expect(listSourceSyncIssues(db, source.id).get(b.id)).toEqual([{ ...first, since: 100 }]);
  replaceSourceSyncIssues(db, source.id, a.id, [{ ...second, message: "Still invalid" }], 300, [
    { code: second.code, scope: second.scope, subject: second.subject },
  ]);
  expect(
    listSourceSyncIssues(db, source.id)
      .get(a.id)
      ?.find((entry) => entry.subject === second.subject)?.since,
  ).toBe(100);
  replaceSourceSyncIssues(db, source.id, a.id, [], 400);
  expect(listSourceSyncIssues(db, source.id).get(a.id)).toBeUndefined();
});
