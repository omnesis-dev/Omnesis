// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// A sync error's structured remediation lives beside its message on the
// `sync_state` row it was reported for: written with the message, replaced by
// the next error's (or by nothing, when that error carries none), and cleared
// by everything that clears the message — a successful cursor save, an
// explicit clear, a member reset.

import { randomUUID } from "node:crypto";
import { unlinkSync, existsSync } from "node:fs";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { SourceId, parseSourceId } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import {
  clearSyncError,
  getSyncState,
  resetAllMemberCursors,
  resetMemberCursor,
  resetSiblingMemberCursors,
  setSyncError,
  setSyncState,
} from "./SyncStateRepository.js";
import { createDevice } from "./DeviceRepository.js";
import { addSourceMember, createSource } from "./SourceRepository.js";

let dbPath: string;
let db: ReturnType<typeof createDatabase>;
const SRC = "apple-notes:local";
const REMEDY = {
  summary: "Disk access is required",
  steps: ["Open the pane.", "Add the executable."],
  executable: "/opt/example/bin/node",
  restartRequired: true,
};

beforeEach(() => {
  dbPath = `/tmp/omnesis-syncstate-remediation-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

function storedRemedy(deviceId = ""): unknown {
  const raw = getSyncState(db, SRC, deviceId)?.last_error_remediation;
  return raw == null ? raw : JSON.parse(raw);
}

describe("setSyncError — last_error_remediation", () => {
  test("is written beside the message and read back as the same object", () => {
    setSyncError(db, SRC, "Cannot open the database", "", REMEDY);
    expect(getSyncState(db, SRC)?.last_error).toBe("Cannot open the database");
    expect(storedRemedy()).toEqual(REMEDY);
  });

  test("an error reported without a remedy replaces the previous one's", () => {
    setSyncError(db, SRC, "Cannot open the database", "", REMEDY);
    setSyncError(db, SRC, "connection refused");
    expect(getSyncState(db, SRC)?.last_error).toBe("connection refused");
    expect(storedRemedy()).toBeNull();
  });

  test("a remedy that violates the shape is refused before it reaches the row", () => {
    expect(() =>
      setSyncError(db, SRC, "refused", "", { ...REMEDY, steps: [] } as typeof REMEDY),
    ).toThrow();
    expect(getSyncState(db, SRC)).toBeNull();
  });

  test("is scoped to the member row it was reported on", () => {
    setSyncError(db, SRC, "Cannot open the database", "dev-a", REMEDY);
    setSyncError(db, SRC, "connection refused", "dev-b");
    expect(storedRemedy("dev-a")).toEqual(REMEDY);
    expect(storedRemedy("dev-b")).toBeNull();
    expect(getSyncState(db, SRC, "")).toBeNull();
  });
});

describe("clearing — the remedy goes with the message", () => {
  test("a successful cursor save clears it", () => {
    setSyncError(db, SRC, "Cannot open the database", "", REMEDY);
    expect(setSyncState(db, SRC, { phase: "incremental" })).toBe(true);
    expect(getSyncState(db, SRC)?.last_error).toBeNull();
    expect(storedRemedy()).toBeNull();
  });

  test("clearSyncError clears one member's row, or every row", () => {
    setSyncError(db, SRC, "Cannot open the database", "dev-a", REMEDY);
    setSyncError(db, SRC, "Cannot open the database", "dev-b", REMEDY);
    clearSyncError(db, SRC, "dev-a");
    expect(storedRemedy("dev-a")).toBeNull();
    expect(storedRemedy("dev-b")).toEqual(REMEDY);
    clearSyncError(db, SRC);
    expect(storedRemedy("dev-b")).toBeNull();
  });

  test("a member sent back to bootstrap forgets it", () => {
    setSyncError(db, SRC, "Cannot open the database", "dev-a", REMEDY);
    resetMemberCursor(db, SRC, "dev-a");
    expect(storedRemedy("dev-a")).toBeNull();
  });

  test("siblings and every member sent back to bootstrap forget it too", () => {
    const parsed = parseSourceId(SourceId(SRC));
    const a = createDevice(db, { name: "Maya-Laptop", kind: "collector" });
    const b = createDevice(db, { name: "Jamie-Desk", kind: "collector" });
    createSource(db, {
      type: parsed.sourceType,
      accountId: parsed.accountId,
      deviceId: a.id,
      multiDeviceMode: "replicated",
    });
    addSourceMember(db, SourceId(SRC), b.id);
    setSyncError(db, SRC, "Cannot open the database", a.id, REMEDY);
    setSyncError(db, SRC, "Cannot open the database", b.id, REMEDY);

    resetSiblingMemberCursors(db, SRC, a.id);
    expect(storedRemedy(a.id)).toEqual(REMEDY);
    expect(storedRemedy(b.id)).toBeNull();

    resetAllMemberCursors(db, SRC);
    expect(storedRemedy(a.id)).toBeNull();
  });
});
