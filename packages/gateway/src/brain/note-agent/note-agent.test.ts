// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createLogger, type AgentEvent } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { insertNoteEntry, type NoteEntry } from "../../sources/omnesis-notes/storage.js";
import { bootOmnesisNotes, type OmnesisNotesRuntime } from "../../sources/omnesis-notes/wiring.js";
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
  skipNewNotes,
} from "./storage.js";
import { NOTE_AGENT_SYSTEM_PROMPT, NoteAgent, type NoteAgentDeps } from "./runner.js";
import type { ChatBackend, ToolHandle, TurnInput } from "@omnesis/agent";
import type Database from "better-sqlite3";

const T0 = Date.parse("2026-03-10T08:00:00Z");
const log = createLogger("test").child("note-agent");

let path: string;
let db: Database.Database;

beforeEach(() => {
  vi.stubEnv("OMNESIS_SYNTHETIC", "0");
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(path);
});
afterEach(() => {
  vi.unstubAllEnvs();
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
          payload: { ...ids, toolCallId, tool: call.tool, result, durationMs: 1 },
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
    getSetting: () => undefined,
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
    const disposed: string[] = [];
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
        buildTools: (runId, taskTools, evidenceTools) => {
          expect(runId).toMatch(/^note:/);
          return {
            tools: [
              ...taskTools,
              stub("annotate_person", true) as unknown as ToolHandle,
              stub("search_many", false) as unknown as ToolHandle,
              ...evidenceTools,
            ],
            dispose: async (sessionId) => {
              disposed.push(sessionId);
            },
          };
        },
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
      "conversation_memory_evidence",
    ]);
    expect(remembered).toEqual([{ text: "vegetarian" }]);
    expect(seen[0]!.caller).toEqual({ kind: "operator" });
    expect(seen[0]!.timeZone).toBe("Europe/London");
    expect(disposed).toEqual([seen[0]!.sessionId]);
    const evidence = seen[0]!.tools.find((tool) => tool.name === "conversation_memory_evidence")!;
    expect(await evidence.invoke({}, {} as never)).toMatchObject({
      kind: "structured",
      data: { documentId: "doc_notes_2026-03-10", userMessages: ["I'm vegetarian now"] },
    });
  });

  test("a failed turn settles its isolated tool runtime", async () => {
    const id = queueNote("Look up the garden plan");
    let disposed = false;
    const { runner } = agent(
      {
        name: "scripted",
        model: "scripted-model",
        async *runTurn(input) {
          yield {
            type: "agent.message.start",
            payload: { sessionId: input.sessionId, messageId: input.messageId, role: "assistant" },
          };
          throw new Error("scripted outage");
        },
      },
      {
        buildTools: (_, taskTools) => ({
          tools: taskTools,
          dispose: async () => {
            disposed = true;
          },
        }),
      },
    );
    await runner.drain();
    expect(disposed).toBe(true);
    expect(getNoteRuns(db, [id]).get(id)?.state).toBe("pending");
  });

  test.each([true, false])(
    "a watch call followed by a model outage retries only if the watch failed (applied=%s)",
    async (applied) => {
      const id = queueNote("Tell me when greenhouse supplies are ready.");
      let now = T0 + 60_000;
      let calls = 0;
      const watches: string[] = [];
      const watch: ToolHandle = {
        name: "watch_create",
        description: "Set up the requested watch.",
        mutates: true,
        schema: z.object({ request: z.string() }),
        async invoke() {
          calls += 1;
          if (!applied)
            return { kind: "error", code: "unavailable", message: "Watch compiler unavailable." };
          watches.push("watch_greenhouse");
          return {
            kind: "watch.upserted",
            watchId: "watch_greenhouse",
            name: "Greenhouse supplies",
            action: "created",
            enabled: true,
            summary: "Notify when greenhouse supplies are ready.",
            interpretation: "Notify when greenhouse supplies are ready.",
          };
        },
      };
      const scripted = toolCallingBackend(
        () => [{ tool: "watch_create", args: { request: "Greenhouse supplies are ready." } }],
        "",
      );
      const backend: ChatBackend = {
        name: "scripted",
        model: "scripted-model",
        async *runTurn(input) {
          for await (const event of scripted.runTurn(input)) {
            if (event.type !== "agent.message.end" && event.type !== "agent.text.delta")
              yield event;
          }
          throw new Error("scripted outage after the watch call");
        },
      };
      const { runner } = agent(backend, {
        clock: () => now,
        buildTools: (_, taskTools) => ({
          tools: [...taskTools, watch],
          dispose: async () => {},
        }),
      });
      expect(await runner.drain()).toBe(1);
      expect(calls).toBe(1);
      const run = getNoteRuns(db, [id]).get(id)!;
      if (applied) {
        expect(run).toMatchObject({
          state: "done",
          attempts: 1,
          error: null,
          receipt: {
            text: "An action was applied before processing stopped. Review the result before asking again.",
            changes: [],
          },
        });
      } else {
        expect(run).toMatchObject({ state: "pending", attempts: 1, receipt: null });
        expect(run.error).toContain("scripted outage");
      }

      now += 6 * 60_000;
      expect(await runner.drain()).toBe(applied ? 0 : 1);
      expect(calls).toBe(applied ? 1 : 2);
      expect(watches).toEqual(applied ? ["watch_greenhouse"] : []);
      expect(getNoteRuns(db, [id]).get(id)?.attempts).toBe(applied ? 1 : 2);
    },
  );

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

  test("a note written while accepting a task is applied to that task", async () => {
    createOpenLoop(
      db,
      {
        id: "loop_accepted",
        createdByRun: "run_1",
        title: "Book the bike service",
        confidence: 0.7,
        importance: 0.5,
      },
      T0,
    );
    applyTaskCommand(
      db,
      { surface: "tasks", runId: "user:tasks", kind: "accept", id: "loop_accepted" },
      T0,
    );
    enqueueNewNotes(db, T0);
    note(
      "n_task",
      "This is a note about the task “Book the bike service”: the rear brake squeaks too",
      T0 + 1_000,
      { taskId: "loop_accepted" },
    );
    enqueueNewNotes(db, T0 + 1_000);
    const seen: TurnInput[] = [];
    const { runner } = agent(
      toolCallingBackend(
        () => [
          {
            tool: "task_update",
            args: {
              id: "loop_accepted",
              action: "edit",
              description: "The rear brake squeaks too.",
            },
          },
        ],
        "Added the brake to “Book the bike service”.",
        seen,
      ),
    );
    await runner.drain();
    expect(seen[0]!.userMessage).toContain(
      "The user wrote it while accepting their task loop_accepted",
    );
    expect(getOpenLoop(db, "loop_accepted")?.description).toBe("The rear brake squeaks too.");
  });

  test("accepts and ignores only the suggestions the owner names, with undoable receipts", async () => {
    for (const [id, title] of [
      ["loop_accept", "Reserve the planetarium workshop"],
      ["loop_ignore", "Renew the seed library membership"],
      ["loop_untouched", "Check the pottery kiln booking"],
    ] as const)
      createOpenLoop(
        db,
        { id, title, createdByRun: "run_suggestions", confidence: 0.8, importance: 0.5 },
        T0,
      );
    const untouched = getOpenLoop(db, "loop_untouched");
    const id = queueNote(
      "Accept the planetarium workshop suggestion for tomorrow and ignore the seed library membership suggestion; I handled that elsewhere.",
    );
    const { runner } = agent(
      toolCallingBackend(
        () => [
          { tool: "task_list", args: { view: "suggested" } },
          {
            tool: "task_update",
            args: { id: "loop_accept", action: "accept", scheduledFor: "2026-03-11" },
          },
          {
            tool: "task_update",
            args: { id: "loop_ignore", action: "ignore", reason: "Handled elsewhere." },
          },
        ],
        "Added the planetarium workshop for tomorrow and ignored the seed library suggestion.",
      ),
    );
    expect(await runner.drain()).toBe(1);
    expect(getOpenLoop(db, "loop_accept")).toMatchObject({
      state: "open",
      accepted: true,
      ignored: false,
      scheduledFor: "2026-03-11",
    });
    expect(getOpenLoop(db, "loop_ignore")).toMatchObject({
      state: "open",
      accepted: false,
      ignored: true,
    });
    expect(getOpenLoop(db, "loop_untouched")).toEqual(untouched);
    const receipt = getNoteRuns(db, [id]).get(id)!.receipt!;
    expect(receipt.changes).toEqual([
      {
        text: "Added to your tasks: Reserve the planetarium workshop",
        taskId: "loop_accept",
        undoSeq: expect.any(Number),
      },
      {
        text: "Ignored: Renew the seed library membership",
        taskId: "loop_ignore",
        undoSeq: expect.any(Number),
      },
    ]);
    for (const change of receipt.changes)
      expect(
        applyTaskCommand(
          db,
          { kind: "undo", surface: "tasks", runId: "user:tasks", seq: change.undoSeq! },
          T0 + 120_000,
        ).ok,
      ).toBe(true);
    expect(getOpenLoop(db, "loop_accept")).toMatchObject({
      accepted: false,
      ignored: false,
      scheduledFor: null,
    });
    expect(getOpenLoop(db, "loop_ignore")).toMatchObject({ accepted: false, ignored: false });
    expect(getOpenLoop(db, "loop_untouched")).toEqual(untouched);
  });

  test("a note can report that a suggested task is already done", async () => {
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
    const id = queueNote("I have already replied to Jamie Lopez.");
    const { runner } = agent(
      toolCallingBackend(
        () => [
          { tool: "task_list", args: { query: "Jamie Lopez" } },
          { tool: "task_update", args: { id: "loop_brain", action: "complete" } },
        ],
        "Marked replying to Jamie as already done.",
      ),
    );
    await runner.drain();
    expect(getOpenLoop(db, "loop_brain")).toMatchObject({ state: "done", accepted: true });
    expect(getNoteRuns(db, [id]).get(id)?.receipt?.changes).toEqual([
      expect.objectContaining({
        taskId: "loop_brain",
        text: "Done: Reply to Jamie Lopez",
        undoSeq: expect.any(Number),
      }),
    ]);
  });

  test("deletes the duplicate task the owner explicitly asks to remove", async () => {
    applyTaskCommand(
      db,
      {
        kind: "create",
        id: "loop_duplicate",
        title: "Duplicate greenhouse booking",
        origin: "user",
        surface: "tasks",
        runId: "user:tasks",
      },
      T0,
    );
    const id = queueNote("Delete the duplicate greenhouse booking task; it should not exist.");
    const { runner } = agent(
      toolCallingBackend(
        () => [
          { tool: "task_list", args: { query: "duplicate greenhouse" } },
          { tool: "task_update", args: { id: "loop_duplicate", action: "delete" } },
        ],
        "Deleted the duplicate greenhouse booking task.",
      ),
    );
    await runner.drain();
    expect(getOpenLoop(db, "loop_duplicate")).toBeNull();
    expect(getNoteRuns(db, [id]).get(id)?.receipt?.changes).toEqual([
      { text: "Deleted: Duplicate greenhouse booking", taskId: null, undoSeq: null },
    ]);
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

/** A backend that records every turn it is asked for and answers with an empty receipt. */
function countingBackend(): { backend: ChatBackend; turns: TurnInput[] } {
  const turns: TurnInput[] = [];
  return { backend: toolCallingBackend(() => [], "Saved.", turns), turns };
}

describe("note agent switch", () => {
  test("switched off, it reads nothing and settles new notes as skipped", async () => {
    enqueueNewNotes(db, T0);
    note("n1", "Remind me to water the plants", T0 + 1_000);
    const { backend, turns } = countingBackend();
    const { runner } = agent(backend, { getSetting: () => false });
    expect(runner.status()).toEqual({
      enabled: false,
      modelAssigned: true,
      active: false,
    });
    expect(await runner.drain()).toBe(0);
    expect(turns).toEqual([]);
    expect(getNoteRuns(db, ["n1"]).get("n1")).toMatchObject({ state: "skipped", receipt: null });
    expect(hasPendingNotes(db)).toBe(false);
  });

  test("switched back on, it reads only what is told from then on", async () => {
    let setting: boolean | undefined = false;
    let now = T0 + 60_000;
    const { backend, turns } = countingBackend();
    const { runner } = agent(backend, { getSetting: () => setting, clock: () => now });
    enqueueNewNotes(db, T0);
    note("while-off", "Buy stamps", T0 + 1_000);
    await runner.drain();

    setting = true;
    note("after", "Call the garage", T0 + 61_000);
    now = T0 + 61_000 + NOTE_SETTLE_MS;
    expect(await runner.drain()).toBe(1);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.userMessage).toContain("Call the garage");
    const runs = getNoteRuns(db, ["while-off", "after"]);
    expect(runs.get("while-off")?.state).toBe("skipped");
    expect(runs.get("after")?.state).toBe("done");
  });

  test("switched off before it ever ran, it records nothing and starts afresh when switched on", async () => {
    let setting: boolean | undefined = false;
    const { backend, turns } = countingBackend();
    const { runner } = agent(backend, { getSetting: () => setting });
    await runner.start();
    note("early", "Buy stamps", T0 + 1_000);
    expect(await runner.drain()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM note_agent_meta").get()).toEqual({ n: 0 });

    setting = true;
    expect(await runner.drain()).toBe(0);
    expect(turns).toEqual([]);
    expect(getNoteRuns(db, ["early"]).size).toBe(0);
  });

  describe("notes captured while it is off", () => {
    const runtimes: OmnesisNotesRuntime[] = [];
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
    });
    afterEach(async () => {
      for (const runtime of runtimes.splice(0)) {
        await runtime.flushAll();
        runtime.dispose();
      }
      vi.useRealTimers();
    });

    /** Capture an owner's note the way the gateway does, under the runner's switch. */
    function capturer(runner: NoteAgent) {
      const notes = bootOmnesisNotes({
        writeGate: directWriteGate(db),
        readDb: db,
        ingest: async () => undefined,
        deleteByIds: async () => undefined,
        isNoteAgentEnabled: () => runner.enabled(),
        debounceMs: 0,
      });
      runtimes.push(notes);
      return async (id: string, text: string, at: number) => {
        vi.setSystemTime(at);
        await notes.capture({
          id,
          text,
          capturedAt: new Date(at).toISOString(),
          surface: "ios-app",
          fromOwner: true,
        });
      };
    }

    /** A backend whose first turn waits until the test releases it. */
    function heldBackend() {
      const { backend: inner, turns } = countingBackend();
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let started!: () => void;
      const turnStarted = new Promise<void>((resolve) => (started = resolve));
      const backend: ChatBackend = {
        ...inner,
        async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
          started();
          await released;
          yield* inner.runTurn(input);
        },
      };
      return { backend, turns, turnStarted, release };
    }

    test("switched back on before any drain, it never reads them", async () => {
      let setting: boolean | undefined = true;
      let now = T0;
      const { backend, turns } = countingBackend();
      const { runner } = agent(backend, { getSetting: () => setting, clock: () => now });
      const capture = capturer(runner);
      await runner.start();

      setting = false;
      await capture("while-off", "Buy stamps", T0 + 1_000);
      setting = true;
      now = T0 + 1_000 + NOTE_SETTLE_MS;
      expect(await runner.drain()).toBe(0);
      expect(turns).toEqual([]);
      expect(getNoteRuns(db, ["while-off"]).get("while-off")?.state).toBe("skipped");
    });

    test("switched off and on again during a slow turn, it never reads them", async () => {
      let setting: boolean | undefined = true;
      let now = T0;
      const { backend, turns, turnStarted, release } = heldBackend();
      const { runner } = agent(backend, { getSetting: () => setting, clock: () => now });
      const capture = capturer(runner);
      await runner.start();
      await capture("first", "Call the garage", T0 + 1_000);
      now = T0 + 1_000 + NOTE_SETTLE_MS;
      const draining = runner.drain();
      await turnStarted;

      setting = false;
      await capture("while-off", "Buy stamps", T0 + 12_000);
      expect(await runner.drain()).toBe(0);
      setting = true;
      release();
      expect(await draining).toBe(1);

      now = T0 + 12_000 + NOTE_SETTLE_MS;
      expect(await runner.drain()).toBe(0);
      expect(turns.map((turn) => turn.userMessage)).toEqual([
        expect.stringContaining("Call the garage"),
      ]);
      const runs = getNoteRuns(db, ["first", "while-off"]);
      expect(runs.get("first")?.state).toBe("done");
      expect(runs.get("while-off")?.state).toBe("skipped");
    });

    test("a note captured while it is on waits behind a slow turn and is read", async () => {
      let now = T0;
      const { backend, turns, turnStarted, release } = heldBackend();
      const { runner } = agent(backend, { clock: () => now });
      const capture = capturer(runner);
      await runner.start();
      await capture("first", "Call the garage", T0 + 1_000);
      now = T0 + 1_000 + NOTE_SETTLE_MS;
      const draining = runner.drain();
      await turnStarted;

      await capture("behind", "Buy stamps", T0 + 12_000);
      expect(await runner.drain()).toBe(0);
      release();
      expect(await draining).toBe(1);

      now = T0 + 12_000 + NOTE_SETTLE_MS;
      expect(await runner.drain()).toBe(1);
      expect(turns.map((turn) => turn.userMessage)).toEqual([
        expect.stringContaining("Call the garage"),
        expect.stringContaining("Buy stamps"),
      ]);
    });

    test("a restarted gateway with it on never reads them", async () => {
      enqueueNewNotes(db, T0);
      const { runner: before } = agent(countingBackend().backend, {
        getSetting: () => false,
        clock: () => T0,
      });
      await capturer(before)("while-off", "Buy stamps", T0 + 1_000);

      const { backend, turns } = countingBackend();
      const { runner: after } = agent(backend, {
        getSetting: () => true,
        clock: () => T0 + 1_000 + NOTE_SETTLE_MS,
      });
      await after.start();
      expect(await after.drain()).toBe(0);
      expect(turns).toEqual([]);
      expect(getNoteRuns(db, ["while-off"]).get("while-off")?.state).toBe("skipped");
    });
  });

  test("skipping before the note agent first ran records nothing", () => {
    note("n1", "Buy stamps", T0 + 1_000);
    expect(skipNewNotes(db, T0 + 2_000)).toBe(0);
    expect(getNoteRuns(db, ["n1"]).size).toBe(0);
  });
});

test("unset, it is on whenever a model can run", async () => {
  const { backend } = countingBackend();
  const { runner } = agent(backend);
  await runner.start();
  expect(runner.status()).toEqual({ enabled: true, modelAssigned: true, active: true });
  expect(agent(null).runner.status()).toEqual({
    enabled: true,
    modelAssigned: false,
    active: false,
  });
});

describe("note agent retry after replayable bookkeeping", () => {
  test.each(["conversation_memory_evidence", "cite_record"])(
    "a successful %s call before an outage leaves the requested task retryable",
    async (name) => {
      const id = queueNote("Add a task to prepare the greenhouse seed trays.");
      let now = T0 + 60_000;
      let turns = 0;
      let calls = 0;
      const scripted = toolCallingBackend(
        () => [
          { tool: name, args: {} },
          ...(turns > 1
            ? [{ tool: "task_create", args: { title: "Prepare the greenhouse seed trays" } }]
            : []),
        ],
        "Added preparing the greenhouse seed trays.",
      );
      const backend: ChatBackend = {
        name: "scripted",
        model: "scripted-model",
        async *runTurn(input) {
          turns += 1;
          for await (const event of scripted.runTurn(input)) {
            if (
              turns > 1 ||
              (event.type !== "agent.message.end" && event.type !== "agent.text.delta")
            )
              yield event;
          }
          if (turns === 1) throw new Error("scripted outage after bookkeeping");
        },
      };
      const { runner } = agent(backend, {
        clock: () => now,
        buildTools: (_, taskTools, evidenceTools) => {
          const bookkeeping: ToolHandle =
            name === "conversation_memory_evidence"
              ? evidenceTools.find((tool) => tool.name === name)!
              : {
                  name,
                  description: "Record an idempotent citation for this turn.",
                  mutates: true,
                  schema: z.object({}).strict(),
                  invoke: async () => ({
                    kind: "structured",
                    resultType: "citation.recorded",
                    data: {},
                  }),
                };
          return {
            tools: [
              ...taskTools,
              {
                ...bookkeeping,
                async invoke(args, context) {
                  calls += 1;
                  const result = await bookkeeping.invoke(args, context);
                  expect(result.kind).not.toBe("error");
                  return result;
                },
              },
            ],
            dispose: async () => {},
          };
        },
      });

      expect(await runner.drain()).toBe(1);
      expect(calls).toBe(1);
      expect(listOpenLoops(db, {})).toEqual([]);
      expect(getNoteRuns(db, [id]).get(id)).toMatchObject({
        state: "pending",
        attempts: 1,
        receipt: null,
        error: expect.stringContaining("scripted outage after bookkeeping"),
      });

      now += 6 * 60_000;
      expect(await runner.drain()).toBe(1);
      expect(turns).toBe(2);
      expect(calls).toBe(2);
      expect(listOpenLoops(db, {})).toEqual([
        expect.objectContaining({ title: "Prepare the greenhouse seed trays", origin: "note" }),
      ]);
      expect(getNoteRuns(db, [id]).get(id)).toMatchObject({
        state: "done",
        attempts: 2,
        error: null,
        receipt: {
          changes: [
            expect.objectContaining({
              text: "Added: Prepare the greenhouse seed trays",
              undoSeq: expect.any(Number),
            }),
          ],
        },
      });
    },
  );
});
