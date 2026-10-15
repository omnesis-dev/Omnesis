// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { createOpenLoop, getOpenLoop } from "../storage/open-loops.js";
import { getNoteEntry, insertNoteEntry } from "../../sources/omnesis-notes/storage.js";
import { TaskService } from "./service.js";
import type { CaptureNoteInput } from "../../sources/omnesis-notes/wiring.js";
import type { NoteEntry } from "../../sources/omnesis-notes/storage.js";
import type Database from "better-sqlite3";

const NOW = Date.parse("2026-03-10T09:00:00");
let path: string;
let db: Database.Database;

beforeEach(() => {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(path);
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
});

/** A notes runtime that stores captures directly, or fails every one. */
function notesStub(fail = false) {
  const captured: CaptureNoteInput[] = [];
  return {
    captured,
    runtime: () => ({
      capture: async (input: CaptureNoteInput): Promise<NoteEntry> => {
        captured.push(input);
        if (fail) throw new Error("the notes ledger is unavailable");
        const at = new Date(NOW).toISOString();
        const entry: NoteEntry = {
          id: input.id!,
          day: "2026-03-10",
          capturedAt: at,
          updatedAt: at,
          capturedTimeZoneId: null,
          capturedUtcOffsetSeconds: null,
          receivedAt: at,
          text: input.text,
          surface: input.surface ?? null,
          deviceId: null,
          latitude: null,
          longitude: null,
          placeName: null,
          ...(input.fromOwner ? { fromOwner: true } : {}),
          ...(input.taskId ? { taskId: input.taskId } : {}),
        };
        insertNoteEntry(db, entry);
        return entry;
      },
    }),
  };
}

function suggestion(id = "loop_s") {
  createOpenLoop(
    db,
    {
      id,
      createdByRun: "run_1",
      title: "Renew the parking permit",
      confidence: 0.8,
      importance: 0.5,
    },
    NOW,
  );
}

function service(notes?: ReturnType<typeof notesStub>) {
  const calls: string[] = [];
  const gate = directWriteGate(db);
  const tasks = new TaskService(
    db,
    gate,
    () => NOW,
    {
      writeGate: {
        cancelScheduledRunsForLoop: async (id) => {
          calls.push(`cancel ${id}`);
          return 0;
        },
        dropObservationsForResolvedLoop: async (id) => {
          calls.push(`drop ${id}`);
          return [];
        },
      },
      mirror: {
        refresh: async (id) => {
          calls.push(`refresh ${id}`);
        },
        remove: async (ids) => {
          calls.push(`remove ${ids.join(",")}`);
        },
      },
    },
    notes?.runtime,
  );
  return { tasks, calls };
}

const origin = { surface: "tasks", runId: "user:tasks" } as const;

describe("TaskService effects", () => {
  test("a change refreshes the loop mirror", async () => {
    const { tasks, calls } = service();
    await tasks.apply({
      ...origin,
      kind: "create",
      id: "loop_a",
      origin: "user",
      title: "Buy stamps",
    });
    await tasks.apply({ ...origin, kind: "migrate", id: "loop_a", to: "2026-03-12" });
    expect(calls).toEqual(["refresh loop_a", "refresh loop_a"]);
  });

  test("resolving a task retracts its checks and drops its observations", async () => {
    const { tasks, calls } = service();
    await tasks.apply({
      ...origin,
      kind: "create",
      id: "loop_a",
      origin: "user",
      title: "Buy stamps",
    });
    calls.length = 0;
    await tasks.apply({ ...origin, kind: "complete", id: "loop_a" });
    expect(calls).toEqual(["refresh loop_a", "cancel loop_a", "drop loop_a"]);
  });

  test("deleting a task removes its mirror and checks", async () => {
    const { tasks, calls } = service();
    await tasks.apply({
      ...origin,
      kind: "create",
      id: "loop_a",
      origin: "user",
      title: "Buy stamps",
    });
    calls.length = 0;
    await tasks.apply({ ...origin, kind: "delete", id: "loop_a" });
    expect(calls).toEqual(["remove loop_a", "cancel loop_a"]);
  });

  test("a refused command has no effects", async () => {
    const { tasks, calls } = service();
    const result = await tasks.apply({ ...origin, kind: "complete", id: "loop_missing" });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("accepting a suggestion with a note", () => {
  const NOTE_ID = "3f0c8a52-6d1e-4b7a-9c2f-0a1b2c3d4e5f";

  test("accepts it and saves a note naming the task, for the note agent", async () => {
    suggestion();
    const notes = notesStub();
    const { tasks } = service(notes);
    const result = await tasks.acceptWithNote({
      ...origin,
      id: "loop_s",
      scheduledFor: "2026-03",
      note: "  the old permit runs out on the 20th  ",
      noteId: NOTE_ID,
    });
    expect(result).toMatchObject({ ok: true, noteId: NOTE_ID });
    expect(getOpenLoop(db, "loop_s")).toMatchObject({ accepted: true, scheduledFor: "2026-03" });
    expect(getNoteEntry(db, NOTE_ID)).toMatchObject({
      text: "This is a note about the task “Renew the parking permit”: the old permit runs out on the 20th",
      surface: "tasks",
      taskId: "loop_s",
    });
    expect(notes.captured[0]).toMatchObject({ fromOwner: true });
  });

  test("a retry with the same note id replays instead of failing", async () => {
    suggestion();
    const notes = notesStub();
    const { tasks } = service(notes);
    const input = { ...origin, id: "loop_s", note: "it is for the blue car", noteId: NOTE_ID };
    const first = await tasks.acceptWithNote(input);
    const again = await tasks.acceptWithNote(input);
    expect(again).toMatchObject({ ok: true, noteId: NOTE_ID });
    expect(again.ok && first.ok && again.eventSeq).toBe(first.ok && first.eventSeq);
    expect(notes.captured).toHaveLength(1);
  });

  test("a note that cannot be saved leaves the suggestion unaccepted", async () => {
    suggestion();
    const { tasks } = service(notesStub(true));
    await expect(
      tasks.acceptWithNote({ ...origin, id: "loop_s", note: "for the blue car", noteId: NOTE_ID }),
    ).rejects.toThrow("the notes ledger is unavailable");
    expect(getOpenLoop(db, "loop_s")).toMatchObject({ accepted: false, state: "open" });
  });

  test("an accept that fails saves no note", async () => {
    suggestion();
    const notes = notesStub();
    const { tasks } = service(notes);
    await tasks.apply({ ...origin, kind: "accept", id: "loop_s" });
    const result = await tasks.acceptWithNote({
      ...origin,
      id: "loop_s",
      note: "for the blue car",
      noteId: NOTE_ID,
    });
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(notes.captured).toHaveLength(0);
  });
});
