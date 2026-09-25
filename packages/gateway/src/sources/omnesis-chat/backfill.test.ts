// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdirSync, unlinkSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
type Db = Database.Database;

import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";

import { runConversationBackfill } from "./backfill.js";
import { findConversationDocId, OMNESIS_CHAT_SOURCE_ID } from "./index.js";
import type { ConversationRecord } from "../../agent/conversation-store.js";
import type Database from "better-sqlite3";

function tempDbPath(): string {
  return `/tmp/omnesis-chat-backfill-test-${randomUUID()}.db`;
}
function tempDir(): string {
  const p = `/tmp/omnesis-chat-backfill-dir-${randomUUID()}`;
  mkdirSync(p, { recursive: true });
  return p;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}
function cleanupDir(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

function writeTranscript(dir: string, rec: ConversationRecord): void {
  writeFileSync(join(dir, `${rec.id}.json`), JSON.stringify(rec), "utf8");
}

function makeRecord(id: string, overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id,
    callerId: "token:test",
    model: "claude-test",
    backend: "replay",
    createdAt: "2026-05-23T10:00:00.000Z",
    updatedAt: "2026-05-23T10:01:00.000Z",
    title: "Backfilled chat",
    pinned: false,
    messages: [
      { role: "user", parts: [{ kind: "text", text: "Older question" }] },
      { role: "assistant", parts: [{ kind: "text", text: "Older answer" }] },
    ],
    ...overrides,
  };
}

describe("runConversationBackfill", () => {
  let dbPath: string;
  let dir: string;
  let db: Db;
  let flagSet = false;

  beforeEach(() => {
    dbPath = tempDbPath();
    dir = tempDir();
    db = createDatabase(dbPath);
    flagSet = false;
  });
  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
    cleanupDir(dir);
  });

  test("upserts every JSON file in the conversations dir", async () => {
    writeTranscript(dir, makeRecord("s_a"));
    writeTranscript(dir, makeRecord("s_b"));

    const result = await runConversationBackfill({
      conversationsDir: dir,
      writeGate: directWriteGate(db),
      hasFlag: () => flagSet,
      setFlag: () => {
        flagSet = true;
      },
      lookupDocId: (p, s, e) => findConversationDocId(db, p, s, e),
    });

    expect(result).toEqual({ upserted: 2, skipped: 0, failed: 0 });
    expect(flagSet).toBe(true);
    expect(findConversationDocId(db, "system", OMNESIS_CHAT_SOURCE_ID, "s_a")).not.toBeNull();
    expect(findConversationDocId(db, "system", OMNESIS_CHAT_SOURCE_ID, "s_b")).not.toBeNull();
  });

  test("hasFlag short-circuits the sweep entirely", async () => {
    writeTranscript(dir, makeRecord("s_should_skip"));
    flagSet = true;

    const result = await runConversationBackfill({
      conversationsDir: dir,
      writeGate: directWriteGate(db),
      hasFlag: () => flagSet,
      setFlag: () => {
        flagSet = true;
      },
      lookupDocId: () => null,
    });

    expect(result.upserted).toBeNull();
    expect(findConversationDocId(db, "system", OMNESIS_CHAT_SOURCE_ID, "s_should_skip")).toBeNull();
  });

  test("missing directory marks flag complete without erroring", async () => {
    cleanupDir(dir); // delete before the run
    const result = await runConversationBackfill({
      conversationsDir: dir,
      writeGate: directWriteGate(db),
      hasFlag: () => flagSet,
      setFlag: () => {
        flagSet = true;
      },
      lookupDocId: () => null,
    });
    expect(result).toEqual({ upserted: 0, skipped: 0, failed: 0 });
    expect(flagSet).toBe(true);
  });

  test("malformed JSON contributes to failed count and prevents the flag", async () => {
    writeFileSync(join(dir, "s_bad.json"), "{not json", "utf8");
    writeTranscript(dir, makeRecord("s_good"));

    const result = await runConversationBackfill({
      conversationsDir: dir,
      writeGate: directWriteGate(db),
      hasFlag: () => flagSet,
      setFlag: () => {
        flagSet = true;
      },
      lookupDocId: (p, s, e) => findConversationDocId(db, p, s, e),
    });
    expect(result.failed).toBe(1);
    expect(result.upserted).toBe(1);
    expect(flagSet).toBe(false); // not set when there were failures
  });

  test("empty messages array is skipped, not upserted", async () => {
    writeTranscript(dir, makeRecord("s_empty", { messages: [] }));
    const result = await runConversationBackfill({
      conversationsDir: dir,
      writeGate: directWriteGate(db),
      hasFlag: () => flagSet,
      setFlag: () => {
        flagSet = true;
      },
      lookupDocId: (p, s, e) => findConversationDocId(db, p, s, e),
    });
    expect(result).toEqual({ upserted: 0, skipped: 1, failed: 0 });
    // Empty conversation must not produce a document.
    expect(findConversationDocId(db, "system", OMNESIS_CHAT_SOURCE_ID, "s_empty")).toBeNull();
  });
});
