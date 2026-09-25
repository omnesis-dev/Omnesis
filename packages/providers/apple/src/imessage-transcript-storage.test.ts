// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import {
  inspectTranscriptDatabase,
  openTranscriptDatabase,
} from "./imessage-transcript-storage.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-transcript-inspect-"));
  dirs.push(dir);
  return join(dir, "transcripts.db");
}

describe("inspectTranscriptDatabase", () => {
  test("a cache that was never written is absent", () => {
    expect(inspectTranscriptDatabase(tempPath(), null)).toBe("absent");
  });

  test("an unencrypted cache is plaintext whatever key is offered", () => {
    const path = tempPath();
    const db = new Database(path);
    db.exec("CREATE TABLE transcripts (attachment_guid TEXT PRIMARY KEY)");
    db.close();
    expect(inspectTranscriptDatabase(path, null)).toBe("plaintext");
    expect(inspectTranscriptDatabase(path, randomBytes(32))).toBe("plaintext");
  });

  test("an encrypted cache opens with its key, is locked without one, and is unverifiable with another", () => {
    const path = tempPath();
    const key = randomBytes(32);
    const opened = openTranscriptDatabase(path, key);
    opened.db.exec("CREATE TABLE transcripts (attachment_guid TEXT PRIMARY KEY)");
    opened.close();

    expect(inspectTranscriptDatabase(path, key)).toBe("encrypted");
    expect(inspectTranscriptDatabase(path, null)).toBe("locked");
    expect(inspectTranscriptDatabase(path, randomBytes(32))).toBe("unverifiable");
    // Inspection is read-only: the store still opens with its key afterwards.
    const again = openTranscriptDatabase(path, key);
    expect(again.db.prepare("SELECT count(*) AS n FROM transcripts").get()).toEqual({ n: 0 });
    again.close();
  });
});
