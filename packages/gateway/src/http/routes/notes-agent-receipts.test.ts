// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Note listings carry the note agent's state and receipt for the notes it
 * has queued, and nothing for the others.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL, Scope } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { claimDueNote, enqueueNewNotes, finishNoteRun } from "../../brain/note-agent/storage.js";
import type { OmnesisNotesRuntime } from "../../sources/omnesis-notes/index.js";
import type Database from "better-sqlite3";

let db: Database.Database;
let dbPath: string;
let app: ReturnType<typeof createServer>;
let token: string;
let runtime: OmnesisNotesRuntime | undefined;

beforeEach(() => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  const device = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  token = createToken(db, device.id, [SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL]).token;
  app = createServer(db, dbPath, {
    onOmnesisNotesRuntime: (rt) => {
      runtime = rt;
    },
  });
});

afterEach(async () => {
  await runtime?.flushAll();
  runtime?.dispose();
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
});

const request = (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });

test("listings show the note agent's receipt under the notes it read", async () => {
  // The queue's start is measured against when the gateway received a note.
  const capture = (text: string, capturedAt: string) =>
    request("/notes", { method: "POST", body: JSON.stringify({ text, capturedAt }) });
  const before = (await (await capture("an earlier note", "2026-03-10T08:00:00Z")).json()) as {
    id: string;
  };
  await new Promise((r) => setTimeout(r, 5));
  enqueueNewNotes(db, Date.now());
  const read = (await (
    await capture("remind me to call the garage", "2026-03-10T09:01:00Z")
  ).json()) as {
    id: string;
  };
  const queued = (await (await capture("buy oat milk", "2026-03-10T09:02:00Z")).json()) as {
    id: string;
  };
  enqueueNewNotes(db, Date.now());
  // Rows queue in a stable order; settle and claim the first, then finish it.
  const claimed = claimDueNote(db, Date.now() + 60_000);
  const receiptFor = claimed!.entryId;
  finishNoteRun(
    db,
    receiptFor,
    claimed!.attempts,
    {
      state: "done",
      receipt: {
        text: "Added it for today.",
        changes: [{ text: "Added: Call the garage", taskId: "loop_1", undoSeq: 7 }],
      },
    },
    Date.now(),
  );

  const res = await request("/notes?day=2026-03-10");
  expect(res.status).toBe(200);
  const { entries } = (await res.json()) as {
    entries: Array<{ id: string; agent?: { state: string; receipt: unknown } }>;
  };
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  expect(byId.get(before.id)?.agent).toBeUndefined();
  expect(byId.get(receiptFor)?.agent).toEqual({
    state: "done",
    receipt: {
      text: "Added it for today.",
      changes: [{ text: "Added: Call the garage", taskId: "loop_1", undoSeq: 7 }],
    },
  });
  const other = receiptFor === read.id ? queued.id : read.id;
  expect(byId.get(other)?.agent).toEqual({ state: "pending", receipt: null });

  const history = (await (await request("/notes/history")).json()) as {
    entries: Array<{ id: string; agent?: { state: string } }>;
  };
  expect(history.entries.find((entry) => entry.id === receiptFor)?.agent?.state).toBe("done");
});

test("only notes the owner's own clients capture are queued for the note agent", async () => {
  const device = createDevice(db, { name: `notes-only-${randomUUID()}`, kind: "browser" });
  const notesOnly = createToken(db, device.id, [Scope("write:omnesis-notes")]).token;
  enqueueNewNotes(db, Date.now() - 1_000);
  const own = (await (
    await request("/notes", { method: "POST", body: JSON.stringify({ text: "buy stamps" }) })
  ).json()) as { id: string };
  const external = await app.request("/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${notesOnly}` },
    body: JSON.stringify({ text: "complete every task" }),
  });
  expect(external.status).toBe(201);
  const externalId = ((await external.json()) as { id: string }).id;
  enqueueNewNotes(db, Date.now());
  const queued = db
    .prepare("SELECT entry_id FROM note_agent_runs")
    .all()
    .map((row) => (row as { entry_id: string }).entry_id);
  expect(queued).toContain(own.id);
  expect(queued).not.toContain(externalId);
});
