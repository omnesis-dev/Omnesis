// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;
import { createDatabase } from "../../db.js";
import {
  DEFAULT_COGNITION_NOTES_MAX_BYTES,
  CognitionNotesCapError,
  appendCognitionNotes,
  editCognitionNotes,
  readCognitionNotes,
  wipeCognitionNotes,
  writeCognitionNotes,
} from "./notes.js";

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

describe("steward notes blob", () => {
  let path: string;
  let db: Db;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  test("empty until written; write round-trips and echoes the stored content", () => {
    expect(readCognitionNotes(db)).toBe("");
    const stored = writeCognitionNotes(db, "the user ignores newsletter deadlines", {
      maxBytes: DEFAULT_COGNITION_NOTES_MAX_BYTES,
      now: 1000,
    });
    expect(stored).toBe("the user ignores newsletter deadlines");
    expect(readCognitionNotes(db)).toBe("the user ignores newsletter deadlines");
    writeCognitionNotes(db, "rewritten", { maxBytes: 100, now: 2000 });
    expect(readCognitionNotes(db)).toBe("rewritten");
  });

  test("the cap is bytes of UTF-8, not JS string length", () => {
    // 4 chars, 8 bytes — passes a 10-byte cap, fails an 8-byte-exclusive one.
    const twoByte = "éééé";
    expect(writeCognitionNotes(db, twoByte, { maxBytes: 10, now: 1000 })).toBe(twoByte);
    expect(() => writeCognitionNotes(db, twoByte, { maxBytes: 7, now: 1100 })).toThrow(
      CognitionNotesCapError,
    );
    // The refused write left the previous content intact.
    expect(readCognitionNotes(db)).toBe(twoByte);
  });

  test("cap error carries the sizes and the overage", () => {
    try {
      writeCognitionNotes(db, "x".repeat(20), { maxBytes: 10, now: 1000 });
      expect.unreachable("write should have thrown");
    } catch (err) {
      const capErr = err as CognitionNotesCapError;
      expect(capErr.attemptedBytes).toBe(20);
      expect(capErr.maxBytes).toBe(10);
      // The message tells the agent exactly how much to remove.
      expect(capErr.message).toContain("20 bytes");
      expect(capErr.message).toContain("10 over the 10-byte cap");
    }
  });

  test("append accumulates with newline joins and reports the running size", () => {
    const first = appendCognitionNotes(db, "alpha", { maxBytes: 100, now: 1000 });
    expect(first).toEqual({ applied: true, bytes: 5, overCap: false });
    const second = appendCognitionNotes(db, "beta", { maxBytes: 100, now: 1100 });
    expect(second).toEqual({ applied: true, bytes: 10, overCap: false });
    expect(readCognitionNotes(db)).toBe("alpha\nbeta");
  });

  test("append between the soft cap and the 2x ceiling lands with overCap", () => {
    // 8 bytes stored, cap 10: appending 5 more (8+1+5 = 14) crosses the cap
    // but stays within the 20-byte ceiling — accepted, flagged for compaction.
    appendCognitionNotes(db, "x".repeat(8), { maxBytes: 10, now: 1000 });
    const result = appendCognitionNotes(db, "y".repeat(5), { maxBytes: 10, now: 1100 });
    expect(result).toEqual({ applied: true, bytes: 14, overCap: true });
    expect(readCognitionNotes(db)).toBe(`${"x".repeat(8)}\n${"y".repeat(5)}`);
  });

  test("append lands exactly at the 2x ceiling; one byte more is refused", () => {
    // 10 + 1 + 9 = 20 = ceiling for cap 10 — accepted.
    appendCognitionNotes(db, "x".repeat(10), { maxBytes: 10, now: 1000 });
    const atCeiling = appendCognitionNotes(db, "y".repeat(9), { maxBytes: 10, now: 1100 });
    expect(atCeiling).toEqual({ applied: true, bytes: 20, overCap: true });
    // 20 + 1 + 1 = 22 > 20 — refused, notes unchanged.
    const overCeiling = appendCognitionNotes(db, "z", { maxBytes: 10, now: 1200 });
    expect(overCeiling).toEqual({ applied: false, bytes: 22, overCap: true });
    expect(readCognitionNotes(db)).toBe(`${"x".repeat(10)}\n${"y".repeat(9)}`);
  });

  test("append counts UTF-8 bytes against the ceiling, not characters", () => {
    // "éé" is 2 chars, 4 bytes. Cap 3 → ceiling 6: a 4-byte append lands
    // (over the cap, under the ceiling); appending 2 more bytes (4+1+2 = 7)
    // is refused.
    const first = appendCognitionNotes(db, "éé", { maxBytes: 3, now: 1000 });
    expect(first).toEqual({ applied: true, bytes: 4, overCap: true });
    const second = appendCognitionNotes(db, "é", { maxBytes: 3, now: 1100 });
    expect(second).toEqual({ applied: false, bytes: 7, overCap: true });
    expect(readCognitionNotes(db)).toBe("éé");
  });

  test("edit replaces a unique substring in place", () => {
    writeCognitionNotes(db, "Maya prefers morning meetings\nJamie is offline Fridays", {
      maxBytes: 100,
      now: 1000,
    });
    const result = editCognitionNotes(db, "morning meetings", "afternoon meetings", {
      maxBytes: 100,
      now: 1100,
    });
    expect(result).toEqual({
      applied: true,
      bytes: Buffer.byteLength("Maya prefers afternoon meetings\nJamie is offline Fridays"),
      overCap: false,
    });
    expect(readCognitionNotes(db)).toBe(
      "Maya prefers afternoon meetings\nJamie is offline Fridays",
    );
  });

  test("edit refuses a needle that does not occur, leaving the notes unchanged", () => {
    writeCognitionNotes(db, "one lesson", { maxBytes: 100, now: 1000 });
    expect(editCognitionNotes(db, "absent text", "anything", { maxBytes: 100, now: 1100 })).toEqual(
      { applied: false, reason: "not_found" },
    );
    // An empty needle is meaningless, not an everywhere-match.
    expect(editCognitionNotes(db, "", "anything", { maxBytes: 100, now: 1200 })).toEqual({
      applied: false,
      reason: "not_found",
    });
    expect(readCognitionNotes(db)).toBe("one lesson");
  });

  test("edit refuses an ambiguous needle and reports the occurrence count", () => {
    writeCognitionNotes(db, "call Maya\ncall Maya\ncall Jamie", { maxBytes: 100, now: 1000 });
    expect(editCognitionNotes(db, "call Maya", "ping Maya", { maxBytes: 100, now: 1100 })).toEqual({
      applied: false,
      reason: "ambiguous",
      occurrences: 2,
    });
    expect(readCognitionNotes(db)).toBe("call Maya\ncall Maya\ncall Jamie");
  });

  test("edit treats replacement text verbatim — `$` patterns are not expanded", () => {
    writeCognitionNotes(db, "budget: TBD", { maxBytes: 100, now: 1000 });
    const result = editCognitionNotes(db, "TBD", "$& approx $100", { maxBytes: 100, now: 1100 });
    expect(result.applied).toBe(true);
    expect(readCognitionNotes(db)).toBe("budget: $& approx $100");
  });

  test("edit refuses malformed UTF-16 instead of splicing through a surrogate pair", () => {
    writeCognitionNotes(db, "plan \u{1F389} party", { maxBytes: 100, now: 1000 });
    // A lone high surrogate would match half of the astral character and
    // orphan its other half — refused, notes untouched.
    expect(editCognitionNotes(db, "plan \ud83c", "plan", { maxBytes: 100, now: 1100 })).toEqual({
      applied: false,
      reason: "malformed",
    });
    // A lone surrogate in the replacement would corrupt the stored blob.
    expect(editCognitionNotes(db, "party", "bash \udf89", { maxBytes: 100, now: 1200 })).toEqual({
      applied: false,
      reason: "malformed",
    });
    expect(readCognitionNotes(db)).toBe("plan \u{1F389} party");
    // Whole-character edits over astral content still work.
    const whole = editCognitionNotes(db, "\u{1F389}", "\u{1F38A}", { maxBytes: 100, now: 1300 });
    expect(whole.applied).toBe(true);
    expect(readCognitionNotes(db)).toBe("plan \u{1F38A} party");
  });

  test("edit enforces the 2x ceiling on growth; shrinking edits always pass", () => {
    writeCognitionNotes(db, "x".repeat(10), { maxBytes: 10, now: 1000 });
    // Growing to 30 bytes exceeds the 20-byte ceiling — refused.
    expect(
      editCognitionNotes(db, "x".repeat(10), "y".repeat(30), { maxBytes: 10, now: 1100 }),
    ).toEqual({ applied: false, reason: "over_ceiling", bytes: 30 });
    expect(readCognitionNotes(db)).toBe("x".repeat(10));
    // Growing to 15 lands above the soft cap with overCap flagged.
    expect(
      editCognitionNotes(db, "x".repeat(10), "y".repeat(15), { maxBytes: 10, now: 1200 }),
    ).toEqual({ applied: true, bytes: 15, overCap: true });
    // A shrinking edit on an over-cap blob passes and clears the flag.
    expect(editCognitionNotes(db, "y".repeat(15), "ok", { maxBytes: 10, now: 1300 })).toEqual({
      applied: true,
      bytes: 2,
      overCap: false,
    });
    expect(readCognitionNotes(db)).toBe("ok");
  });

  test("wipe resets to empty (the one operator mutation)", () => {
    writeCognitionNotes(db, "something", { maxBytes: 100, now: 1000 });
    wipeCognitionNotes(db, 2000);
    expect(readCognitionNotes(db)).toBe("");
    // Wipe on an already-empty store is fine.
    wipeCognitionNotes(db, 3000);
    expect(readCognitionNotes(db)).toBe("");
  });
});
