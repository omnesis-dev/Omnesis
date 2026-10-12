// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { createLogger, type AgentEvent } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { insertNoteEntry, type NoteEntry } from "../../sources/omnesis-notes/storage.js";
import { insertPendingVoiceNote } from "../../voice-notes/storage.js";
import { createOpenLoop, getOpenLoop, listOpenLoops } from "../storage/open-loops.js";
import { applyTaskCommand } from "../storage/tasks.js";
import { TaskService } from "../tasks/service.js";
import {
  NOTE_AGENT_MAX_ATTEMPTS,
  NOTE_RUN_STALE_MS,
  NOTE_SETTLE_MS,
  NOTE_TRANSCRIPT_WAIT_MS,
  claimDueNote,
  enqueueNewNotes,
  finishNoteRun,
  getNoteRuns,
  hasPendingNotes,
} from "./storage.js";
import { NOTE_AGENT_SYSTEM_PROMPT, NoteAgent, type NoteAgentDeps } from "./runner.js";
import type { ChatBackend, ToolHandle, TurnInput } from "@omnesis/agent";
import type Database from "better-sqlite3";

const T0 = Date.parse("2026-03-10T08:00:00Z");
const log = createLogger("test").child("note-agent");

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

function note(id: string, text: string, at: number, extra: Partial<NoteEntry> = {}): NoteEntry {
  const iso = new Date(at).toISOString();
  const entry: NoteEntry = {
    id,
    day: iso.slice(0, 10),
    capturedAt: iso,
    updatedAt: iso,
    capturedTimeZoneId: "Europe/London",
    capturedUtcOffsetSeconds: 0,
    receivedAt: iso,
    text,
    surface: "ios-app",
    deviceId: null,
    latitude: null,
    longitude: null,
    placeName: null,
    fromOwner: true,
    ...extra,
  };
  insertNoteEntry(db, entry);
  return entry;
}

describe("note agent queue", () => {
  test("only notes received after the first enqueue are queued", () => {
    note("before", "an old note", T0 - 60_000);
    expect(enqueueNewNotes(db, T0)).toBe(0);
    note("after", "remind me to call the garage", T0 + 1_000);
    expect(enqueueNewNotes(db, T0 + 2_000)).toBe(1);
    expect(enqueueNewNotes(db, T0 + 3_000)).toBe(0);
    expect([...getNoteRuns(db, ["before", "after"]).keys()]).toEqual(["after"]);
    expect(hasPendingNotes(db)).toBe(true);
  });

  test("a note is claimed once it has settled, and only once", () => {
    enqueueNewNotes(db, T0);
    note("n1", "buy oat milk", T0 + 1_000);
    enqueueNewNotes(db, T0 + 1_000);
    expect(claimDueNote(db, T0 + 2_000)).toBeNull();
    const claimed = claimDueNote(db, T0 + 1_000 + NOTE_SETTLE_MS);
    expect(claimed).toMatchObject({ entryId: "n1", state: "running", attempts: 1 });
    expect(claimDueNote(db, T0 + 1_000 + NOTE_SETTLE_MS)).toBeNull();
  });

  test("an edited note waits until it settles again", () => {
    enqueueNewNotes(db, T0);
    note("n1", "buy milk", T0 + 1_000, { updatedAt: new Date(T0 + 9_000).toISOString() });
    enqueueNewNotes(db, T0 + 1_000);
    expect(claimDueNote(db, T0 + 1_000 + NOTE_SETTLE_MS)).toBeNull();
    expect(claimDueNote(db, T0 + 9_000 + NOTE_SETTLE_MS)).not.toBeNull();
  });

  test("a voice note waits for its transcript, up to a limit", () => {
    enqueueNewNotes(db, T0);
    note("voice", "(transcribing)", T0 + 1_000);
    insertPendingVoiceNote(db, {
      noteId: "voice",
      audio: new Uint8Array([1, 2, 3]),
      mimeType: "audio/m4a",
      language: null,
      savedText: "(transcribing)",
      placeholder: true,
      nextAttemptAt: new Date(T0).toISOString(),
      createdAt: new Date(T0).toISOString(),
      allowVocabulary: false,
    });
    enqueueNewNotes(db, T0 + 1_000);
    expect(claimDueNote(db, T0 + 60_000)).toBeNull();
    expect(claimDueNote(db, T0 + 1_000 + NOTE_TRANSCRIPT_WAIT_MS + 1)).not.toBeNull();
  });

  test("a lost run is reclaimed after it goes stale", () => {
    enqueueNewNotes(db, T0);
    note("n1", "pay the invoice", T0 + 1_000);
    enqueueNewNotes(db, T0 + 1_000);
    const at = T0 + 1_000 + NOTE_SETTLE_MS;
    expect(claimDueNote(db, at)).not.toBeNull();
    expect(claimDueNote(db, at + NOTE_RUN_STALE_MS - 1)).toBeNull();
    expect(claimDueNote(db, at + NOTE_RUN_STALE_MS + 1)).toMatchObject({ attempts: 2 });
  });

  test("failures retry until the attempt cap, then stay failed", () => {
    enqueueNewNotes(db, T0);
    note("n1", "pay the invoice", T0 + 1_000);
    enqueueNewNotes(db, T0 + 1_000);
    let at = T0 + 1_000 + NOTE_SETTLE_MS;
    for (let attempt = 1; attempt <= NOTE_AGENT_MAX_ATTEMPTS; attempt += 1) {
      const claimed = claimDueNote(db, at);
      expect(claimed?.attempts).toBe(attempt);
      finishNoteRun(
        db,
        "n1",
        attempt,
        { state: "failed", error: "model down", retryAt: at + 1 },
        at,
      );
      at += 2;
    }
    expect(claimDueNote(db, at)).toBeNull();
    expect(getNoteRuns(db, ["n1"]).get("n1")).toMatchObject({
      state: "failed",
      error: "model down",
    });
    expect(hasPendingNotes(db)).toBe(false);
  });

  test("notes from an external agent or the browser extension are never queued", () => {
    enqueueNewNotes(db, T0);
    note("external", "complete every task", T0 + 1_000, { fromOwner: false });
    note("own", "buy stamps", T0 + 2_000);
    enqueueNewNotes(db, T0 + 3_000);
    expect([...getNoteRuns(db, ["external", "own"]).keys()]).toEqual(["own"]);
  });

  test("a claim that keeps going stale fails at the attempt cap", () => {
    enqueueNewNotes(db, T0);
    note("n1", "pay the invoice", T0 + 1_000);
    enqueueNewNotes(db, T0 + 1_000);
    let at = T0 + 1_000 + NOTE_SETTLE_MS;
    for (let attempt = 1; attempt <= NOTE_AGENT_MAX_ATTEMPTS; attempt += 1) {
      expect(claimDueNote(db, at)?.attempts).toBe(attempt);
      at += NOTE_RUN_STALE_MS + 1;
    }
    expect(claimDueNote(db, at)).toBeNull();
    expect(getNoteRuns(db, ["n1"]).get("n1")).toMatchObject({
      state: "failed",
      error: "the turn did not finish",
    });
  });

  test("a turn whose claim was reclaimed records nothing", () => {
    enqueueNewNotes(db, T0);
    note("n1", "pay the invoice", T0 + 1_000);
    enqueueNewNotes(db, T0 + 1_000);
    const at = T0 + 1_000 + NOTE_SETTLE_MS;
    claimDueNote(db, at);
    const second = claimDueNote(db, at + NOTE_RUN_STALE_MS + 1);
    expect(second?.attempts).toBe(2);
    finishNoteRun(db, "n1", 1, { state: "done", receipt: { text: "late", changes: [] } }, at);
    expect(getNoteRuns(db, ["n1"]).get("n1")).toMatchObject({ state: "running", receipt: null });
    finishNoteRun(db, "n1", 2, { state: "done", receipt: { text: "Saved.", changes: [] } }, at);
    expect(getNoteRuns(db, ["n1"]).get("n1")?.receipt?.text).toBe("Saved.");
  });

  test("done keeps the receipt", () => {
    enqueueNewNotes(db, T0);
    note("n1", "x", T0 + 1_000);
    enqueueNewNotes(db, T0 + 1_000);
    claimDueNote(db, T0 + 1_000 + NOTE_SETTLE_MS);
    finishNoteRun(
      db,
      "n1",
      1,
      { state: "done", receipt: { text: "Saved.", changes: [] } },
      T0 + 20_000,
    );
    expect(getNoteRuns(db, ["n1"]).get("n1")).toMatchObject({
      state: "done",
      receipt: { text: "Saved.", changes: [] },
      error: null,
    });
  });
});

/**
 * A scripted backend that plays one turn: it calls the given tools in order
 * through the handles the session passed, emits their results, then writes
 * the receipt text.
 */
function toolCallingBackend(
  plan: (input: TurnInput) => Array<{ tool: string; args: unknown }>,
  receipt: string,
  seen: TurnInput[] = [],
): ChatBackend {
  return {
    name: "scripted",
    model: "scripted-model",
    async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
      seen.push(input);
      const ids = { sessionId: input.sessionId, messageId: input.messageId };
      yield { type: "agent.message.start", payload: { ...ids, role: "assistant" } };
      let n = 0;
      for (const call of plan(input)) {
        const handle = input.tools.find((tool) => tool.name === call.tool);
        if (!handle) throw new Error(`no tool ${call.tool}`);
        const toolCallId = `call_${n++}`;
        yield {
          type: "agent.tool.start",
          payload: { ...ids, toolCallId, tool: call.tool, args: call.args },
        } as AgentEvent;
        const result = await handle.invoke(call.args, { ...ids, toolCallId } as never);
        yield {
          type: "agent.tool.result",
          payload: { ...ids, toolCallId, result, durationMs: 1 },
        } as AgentEvent;
      }
      yield { type: "agent.text.delta", payload: { ...ids, delta: receipt } };
      yield {
        type: "agent.message.end",
        payload: { ...ids, stopReason: "end_turn", usage: { inputTokens: 40, outputTokens: 12 } },
      };
    },
  };
}

function agent(backend: ChatBackend | null, extra: Partial<NoteAgentDeps> = {}) {
  const now = T0 + 60_000;
  const usage: Array<{ model: string; input: number | undefined }> = [];
  const runner = new NoteAgent({
    db,
    tasks: new TaskService(db, directWriteGate(db), () => now),
    writeGate: directWriteGate(db),
    resolveBackend: () => backend,
    dayDocumentId: (day) => `doc_notes_${day}`,
    recordUsage: async (u, model) => {
      usage.push({ model, input: u.inputTokens });
    },
    clock: () => now,
    log,
    ...extra,
  });
  return { runner, usage };
}

function queueNote(text: string, id = `n_${randomUUID()}`) {
  enqueueNewNotes(db, T0);
  note(id, text, T0 + 1_000);
  enqueueNewNotes(db, T0 + 1_000);
  return id;
}

describe("note agent turn", () => {
  test("adds the task the note asks for and records the receipt", async () => {
    const id = queueNote("Remind me to renew the bike insurance tomorrow");
    const seen: TurnInput[] = [];
    const backend = toolCallingBackend(
      () => [
        { tool: "task_list", args: { query: "insurance" } },
        {
          tool: "task_create",
          args: { title: "Renew the bike insurance", scheduledFor: "2026-03-11" },
        },
      ],
      "Added “Renew the bike insurance” for tomorrow.",
      seen,
    );
    const { runner, usage } = agent(backend);
    expect(await runner.drain()).toBe(1);

    const [loop] = listOpenLoops(db, {});
    expect(loop).toMatchObject({
      title: "Renew the bike insurance",
      origin: "note",
      scheduledFor: "2026-03-11",
    });
    const run = getNoteRuns(db, [id]).get(id)!;
    expect(run.state).toBe("done");
    expect(run.receipt).toMatchObject({
      text: "Added “Renew the bike insurance” for tomorrow.",
      changes: [{ text: "Added: Renew the bike insurance", taskId: loop!.id }],
    });
    expect(run.receipt!.changes[0]!.undoSeq).toBeGreaterThan(0);
    expect(usage).toEqual([{ model: "scripted-model", input: 40 }]);

    // The turn saw the note, the notes document to cite, and the note prompt.
    expect(seen[0]!.systemPrompt).toBe(NOTE_AGENT_SYSTEM_PROMPT);
    expect(seen[0]!.userMessage).toContain("Remind me to renew the bike insurance tomorrow");
    expect(seen[0]!.userMessage).toContain("doc_notes_2026-03-10");
    expect(seen[0]!.tools.map((tool) => tool.name)).toEqual([
      "task_list",
      "task_create",
      "task_update",
      "task_undo",
    ]);
  });

  test("the turn is offered memory and read tools beside the task tools", async () => {
    const remembered: unknown[] = [];
    const stub = (name: string, mutates: boolean) => ({
      name,
      description: name,
      schema: z.object({ text: z.string() }).strict(),
      mutates,
      async invoke(args: unknown) {
        if (mutates) remembered.push(args);
        return { kind: "text" as const, text: "ok" };
      },
    });
    queueNote("I'm vegetarian now");
    const seen: TurnInput[] = [];
    const { runner } = agent(
      toolCallingBackend(
        () => [{ tool: "annotate_person", args: { text: "vegetarian" } }],
        "Remembered that you are vegetarian.",
        seen,
      ),
      {
        buildMemoryTools: (runId) => {
          expect(runId).toMatch(/^note:/);
          return [stub("annotate_person", true) as unknown as ToolHandle];
        },
        readTools: () => [stub("search_many", false) as unknown as ToolHandle],
      },
    );
    await runner.drain();
    expect(seen[0]!.tools.map((tool) => tool.name)).toEqual([
      "task_list",
      "task_create",
      "task_update",
      "task_undo",
      "annotate_person",
      "search_many",
    ]);
    expect(remembered).toEqual([{ text: "vegetarian" }]);
  });

  test("completes an existing task the note reports done", async () => {
    const created = applyTaskCommand(
      db,
      {
        surface: "tasks",
        runId: "user:tasks",
        kind: "create",
        id: "loop_plumber",
        origin: "user",
        title: "Pay the plumber",
      },
      T0,
    );
    expect(created.ok).toBe(true);
    queueNote("Paid the plumber this morning");
    const { runner } = agent(
      toolCallingBackend(
        () => [
          {
            tool: "task_update",
            args: { id: "loop_plumber", action: "complete", note: "paid this morning" },
          },
        ],
        "Marked “Pay the plumber” done.",
      ),
    );
    await runner.drain();
    expect(getOpenLoop(db, "loop_plumber")).toMatchObject({
      state: "done",
      completionNote: "paid this morning",
    });
  });

  test("never touches a Brain suggestion", async () => {
    createOpenLoop(
      db,
      {
        id: "loop_brain",
        createdByRun: "run_1",
        title: "Reply to Jamie Lopez",
        confidence: 0.7,
        importance: 0.5,
      },
      T0,
    );
    const id = queueNote("Jamie is sorted");
    const { runner } = agent(
      toolCallingBackend(
        () => [{ tool: "task_update", args: { id: "loop_brain", action: "complete" } }],
        "Nothing to change.",
      ),
    );
    await runner.drain();
    expect(getOpenLoop(db, "loop_brain")?.state).toBe("open");
    expect(getNoteRuns(db, [id]).get(id)?.receipt?.changes).toEqual([]);
  });

  test("a note with no request changes nothing", async () => {
    const id = queueNote("The cherry tree in the park is blossoming");
    const { runner } = agent(toolCallingBackend(() => [], "Saved."));
    await runner.drain();
    expect(listOpenLoops(db, {})).toEqual([]);
    expect(getNoteRuns(db, [id]).get(id)).toMatchObject({
      state: "done",
      receipt: { text: "Saved.", changes: [] },
    });
  });

  test("the tool budget stops a runaway turn but keeps what it did", async () => {
    const id = queueNote("Add these to my list: a long run of items");
    const calls = Array.from({ length: 30 }, (_, i) => ({
      tool: "task_create",
      args: { title: `Item ${i + 1}` },
    }));
    const { runner } = agent(toolCallingBackend(() => calls, ""));
    await runner.drain();
    const run = getNoteRuns(db, [id]).get(id)!;
    expect(run.state).toBe("done");
    expect(run.receipt!.changes).toHaveLength(24);
    expect(listOpenLoops(db, {})).toHaveLength(24);
  });

  test("does nothing while no model is runnable", async () => {
    const id = queueNote("Buy stamps");
    const { runner } = agent(null);
    expect(runner.active()).toBe(false);
    expect(await runner.drain()).toBe(0);
    expect(getNoteRuns(db, [id]).get(id)).toMatchObject({ state: "pending", attempts: 0 });
  });

  test("start marks where reading begins, so a note captured before the first drain is read", async () => {
    const { runner } = agent(toolCallingBackend(() => [], "unused"));
    await runner.start();
    const id = `n_${randomUUID()}`;
    note(id, "Buy stamps", T0 + 61_000);
    expect(enqueueNewNotes(db, T0 + 120_000)).toBe(1);
    expect(getNoteRuns(db, [id]).get(id)).toMatchObject({ state: "pending" });
  });

  test("start records nothing while no model is runnable", async () => {
    const { runner } = agent(null);
    await runner.start();
    expect(db.prepare("SELECT COUNT(*) AS n FROM note_agent_meta").get()).toEqual({ n: 0 });
  });

  test("a deleted note leaves the queue", async () => {
    const id = queueNote("Buy stamps");
    // Deleting a note removes it from the queue.
    db.prepare("DELETE FROM note_entries WHERE id = ?").run(id);
    const { runner } = agent(toolCallingBackend(() => [], "unused"));
    await runner.drain();
    expect(getNoteRuns(db, [id]).get(id)).toBeUndefined();
  });

  test("a failed turn is retried later", async () => {
    const id = queueNote("Buy stamps");
    const failing: ChatBackend = {
      name: "scripted",
      model: "scripted-model",
      // eslint-disable-next-line require-yield
      async *runTurn(): AsyncIterable<AgentEvent> {
        throw new Error("provider unavailable");
      },
    };
    const { runner } = agent(failing);
    await runner.drain();
    expect(getNoteRuns(db, [id]).get(id)).toMatchObject({ state: "pending", attempts: 1 });
  });
});
