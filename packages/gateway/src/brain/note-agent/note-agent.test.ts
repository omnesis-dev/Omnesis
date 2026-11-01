// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { HttpChatBackend } from "@omnesis/agent";
import { createLogger, type AgentEvent, type ToolResult } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import {
  insertNoteEntry,
  updateNoteEntryText,
  applyNoteEntryTranscript,
  getNoteEntry,
  type NoteEntry,
} from "../../sources/omnesis-notes/storage.js";
import { bootOmnesisNotes, type OmnesisNotesRuntime } from "../../sources/omnesis-notes/wiring.js";
import { insertPendingVoiceNote } from "../../voice-notes/storage.js";
import { createOpenLoop, getOpenLoop, listOpenLoops } from "../storage/open-loops.js";
import { applyTaskCommand } from "../storage/tasks.js";
import { TaskService } from "../tasks/service.js";
import { createInteractiveMemoryProfile } from "../interactive-memory.js";
import { resolveBrainSettings } from "../config.js";
import { resolveSelfMemory } from "../self-memory.js";
import { listLivePersonAnnotationsForPerson } from "../storage/person-annotations.js";
import {
  NOTE_AGENT_MAX_ATTEMPTS,
  NOTE_RUN_STALE_MS,
  NOTE_SETTLE_MS,
  NOTE_TRANSCRIPT_WAIT_MS,
  admitNoteMutation,
  settleNoteMutation,
  createNoteAgentTables,
  claimDueNote,
  enqueueNewNotes,
  finishNoteRun,
  getNoteRuns,
  hasPendingNotes,
  skipNewNotes,
} from "./storage.js";
import {
  noteTextChange,
  NOTE_AGENT_SYSTEM_PROMPT,
  NOTE_AGENT_TURN_TIMEOUT_MS,
  NoteAgent,
  type NoteAgentDeps,
} from "./runner.js";
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
  test("self-memory from a note and its edit is visible to a fresh owner profile with Brain off", async () => {
    const original = "Remember that my fictional greenhouse test label is violet.";
    const corrected = "Remember that my fictional greenhouse test label is amber.";
    const id = queueNote(original);
    const docId = "doc_note_memory";
    db.prepare(
      `INSERT INTO people (id,canonical_name,source,is_self,first_seen,last_seen,created_at,updated_at)
       VALUES ('self','Fictional owner','test',1,?,?,?,?)`,
    ).run(T0, T0, T0, T0);
    db.prepare(
      `INSERT INTO documents (id,provider_id,source_id,external_id,title,content,content_hash,
        source_created_at,source_updated_at,ingested_at,updated_at)
       VALUES (?,'test','test','note-memory','Owner note',?,?,?,?,?,?)`,
    ).run(docId, original, createHash("sha256").update(original).digest("hex"), T0, T0, T0, T0);
    let now = T0 + 60_000;
    const memory = createInteractiveMemoryProfile({
      db,
      writeGate: directWriteGate(db),
      getSettings: () => resolveBrainSettings({ annotations: { enabled: false } }),
      getEntailmentVerifier: () => Promise.resolve(null),
      clock: () => now,
      log,
    });
    const seen: TurnInput[] = [];
    const backend = toolCallingBackend((input) => {
      seen.push(input);
      const quote = input.userMessage.includes("amber") ? corrected : original;
      return [
        { tool: "annotation_search", args: { personId: "self" } },
        {
          tool: "annotate_person",
          args: {
            personId: "self",
            claimType: "test-preference",
            claimText:
              quote === corrected
                ? "The user's test label is amber."
                : "The user's test label is violet.",
            evidenceDocId: docId,
            evidenceQuote: quote,
            claimBasis: "quoted",
            confidence: 0.8,
          },
        },
      ];
    }, "Remembered your test label.");
    const { runner } = agent(backend, {
      clock: () => now,
      dayDocumentId: () => docId,
      buildTools: (runId, tasks, evidence) => ({
        tools: [...tasks, ...evidence, ...memory.buildOwnTools(runId)],
        dispose: async () => undefined,
      }),
    });
    expect(await runner.drain()).toBe(1);
    expect(resolveSelfMemory(db, true).selfMemory).toContain("violet");
    expect(seen[0]?.systemPrompt).toContain('self person ID is "self"');
    expect(seen[0]?.systemPrompt).toContain(
      "Use annotate_person for a durable fact about one person",
    );
    expect(seen[0]?.systemPrompt).toContain(
      "Use annotate_durable for context about one specific document",
    );
    now += 60_000;
    updateNoteEntryText(db, id, corrected, new Date(now).toISOString(), {
      owner: true,
      enabled: true,
    });
    db.prepare("UPDATE documents SET content=?,content_hash=? WHERE id=?").run(
      corrected,
      createHash("sha256").update(corrected).digest("hex"),
      docId,
    );
    // The production document-update cascade uses this same writer boundary,
    // independently of autonomous annotation generation being switched off.
    await directWriteGate(db).invalidatePersonAnnotationsForDoc(docId, now);
    expect(listLivePersonAnnotationsForPerson(db, "self")).toEqual([]);
    now += 60_000;
    expect(await runner.drain()).toBe(1);
    expect(await runner.drain()).toBe(0);
    const current = resolveSelfMemory(db, true);
    expect(current.selfMemory).toContain("amber");
    expect(current.selfMemory).not.toContain("violet");
    expect(listLivePersonAnnotationsForPerson(db, "self")).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM doc_annotations").get()).toEqual({ n: 0 });
    expect(seen[1]?.systemPrompt).toContain('self person ID is "self"');
  });

  test("a note with no established self identity receives an explicit self-memory refusal boundary", async () => {
    const id = queueNote("Remember that I prefer violet workshop labels.");
    const seen: TurnInput[] = [];
    const backend = toolCallingBackend((input) => {
      seen.push(input);
      return [];
    }, "Saved the note. Your self identity needs to be set up before I can save this to your profile.");
    const { runner } = agent(backend);
    expect(await runner.drain()).toBe(1);
    expect(seen[0]?.systemPrompt).toContain("self identity has not been established");
    expect(seen[0]?.systemPrompt).toContain("Do not invent a person ID");
    expect(resolveSelfMemory(db, true).selfPersonId).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM person_annotations").get()).toEqual({ n: 0 });
    expect(getNoteRuns(db, [id]).get(id)?.receipt?.text).toContain("before I can save");
  });

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
    expect(seen[0]!.systemPrompt.startsWith(NOTE_AGENT_SYSTEM_PROMPT)).toBe(true);
    expect(seen[0]!.userMessage).toContain("Remind me to renew the bike insurance tomorrow");
    expect(seen[0]!.userMessage).toContain("doc_notes_2026-03-10");
    expect(seen[0]!.tools.map((tool) => tool.name)).toEqual([
      "task_list",
      "task_create",
      "task_update",
      "task_undo",
    ]);
  });

  test.each([true, false])(
    "the receipt excludes commentary before and between tool calls (final text=%s)",
    async (hasFinalText) => {
      const id = queueNote("Add a task to prepare the greenhouse seed trays.");
      const receipt = "Added preparing the greenhouse seed trays to your tasks.";
      const scripted = toolCallingBackend(
        () => [
          { tool: "task_list", args: { query: "greenhouse seed trays" } },
          { tool: "task_create", args: { title: "Prepare the greenhouse seed trays" } },
        ],
        hasFinalText ? receipt : "",
      );
      const backend: ChatBackend = {
        name: "scripted",
        model: "scripted-model",
        async *runTurn(input) {
          const ids = { sessionId: input.sessionId, messageId: input.messageId };
          for await (const event of scripted.runTurn(input)) {
            if (event.type === "agent.text.delta") {
              if (hasFinalText) {
                yield {
                  type: "agent.text.delta",
                  payload: { ...ids, delta: receipt.slice(0, 17) },
                };
                yield { type: "agent.text.delta", payload: { ...ids, delta: receipt.slice(17) } };
              }
              continue;
            }
            yield event;
            if (event.type === "agent.message.start")
              yield {
                type: "agent.text.delta",
                payload: { ...ids, delta: "I'll check whether this task already exists." },
              };
            if (event.type === "agent.tool.result" && event.payload.toolCallId === "call_0")
              yield {
                type: "agent.text.delta",
                payload: { ...ids, delta: "No matching task exists; I'll add it now." },
              };
          }
        },
      };
      const { runner } = agent(backend);
      expect(await runner.drain()).toBe(1);
      const run = getNoteRuns(db, [id]).get(id)!;
      expect(run).toMatchObject({
        state: "done",
        receipt: {
          text: hasFinalText ? receipt : "Added: Prepare the greenhouse seed trays",
          changes: [
            { text: "Added: Prepare the greenhouse seed trays", undoSeq: expect.any(Number) },
          ],
        },
      });
      expect(listOpenLoops(db, {})).toEqual([
        expect.objectContaining({ title: "Prepare the greenhouse seed trays", origin: "note" }),
      ]);
    },
  );

  test("the turn is offered memory and read tools beside the task tools", async () => {
    const remembered: unknown[] = [];
    let evidenceResult: unknown;
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
        () => [
          { tool: "annotate_person", args: { text: "vegetarian" } },
          { tool: "conversation_memory_evidence", args: {} },
        ],
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
              ...evidenceTools.map((tool) => ({
                ...tool,
                async invoke(...args: Parameters<ToolHandle["invoke"]>) {
                  const result = await tool.invoke(...args);
                  evidenceResult = result;
                  return result;
                },
              })),
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
    expect(evidenceResult).toMatchObject({
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
            text: "An action was applied before processing stopped. Review the result before asking again. Created watch “Greenhouse supplies”. Notify when greenhouse supplies are ready.",
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

  test.each(["watch_create", "watch_update"])(
    "%s reporting an installed but unarmed watch is not replayed after a model failure",
    async (toolName) => {
      const id = queueNote("Notify me when the greenhouse seed trays are delivered.");
      let now = T0 + 60_000;
      let committedWrites = 0;
      const watch: ToolHandle = {
        name: toolName,
        description: "Save the requested watch, then try to arm it.",
        mutates: true,
        schema: z.object({ request: z.string(), watchId: z.string().optional() }),
        async invoke() {
          committedWrites += 1;
          return {
            kind: "error",
            code: "unarmed",
            message: "The watch was written and installed, but could not be armed and is held.",
          };
        },
      };
      const scripted = toolCallingBackend(
        () => [
          {
            tool: toolName,
            args: { request: "Seed trays delivered", watchId: "watch_greenhouse" },
          },
        ],
        "",
      );
      const backend: ChatBackend = {
        name: "scripted",
        model: "scripted-model",
        async *runTurn(input) {
          for await (const event of scripted.runTurn(input))
            if (event.type !== "agent.message.end" && event.type !== "agent.text.delta")
              yield event;
          throw new Error("scripted outage after the watch was stored");
        },
      };
      const { runner } = agent(backend, {
        clock: () => now,
        buildTools: (_, taskTools) => ({ tools: [...taskTools, watch], dispose: async () => {} }),
      });
      expect(await runner.drain()).toBe(1);
      expect(getNoteRuns(db, [id]).get(id)).toMatchObject({
        state: "done",
        attempts: 1,
        error: null,
        receipt: {
          text: "An action was applied before processing stopped. Review the result before asking again.",
          changes: [],
        },
      });
      now += 6 * 60_000;
      expect(await runner.drain()).toBe(0);
      expect(committedWrites).toBe(1);
    },
  );

  test.each([true, false])(
    "a throwing task write is not replayed when it may have committed (committed=%s)",
    async (committed) => {
      const id = queueNote("Add a task to label the greenhouse seed trays.");
      let now = T0 + 60_000;
      let writes = 0;
      const service = new TaskService(db, directWriteGate(db), () => now);
      const { runner } = agent(
        toolCallingBackend(
          () => [{ tool: "task_create", args: { title: "Label the greenhouse seed trays" } }],
          "",
        ),
        {
          clock: () => now,
          tasks: {
            async apply(command) {
              writes += 1;
              if (committed) await service.apply(command);
              throw new Error(committed ? "mirror failed after commit" : "writer unavailable");
            },
          },
        },
      );
      expect(await runner.drain()).toBe(1);
      expect(getNoteRuns(db, [id]).get(id)).toMatchObject({
        state: "done",
        attempts: 1,
        receipt: {
          text: "An action may have been applied. Review the result before asking again.",
          changes: [],
        },
      });
      expect(listOpenLoops(db, {})).toHaveLength(committed ? 1 : 0);
      now += 6 * 60_000;
      expect(await runner.drain()).toBe(0);
      expect(writes).toBe(1);
      expect(listOpenLoops(db, {})).toHaveLength(committed ? 1 : 0);
    },
  );

  test("an uncertain write is disclosed even when the backend recovers and finishes", async () => {
    const id = queueNote("Update the greenhouse supplies watch.");
    const backend: ChatBackend = {
      name: "scripted",
      model: "scripted-model",
      async *runTurn(input) {
        const ids = { sessionId: input.sessionId, messageId: input.messageId };
        yield { type: "agent.message.start", payload: { ...ids, role: "assistant" } };
        yield {
          type: "agent.tool.start",
          payload: { ...ids, toolCallId: "call_watch", tool: "watch_update", args: {} },
        };
        try {
          await input.tools.find((tool) => tool.name === "watch_update")!.invoke({}, ids);
        } catch {
          // A backend may handle a tool exception and still complete its response.
        }
        yield { type: "agent.text.delta", payload: { ...ids, delta: "Nothing was changed." } };
        yield { type: "agent.message.end", payload: { ...ids, stopReason: "end_turn" } };
      },
    };
    const { runner } = agent(backend, {
      buildTools: (_, taskTools) => ({
        tools: [
          ...taskTools,
          {
            name: "watch_update",
            description: "Update the requested watch.",
            mutates: true,
            schema: z.object({}),
            async invoke() {
              throw new Error("unknown write outcome");
            },
          },
        ],
        dispose: async () => {},
      }),
    });
    await runner.drain();
    expect(getNoteRuns(db, [id]).get(id)).toMatchObject({
      state: "done",
      receipt: {
        text: "An action may have been applied. Review the result before asking again.",
        changes: [],
      },
    });
  });

  test.each(["conversation_memory_evidence", "cite_record"])(
    "throwing replayable bookkeeping %s keeps the note retryable",
    async (name) => {
      const id = queueNote("Remember the greenhouse seed delivery date.");
      let now = T0 + 60_000;
      let calls = 0;
      const { runner } = agent(
        toolCallingBackend(() => [{ tool: name, args: {} }], ""),
        {
          clock: () => now,
          buildTools: (_, taskTools) => ({
            tools: [
              ...taskTools,
              {
                name,
                description: "Prepare replayable evidence or citation bookkeeping.",
                mutates: true,
                schema: z.object({}),
                async invoke() {
                  calls += 1;
                  throw new Error("bookkeeping unavailable");
                },
              },
            ],
            dispose: async () => {},
          }),
        },
      );
      await runner.drain();
      expect(getNoteRuns(db, [id]).get(id)).toMatchObject({ state: "pending", attempts: 1 });
      now += 6 * 60_000;
      expect(await runner.drain()).toBe(1);
      expect(calls).toBe(2);
      expect(getNoteRuns(db, [id]).get(id)).toMatchObject({ state: "pending", attempts: 2 });
    },
  );

  type WatchUpsertedResult = Extract<ToolResult, { kind: "watch.upserted" }>;

  function watchResult(overrides: Partial<WatchUpsertedResult> = {}): WatchUpsertedResult {
    return {
      kind: "watch.upserted",
      watchId: "watch_greenhouse",
      name: "greenhouse-seed-tray-delivery",
      action: "created",
      enabled: true,
      interpretation: "Notify when the greenhouse seed trays are delivered.",
      ...overrides,
    };
  }

  async function watchReceipt(
    results: ToolResult[],
    options: { mixed?: boolean; fail?: boolean; uncertain?: boolean } = {},
  ) {
    const id = queueNote("Watch for the greenhouse delivery and carry out the requested updates.");
    let index = 0;
    const calls = results.map((result) => ({
      tool:
        result.kind === "watch.upserted"
          ? result.action === "updated"
            ? "watch_update"
            : "watch_create"
          : "watch_delete",
      args: {},
    }));
    if (options.mixed) {
      calls.push({ tool: "task_create", args: { title: "Prepare the seed trays" } });
      calls.push({ tool: "annotate_person", args: {} });
    }
    if (options.uncertain) calls.push({ tool: "notes_append", args: {} });
    const scripted = toolCallingBackend(
      () => calls,
      "Created the requested Greenhouse delivery reminder.",
    );
    const backend: ChatBackend = {
      name: "scripted",
      model: "scripted-model",
      async *runTurn(input) {
        for await (const event of scripted.runTurn(input))
          if (
            !options.fail ||
            (event.type !== "agent.message.end" && event.type !== "agent.text.delta")
          )
            yield event;
        if (options.fail) throw new Error("scripted outage after the watch call");
      },
    };
    const { runner } = agent(backend, {
      buildTools: (_, taskTools) => ({
        tools: [
          ...taskTools,
          ...["watch_create", "watch_update", "watch_delete"].map((name): ToolHandle => ({
            name,
            description: "Persist the requested watch action.",
            mutates: true,
            schema: z.object({}),
            invoke: async () => results[index++]!,
          })),
          {
            name: "annotate_person",
            description: "Remember the requested preference.",
            mutates: true,
            schema: z.object({}),
            invoke: async () => ({
              kind: "structured",
              resultType: "person_annotation.created",
              data: { id: "panno_preference" },
            }),
          },
          {
            name: "notes_append",
            description: "Append requested memory.",
            mutates: true,
            schema: z.object({}),
            async invoke() {
              throw new Error("uncertain notes write");
            },
          },
        ],
        dispose: async () => {},
      }),
    });
    await runner.drain();
    return getNoteRuns(db, [id]).get(id)!;
  }

  test("watch receipts use saved canonical names and interpretations instead of the model's invented label", async () => {
    const run = await watchReceipt([watchResult({ summary: "A caption chosen by the model" })]);
    expect(run.receipt?.text).toBe(
      "Created watch “greenhouse-seed-tray-delivery”. Notify when the greenhouse seed trays are delivered.",
    );
    expect(run.receipt?.text).not.toContain("Greenhouse delivery reminder");
    expect(run.receipt?.text).not.toContain("caption chosen");
  });

  test("a watch's latest update replaces its earlier name and interpretation in the receipt", async () => {
    const run = await watchReceipt([
      watchResult({ name: "old-seed-delivery", interpretation: "Old condition." }),
      watchResult({
        action: "updated",
        name: "current-seed-delivery",
        interpretation: "Current condition.",
      }),
    ]);
    expect(run.receipt?.text).toBe("Updated watch “current-seed-delivery”. Current condition.");
  });

  test("a removed watch is not reported as still saved", async () => {
    const run = await watchReceipt([
      watchResult(),
      { kind: "structured", resultType: "watch.removed", data: { watchId: "watch_greenhouse" } },
    ]);
    expect(run.receipt?.text).toBe("Removed watch “greenhouse-seed-tray-delivery”.");
    expect(run.receipt?.text).not.toContain("Created");
    const removal = await watchReceipt([
      { kind: "structured", resultType: "watch.removed", data: { watchId: "watch_other" } },
    ]);
    expect(removal.receipt?.text).toBe("Removed the requested watch.");
  });

  test("a mixed watch, task and memory note reports grounded actions and advisory warnings", async () => {
    const run = await watchReceipt(
      [watchResult({ enabled: false, warnings: ["Push delivery is not configured."] })],
      { mixed: true },
    );
    expect(run.receipt?.text).toBe(
      "Created watch “greenhouse-seed-tray-delivery” (not enabled). Push delivery is not configured. Added: Prepare the seed trays Other changes were also applied. Notify when the greenhouse seed trays are delivered.",
    );
    expect(run.receipt?.changes).toEqual([
      expect.objectContaining({
        text: "Added: Prepare the seed trays",
        undoSeq: expect.any(Number),
      }),
    ]);
  });

  test.each([false, true])(
    "review warnings retain priority and canonical watch identity (uncertain=%s)",
    async (uncertain) => {
      const run = await watchReceipt(
        [watchResult()],
        uncertain ? { uncertain: true } : { fail: true },
      );
      expect(run.state).toBe("done");
      expect(run.receipt?.text).toBe(
        `${uncertain ? "An action may have been applied." : "An action was applied before processing stopped."} Review the result before asking again. Created watch “greenhouse-seed-tray-delivery”. Notify when the greenhouse seed trays are delivered.`,
      );
    },
  );

  test("a long interpretation cannot truncate the canonical name or delivery warning", async () => {
    const run = await watchReceipt([
      watchResult({
        interpretation: "Detailed condition. ".repeat(150),
        warnings: ["Push delivery is not configured."],
      }),
    ]);
    expect(run.receipt?.text).toHaveLength(1000);
    expect(
      run.receipt?.text?.startsWith(
        "Created watch “greenhouse-seed-tray-delivery”. Push delivery is not configured.",
      ),
    ).toBe(true);
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

  test.each([null, "2026-05-18"])(
    "a first-person completion report looks up a matching task beyond today's list (schedule=%s)",
    async (scheduledFor) => {
      const id = "loop_astronomy";
      expect(
        applyTaskCommand(
          db,
          {
            surface: "tasks",
            runId: "user:tasks",
            kind: "create",
            id,
            origin: "user",
            title: "Archive the astronomy club poster",
            scheduledFor,
          },
          T0,
        ).ok,
      ).toBe(true);
      const noteId = queueNote("I have archived the astronomy club poster.");
      const seen: TurnInput[] = [];
      const results: ToolResult[] = [];
      const inner = toolCallingBackend(
        (input) => {
          expect(input.systemPrompt).toContain("task progress even without an explicit command");
          expect(input.systemPrompt).toContain("short salient terms across task views");
          expect(input.systemPrompt).toContain(
            "Other information with no request and no task progress",
          );
          return [
            { tool: "task_list", args: { query: "astronomy" } },
            { tool: "task_update", args: { id, action: "complete" } },
          ];
        },
        "Marked archiving the astronomy club poster done.",
        seen,
      );
      const backend: ChatBackend = {
        ...inner,
        async *runTurn(input) {
          for await (const event of inner.runTurn(input)) {
            if (event.type === "agent.tool.result") results.push(event.payload.result);
            yield event;
          }
        },
      };
      const { runner } = agent(backend);
      expect(await runner.drain()).toBe(1);
      expect(results[0]).toMatchObject({
        kind: "structured",
        resultType: "task.list",
        data: { tasks: [expect.objectContaining({ id })] },
      });
      expect(getOpenLoop(db, id)).toMatchObject({ state: "done", accepted: true });
      expect(listOpenLoops(db, {})).toHaveLength(1);
      expect(getNoteRuns(db, [noteId]).get(noteId)?.receipt?.changes).toEqual([
        expect.objectContaining({ taskId: id, text: expect.stringContaining("Done") }),
      ]);
      expect(seen).toHaveLength(1);
    },
  );

  test.each([
    ["partial", "I have started archiving the astronomy club poster.", 1],
    ["negated", "I have not archived the astronomy club poster.", 1],
    ["future", "I will archive the astronomy club poster tomorrow.", 1],
    ["ambiguous", "I have archived the astronomy club poster.", 2],
    ["unmatched", "I have archived the astronomy club poster.", 0],
  ] as const)("%s reports leave tasks unchanged after lookup", async (_kind, text, matches) => {
    for (let n = 0; n < matches; n++)
      expect(
        applyTaskCommand(
          db,
          {
            surface: "tasks",
            runId: "user:tasks",
            kind: "create",
            id: `loop_astronomy_${n}`,
            origin: "user",
            title: `Archive the astronomy club poster ${n + 1}`,
          },
          T0,
        ).ok,
      ).toBe(true);
    const noteId = queueNote(text);
    const { runner } = agent(
      toolCallingBackend((input) => {
        expect(input.systemPrompt).toContain(
          "Partial progress, negation and future intent do not mean completion",
        );
        expect(input.systemPrompt).toContain(
          "If no task matches or the match is ambiguous, do not create or change a task",
        );
        return [{ tool: "task_list", args: { query: "astronomy" } }];
      }, "Saved the note; no task was marked done."),
    );
    expect(await runner.drain()).toBe(1);
    expect(listOpenLoops(db, {})).toHaveLength(matches);
    expect(listOpenLoops(db, {}).every((task) => task.state === "open")).toBe(true);
    expect(getNoteRuns(db, [noteId]).get(noteId)?.receipt).toMatchObject({
      text: "Saved the note; no task was marked done.",
      changes: [],
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

describe("note agent pending action lifetime", () => {
  test("an HTTP tool batch cancelled by read progress cannot replay a still-running write", async () => {
    const id = queueNote("Watch for a greenhouse delivery update");
    const abort = new AbortController();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutMock = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => (ms === NOTE_AGENT_TURN_TIMEOUT_MS ? abort.signal : timeout(ms)));
    const chunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "write", function: { name: "watch_create", arguments: "{}" } },
                { index: 1, id: "read", function: { name: "fetch_many", arguments: "{}" } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]",
    ];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          chunks
            .map(
              (chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`,
            )
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    const writer: ToolHandle = {
      name: "watch_create",
      description: "A held scripted write.",
      schema: z.object({}),
      mutates: true,
      async invoke() {
        enter();
        await held;
        finished = true;
        return { kind: "structured", resultType: "scripted.changed", data: {} };
      },
    };
    const reader: ToolHandle = {
      name: "fetch_many",
      description: "A progress-producing scripted read.",
      schema: z.object({}),
      async invoke(_args, context) {
        await entered;
        abort.abort();
        const result: ToolResult = { kind: "structured", resultType: "scripted.read", data: {} };
        context.onChildResult?.({ index: 0, result });
        return result;
      },
    };
    const backend = new HttpChatBackend({ baseUrl: "http://127.0.0.1:9", model: "scripted" });
    const { runner } = agent(backend, {
      buildTools: () => ({ tools: [writer, reader], dispose: async () => {} }),
    });
    try {
      expect(await runner.drain()).toBe(1);
      expect(finished).toBe(false);
      expect(getNoteRuns(db, [id]).get(id)).toMatchObject({
        state: "done",
        attempts: 1,
        receipt: { text: expect.stringContaining("still running and may finish after this note") },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      fetchMock.mockRestore();
      timeoutMock.mockRestore();
    }
    expect(finished).toBe(true);
    expect(await runner.drain()).toBe(0);
  });

  function pendingTurn(options: {
    stop: "error" | "canceled" | "end_turn";
    name?: string;
    mutates?: boolean;
    cleanupResult?: "applied" | "error";
  }) {
    const id = queueNote("Watch for a greenhouse delivery update");
    let now = T0 + 60_000;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pending: Promise<ToolResult> | undefined;
    let calls = 0;
    let writes = 0;
    const tool: ToolHandle = {
      name: options.name ?? "watch_create",
      description: "A held scripted operation.",
      mutates: options.mutates ?? true,
      schema: z.object({}).strict(),
      async invoke() {
        calls += 1;
        await gate;
        if (options.cleanupResult === "error")
          return { kind: "error", code: "refused", message: "Nothing was written." };
        writes += 1;
        return { kind: "structured", resultType: "scripted.changed", data: {} };
      },
    };
    const backend: ChatBackend = {
      name: "scripted",
      model: "scripted-model",
      async *runTurn(input) {
        pending = input.tools
          .find((handle) => handle.name === tool.name)!
          .invoke(
            {},
            {
              sessionId: input.sessionId,
              messageId: input.messageId,
            },
          );
        yield {
          type: "agent.message.end",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            stopReason: options.stop,
          },
        };
      },
    };
    const { runner } = agent(backend, {
      clock: () => now,
      buildTools: () => ({
        tools: [tool],
        dispose: async () => {
          if (options.cleanupResult) {
            release();
            await pending;
          }
        },
      }),
    });
    return {
      id,
      runner,
      calls: () => calls,
      writes: () => writes,
      advance: () => {
        now += 6 * 60_000;
      },
      finish: async () => {
        release();
        await pending;
      },
    };
  }

  test.each(["error", "canceled", "end_turn"] as const)(
    "%s with an admitted unfinished action is reviewable and never replayed",
    async (stop) => {
      const turn = pendingTurn({ stop });
      try {
        expect(await turn.runner.drain()).toBe(1);
        expect(turn.writes()).toBe(0);
        expect(getNoteRuns(db, [turn.id]).get(turn.id)).toMatchObject({
          state: "done",
          attempts: 1,
          receipt: {
            text: "An action is still running and may finish after this note. Review the result before asking again.",
          },
        });
        await turn.finish();
        expect(turn.writes()).toBe(1);
        turn.advance();
        expect(await turn.runner.drain()).toBe(0);
        expect(turn.calls()).toBe(1);
      } finally {
        await turn.finish();
      }
    },
  );

  test.each(["error", "applied"] as const)(
    "cleanup settles an action as %s before deciding whether to replay",
    async (cleanupResult) => {
      const turn = pendingTurn({ stop: "error", cleanupResult });
      try {
        await turn.runner.drain();
        const row = getNoteRuns(db, [turn.id]).get(turn.id);
        expect(row?.state).toBe(cleanupResult === "error" ? "pending" : "done");
        expect(turn.writes()).toBe(cleanupResult === "error" ? 0 : 1);
        if (cleanupResult === "applied")
          expect(row?.receipt?.text).toBe(
            "An action was applied before processing stopped. Review the result before asking again.",
          );
      } finally {
        await turn.finish();
      }
    },
  );

  test.each([
    { name: "conversation_memory_evidence", mutates: true },
    { name: "cite_record", mutates: true },
    { name: "search_many", mutates: false },
  ])("pending $name does not block a safe retry", async ({ name, mutates }) => {
    const turn = pendingTurn({ stop: "error", name, mutates });
    try {
      await turn.runner.drain();
      expect(getNoteRuns(db, [turn.id]).get(turn.id)).toMatchObject({
        state: "pending",
        attempts: 1,
        receipt: null,
      });
    } finally {
      await turn.finish();
    }
  });
});

describe("note agent tool admission lifetime", () => {
  test("retired task handles cannot write during cleanup or later, while a fresh note can", async () => {
    queueNote("Save this note without a task");
    let captured:
      { handle: ToolHandle; context: { sessionId: string; messageId: string } } | undefined;
    const cleanupResults: ToolResult[] = [];
    const tasks = new TaskService(db, directWriteGate(db), () => T0 + 60_000);
    const apply = vi.fn((command: Parameters<TaskService["apply"]>[0]) => tasks.apply(command));
    const backend = toolCallingBackend((input) => {
      captured = {
        handle: input.tools.find((tool) => tool.name === "task_create")!,
        context: { sessionId: input.sessionId, messageId: input.messageId },
      };
      return input.userMessage.includes("Add a fresh task")
        ? [{ tool: "task_create", args: { title: "Plant a rooftop garden" } }]
        : [];
    }, "Saved.");
    const { runner } = agent(backend, {
      tasks: { apply },
      buildTools: (_runId, taskTools) => ({
        tools: taskTools,
        dispose: async () => {
          cleanupResults.push(
            await captured!.handle.invoke({ title: "Late orphaned task" }, captured!.context),
          );
        },
      }),
    });
    expect(await runner.drain()).toBe(1);
    const retired = captured!;
    expect(cleanupResults).toEqual([
      expect.objectContaining({ kind: "error", code: "note_finished" }),
    ]);
    expect(
      await retired.handle.invoke({ title: "Another late task" }, retired.context),
    ).toMatchObject({
      kind: "error",
      code: "note_finished",
    });
    expect(apply).not.toHaveBeenCalled();
    expect(listOpenLoops(db, {})).toEqual([]);

    queueNote("Add a fresh task");
    expect(await runner.drain()).toBe(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(listOpenLoops(db, {})).toEqual([
      expect.objectContaining({ title: "Plant a rooftop garden", origin: "note" }),
    ]);
    expect(cleanupResults).toHaveLength(2);
    expect(cleanupResults[1]).toMatchObject({ kind: "error", code: "note_finished" });
    expect(await retired.handle.invoke({ title: "Still retired" }, retired.context)).toMatchObject({
      kind: "error",
      code: "note_finished",
    });
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

describe("owner note edit revisions", () => {
  function edit(id: string, text: string, at: number, owner = true, enabled = true) {
    expect(updateNoteEntryText(db, id, text, new Date(at).toISOString(), { owner, enabled })).toBe(
      true,
    );
  }
  function finish(row: NonNullable<ReturnType<typeof claimDueNote>>, text = "Applied.") {
    finishNoteRun(
      db,
      row.entryId,
      row.attempts,
      {
        state: "done",
        receipt: {
          text,
          changes: [{ text: "Added workshop", taskId: "loop_workshop", undoSeq: 1 }],
        },
      },
      T0 + 60_000,
    );
  }
  test("same-text edits create no turn; equal/backwards writer clocks still advance updatedAt", () => {
    const id = queueNote("Prepare the robotics workshop");
    const row = claimDueNote(db, T0 + 60_000)!;
    finish(row);
    edit(id, row.inputText, T0 + 1_000);
    expect(getNoteRuns(db, [id]).get(id)?.revision).toBe(0);
    const first = getNoteEntry(db, id)!.updatedAt;
    edit(id, "Prepare the robotics workshop Saturday", T0 + 1_000);
    const second = getNoteEntry(db, id)!.updatedAt;
    edit(id, "Prepare the robotics workshop Sunday", T0);
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));
    expect(Date.parse(getNoteEntry(db, id)!.updatedAt)).toBeGreaterThan(Date.parse(second));
    const current = claimDueNote(db, T0 + 120_000)!;
    expect(current.inputText).toContain("Sunday");
    expect(current.previousText).toBe(row.inputText);
    expect(current.previousReceipt?.changes[0]?.taskId).toBe("loop_workshop");
    expect(current.attempts).toBe(2);
    expect(claimDueNote(db, T0 + 120_000)).toBeNull();
  });
  test("rapid unclaimed edits coalesce without dropping the original unexecuted intent", () => {
    const id = queueNote("Prepare a workshop Friday");
    edit(id, "Prepare a workshop Saturday", T0 + 2_000);
    edit(id, "Prepare a workshop Sunday", T0 + 2_000);
    const latest = claimDueNote(db, T0 + 60_000)!;
    expect(latest.inputText).toContain("Sunday");
    expect(latest.previousText).toBe("Prepare a workshop Saturday");
    finish(latest);
    expect(claimDueNote(db, T0 + 120_000)).toBeNull();
    expect(hasPendingNotes(db)).toBe(false);
  });
  test.each([false, true])(
    "edits before first claim carry a system diff and fulfill all unexecuted requests once (rapid=%s)",
    async (rapid) => {
      const original = "Prepare the robotics workshop Friday. Also buy seed trays.";
      const intermediate = "Prepare the robotics workshop Saturday. Also buy seed trays.";
      const current = "Prepare the robotics workshop Sunday. Also buy seed trays.";
      const id = queueNote(original);
      if (rapid) edit(id, intermediate, T0 + 2_000);
      edit(id, current, T0 + 2_000);
      const seen: TurnInput[] = [];
      const backend = toolCallingBackend(
        () => [
          { tool: "task_list", args: { query: "robotics workshop" } },
          {
            tool: "task_create",
            args: { title: "Prepare the robotics workshop", scheduledFor: "2026-03-15" },
          },
          { tool: "task_list", args: { query: "seed trays" } },
          { tool: "task_create", args: { title: "Buy seed trays" } },
        ],
        "Added the workshop and seed trays.",
        seen,
      );
      const { runner } = agent(backend);
      expect(await runner.drain()).toBe(1);
      expect(await runner.drain()).toBe(0);
      expect(seen).toHaveLength(1);
      const metadata = JSON.parse(
        /<note_edit_context>\n([\s\S]*?)\n<\/note_edit_context>/.exec(seen[0]!.systemPrompt)![1]!,
      );
      const previous = rapid ? intermediate : original;
      expect(metadata.previousText).toBe(previous);
      expect(metadata.previousReceipt).toBeNull();
      expect(metadata.change).toEqual(noteTextChange(previous, current));
      expect(seen[0]?.systemPrompt).toContain("No prior confirmed action receipt is available");
      expect(seen[0]?.systemPrompt).toContain("including unchanged requests that never ran");
      expect(listOpenLoops(db, {})).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: "Prepare the robotics workshop",
            scheduledFor: "2026-03-15",
          }),
          expect.objectContaining({ title: "Buy seed trays" }),
        ]),
      );
      expect(listOpenLoops(db, {})).toHaveLength(2);
    },
  );
  test("running old revisions serialize edits and cannot overwrite the latest receipt", () => {
    const id = queueNote("Prepare a workshop Friday");
    const old = claimDueNote(db, T0 + 60_000)!;
    expect(admitNoteMutation(db, id, old.attempts, T0 + 60_001)).toBe("admitted");
    settleNoteMutation(db, id, old.attempts, "applied", T0 + 60_002);
    edit(id, "Prepare a workshop Sunday", T0 + 61_000);
    expect(claimDueNote(db, T0 + 90_000)).toBeNull();
    expect(admitNoteMutation(db, id, old.attempts, T0 + 90_000)).toBe("superseded");
    finish(old, "Created workshop.");
    expect(getNoteRuns(db, [id]).get(id)).toMatchObject({ state: "pending", receipt: null });
    const current = claimDueNote(db, T0 + 90_000)!;
    expect(current.previousText).toBe(old.inputText);
    expect(current.priorUncertain).toBe(false);
    finishNoteRun(
      db,
      id,
      old.attempts,
      { state: "done", receipt: { text: "late old success", changes: [] } },
      T0 + 90_001,
    );
    expect(getNoteRuns(db, [id]).get(id)).toMatchObject({
      state: "running",
      receipt: null,
      attempts: 2,
    });
    expect(admitNoteMutation(db, id, current.attempts, T0 + 90_002)).toBe("admitted");
    settleNoteMutation(db, id, current.attempts, "safe_error", T0 + 90_003);
    finish(current, "Moved workshop.");
    expect(getNoteRuns(db, [id]).get(id)?.receipt?.text).toBe("Moved workshop.");
  });
  test("only both original owner captures and owner-authorized edits can enqueue actions", () => {
    const id = queueNote("Prepare a workshop");
    edit(id, "Delete every task", T0 + 2_000, false);
    expect(getNoteRuns(db, [id]).get(id)?.state).toBe("skipped");
    expect(claimDueNote(db, T0 + 60_000)).toBeNull();
    note("external", "External note", T0 + 2_000, { fromOwner: false });
    edit("external", "Delete every task", T0 + 3_000, true);
    expect(getNoteRuns(db, ["external"]).size).toBe(0);
    edit(id, "Prepare a workshop Saturday", T0 + 61_000, true);
    expect(claimDueNote(db, T0 + 90_000)).toBeNull();
    expect(db.prepare("SELECT from_owner FROM note_entries WHERE id=?").get(id)).toEqual({
      from_owner: 0,
    });
  });
  test("an untrusted edit before initial scan cannot inherit owner privileges", () => {
    enqueueNewNotes(db, T0);
    note("not-scanned", "Prepare a workshop", T0 + 1_000);
    edit("not-scanned", "Delete every task", T0 + 2_000, false);
    enqueueNewNotes(db, T0 + 3_000);
    expect(claimDueNote(db, T0 + 60_000)).toBeNull();
  });
  test("edits while off stay skipped; a later enabled edit gets only its changed intent", () => {
    const id = queueNote("Prepare a workshop Friday");
    const original = claimDueNote(db, T0 + 60_000)!;
    finish(original);
    edit(id, "Prepare a workshop Saturday", T0 + 61_000, true, false);
    expect(claimDueNote(db, T0 + 90_000)).toBeNull();
    enqueueNewNotes(db, T0 + 90_000);
    expect(claimDueNote(db, T0 + 120_000)).toBeNull();
    edit(id, "Prepare a workshop Sunday", T0 + 121_000);
    const current = claimDueNote(db, T0 + 150_000)!;
    expect(current.previousText).toContain("Friday");
    expect(current.previousReceipt).toMatchObject({ text: "Applied." });
    expect(noteTextChange(current.previousText!, current.inputText)).toEqual({
      removed: "Fri",
      added: "Sun",
    });
  });
  test("a crash after writer admission never replays and makes later edits read-only", () => {
    const id = queueNote("Create a workshop watch");
    const original = claimDueNote(db, T0 + 60_000)!;
    expect(admitNoteMutation(db, id, original.attempts, T0 + 60_001)).toBe("admitted");
    expect(claimDueNote(db, T0 + 60_002 + NOTE_RUN_STALE_MS)).toBeNull();
    expect(getNoteRuns(db, [id]).get(id)).toMatchObject({
      state: "done",
      receipt: { text: expect.stringContaining("may have been applied") },
    });
    edit(id, "Create a workshop watch Saturday", T0 + 61_000 + NOTE_RUN_STALE_MS);
    const current = claimDueNote(db, T0 + 90_000 + NOTE_RUN_STALE_MS)!;
    expect(current.priorUncertain).toBe(true);
    expect(admitNoteMutation(db, id, current.attempts, T0 + 90_001 + NOTE_RUN_STALE_MS)).toBe(
      "review_required",
    );
  });
  test("safe errors and completed corrections do not consume a later revision's retries", () => {
    const id = queueNote("Prepare a workshop Friday");
    for (let n = 0; n < 5; n++) {
      const current = claimDueNote(db, T0 + 60_000 + n * 60_000)!;
      expect(current).not.toBeNull();
      expect(admitNoteMutation(db, id, current.attempts, T0 + 60_001 + n * 60_000)).toBe(
        "admitted",
      );
      settleNoteMutation(db, id, current.attempts, "safe_error", T0 + 60_002 + n * 60_000);
      finish(current);
      edit(id, `Prepare workshop revision ${n}`, T0 + 61_000 + n * 60_000);
    }
  });
  test("upgrading the legacy queue preserves receipts and fences interrupted actions", () => {
    const id = queueNote("Prepare a workshop");
    db.exec(
      "DROP TABLE note_agent_runs; CREATE TABLE note_agent_runs(entry_id TEXT PRIMARY KEY,state TEXT,attempts INTEGER,run_after INTEGER,receipt_json TEXT,error TEXT,created_at INTEGER,updated_at INTEGER)",
    );
    db.prepare("INSERT INTO note_agent_runs VALUES(?,'running',1,1,NULL,NULL,1,1)").run(id);
    createNoteAgentTables(db);
    createNoteAgentTables(db);
    expect(getNoteRuns(db, [id]).get(id)).toMatchObject({
      revision: 0,
      state: "done",
      inputText: "Prepare a workshop",
    });
    expect(claimDueNote(db, T0 + 90_000)).toBeNull();
  });
  test.each([
    ["An action may have been applied. Review it.", true],
    ["An action is still running and may finish after this note. Review it.", true],
    ["Created the requested workshop task.", false],
  ] as const)("legacy completed receipts preserve action uncertainty: %s", (text, uncertain) => {
    const id = queueNote("Prepare a robotics workshop Friday");
    db.exec(
      "DROP TABLE note_agent_runs; CREATE TABLE note_agent_runs(entry_id TEXT PRIMARY KEY,state TEXT,attempts INTEGER,run_after INTEGER,receipt_json TEXT,error TEXT,created_at INTEGER,updated_at INTEGER)",
    );
    const receipt = {
      text,
      changes: [{ text: "Created workshop", taskId: "loop_workshop", undoSeq: 1 }],
    };
    db.prepare("INSERT INTO note_agent_runs VALUES(?,'done',1,1,?,NULL,1,1)").run(
      id,
      JSON.stringify(receipt),
    );
    createNoteAgentTables(db);
    expect(getNoteRuns(db, [id]).get(id)?.receipt).toEqual(receipt);
    edit(id, "Prepare a robotics workshop Sunday", T0 + 61_000);
    const current = claimDueNote(db, T0 + 90_000)!;
    expect(current.priorUncertain).toBe(uncertain);
    expect(admitNoteMutation(db, id, current.attempts, T0 + 90_001)).toBe(
      uncertain ? "review_required" : "admitted",
    );
  });
  test("text deltas preserve complete Unicode code points", () => {
    expect(noteTextChange("Prepare 🪴 workshop", "Prepare 🌵 workshop")).toEqual({
      removed: "🪴",
      added: "🌵",
    });
    expect(noteTextChange("unchanged", "unchanged")).toEqual({ removed: "", added: "" });
  });
  test("voice transcript and pending input snapshot commit atomically", () => {
    const id = queueNote("prepare robotic workshop fry day");
    db.exec(
      "CREATE TRIGGER reject_note_snapshot BEFORE UPDATE OF input_text ON note_agent_runs BEGIN SELECT RAISE(ABORT,'scripted snapshot failure'); END",
    );
    expect(() =>
      applyNoteEntryTranscript(
        db,
        id,
        "prepare robotic workshop fry day",
        "Prepare a robotics workshop Friday",
        new Date(T0 + 2_000).toISOString(),
      ),
    ).toThrow("scripted snapshot failure");
    expect(getNoteEntry(db, id)?.text).toBe("prepare robotic workshop fry day");
    expect(getNoteRuns(db, [id]).get(id)?.inputText).toBe("prepare robotic workshop fry day");
    db.exec("DROP TRIGGER reject_note_snapshot");
    expect(
      applyNoteEntryTranscript(
        db,
        id,
        "prepare robotic workshop fry day",
        "Prepare a robotics workshop Friday",
        new Date(T0 + 2_000).toISOString(),
      ),
    ).toMatchObject({ outcome: "replaced" });
    expect(claimDueNote(db, T0 + 60_000)?.inputText).toBe("Prepare a robotics workshop Friday");
  });
  test("edited turns receive the exact delta and prior receipt, with fresh attribution", async () => {
    let now = T0 + 60_000;
    const id = queueNote("Remind me to prepare a robotics workshop Friday");
    const seen: TurnInput[] = [];
    const backend = toolCallingBackend(
      () => {
        const current = listOpenLoops(db, {})[0];
        return current
          ? [{ tool: "task_update", args: { id: current.id, action: "migrate", to: "2026-03-15" } }]
          : [
              {
                tool: "task_create",
                args: { title: "Prepare a robotics workshop", scheduledFor: "2026-03-13" },
              },
            ];
      },
      "Handled workshop.",
      seen,
    );
    const { runner } = agent(backend, { clock: () => now });
    expect(await runner.drain()).toBe(1);
    const first = getNoteRuns(db, [id]).get(id)!;
    edit(id, "Remind me to prepare a robotics workshop Sunday", T0 + 61_000);
    now = T0 + 90_000;
    expect(await runner.drain()).toBe(1);
    expect(listOpenLoops(db, {})).toHaveLength(1);
    expect(seen[1]?.systemPrompt).toContain("note_edit_context");
    expect(seen[1]?.systemPrompt).toContain(JSON.stringify(first.receipt));
    expect(seen[1]?.systemPrompt).toContain('"removed":"Fri","added":"Sun"');
    expect(seen[1]?.sessionId).not.toBe(seen[0]?.sessionId);
    expect(getNoteRuns(db, [id]).get(id)?.receipt?.changes).toHaveLength(1);
  });
  test("an edit committed while mutation admission waits prevents the stale write", async () => {
    let now = T0 + 60_000;
    const id = queueNote("Prepare a robotics workshop Friday");
    const gate = directWriteGate(db);
    let edited = false;
    const backend = toolCallingBackend(
      () => [{ tool: "task_create", args: { title: "Prepare a robotics workshop" } }],
      "Created workshop.",
    );
    const { runner } = agent(backend, {
      clock: () => now,
      writeGate: {
        ...gate,
        admitNoteMutation: async (...args) => {
          if (!edited) {
            edited = true;
            edit(id, "Prepare a robotics workshop Sunday", T0 + 61_000);
          }
          return gate.admitNoteMutation(...args);
        },
      },
    });
    expect(await runner.drain()).toBe(1);
    expect(listOpenLoops(db, {})).toEqual([]);
    expect(getNoteRuns(db, [id]).get(id)).toMatchObject({ state: "pending", receipt: null });
    now = T0 + 90_000;
    expect(await runner.drain()).toBe(1);
    expect(listOpenLoops(db, {})).toHaveLength(1);
  });
  test("changed relative dates use the later edit day in the capture zone, across daylight saving", async () => {
    let now = T0 + 60_000;
    const id = queueNote("Prepare a robotics workshop Friday");
    db.prepare(
      "UPDATE note_entries SET captured_time_zone_id='America/Los_Angeles',captured_utc_offset_seconds=-28800 WHERE id=?",
    ).run(id);
    const seen: TurnInput[] = [];
    const backend = toolCallingBackend(
      (input) => {
        const task = listOpenLoops(db, {})[0];
        if (!task)
          return [
            {
              tool: "task_create",
              args: { title: "Prepare a robotics workshop", scheduledFor: "2026-03-13" },
            },
          ];
        const metadata = JSON.parse(
          /<note_edit_context>\n([\s\S]*?)\n<\/note_edit_context>/.exec(input.systemPrompt)![1]!,
        );
        const tomorrow = new Date(`${metadata.edit.day}T00:00:00Z`);
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        return [
          {
            tool: "task_update",
            args: { id: task.id, action: "migrate", to: tomorrow.toISOString().slice(0, 10) },
          },
        ];
      },
      "Handled workshop.",
      seen,
    );
    const { runner } = agent(backend, { clock: () => now });
    expect(await runner.drain()).toBe(1);
    const at = Date.parse("2026-03-22T00:30:00Z");
    edit(id, "Move the robotics workshop to tomorrow", at);
    now = at + 60_000;
    expect(await runner.drain()).toBe(1);
    const metadata = JSON.parse(
      /<note_edit_context>\n([\s\S]*?)\n<\/note_edit_context>/.exec(seen[1]!.systemPrompt)![1]!,
    );
    expect(metadata.edit).toEqual({
      at: "2026-03-22T00:30:00.000Z",
      day: "2026-03-21",
      timeZone: "America/Los_Angeles",
    });
    expect(seen[1]?.systemPrompt).toContain("overrides the original-capture date rule");
    expect(listOpenLoops(db, {})).toHaveLength(1);
    expect(listOpenLoops(db, {})[0]?.scheduledFor).toBe("2026-03-22");
  });
  test("an edit during an admitted committed action waits for its receipt then corrects the same task", async () => {
    let now = T0 + 60_000;
    const id = queueNote("Prepare a robotics workshop Friday");
    let entered!: () => void, release!: () => void;
    const committed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new TaskService(db, directWriteGate(db), () => now);
    let first = true;
    const seen: TurnInput[] = [];
    const backend = toolCallingBackend(
      () => {
        const task = listOpenLoops(db, {})[0];
        return task
          ? [{ tool: "task_update", args: { id: task.id, action: "migrate", to: "2026-03-15" } }]
          : [
              {
                tool: "task_create",
                args: { title: "Prepare a robotics workshop", scheduledFor: "2026-03-13" },
              },
            ];
      },
      "Handled workshop.",
      seen,
    );
    const { runner } = agent(backend, {
      clock: () => now,
      tasks: {
        apply: async (...args) => {
          const result = await service.apply(...args);
          if (first) {
            first = false;
            entered();
            await resume;
          }
          return result;
        },
      },
    });
    const running = runner.drain();
    await committed;
    const taskId = listOpenLoops(db, {})[0]!.id;
    edit(id, "Prepare a robotics workshop Sunday", T0 + 61_000);
    expect(getNoteRuns(db, [id]).get(id)).toMatchObject({ state: "pending", receipt: null });
    now = T0 + 62_000;
    release();
    expect(await running).toBe(1);
    now = T0 + 90_000;
    expect(await runner.drain()).toBe(1);
    expect(listOpenLoops(db, {}).map((task) => task.id)).toEqual([taskId]);
    expect(getOpenLoop(db, taskId)?.scheduledFor).toBe("2026-03-15");
    expect(seen[1]?.systemPrompt).toContain(taskId);
    expect(getNoteRuns(db, [id]).get(id)?.priorUncertain).toBe(false);
  });
  test("an uncertain action on an earlier revision allows investigation but refuses another write", async () => {
    let now = T0 + 60_000;
    const id = queueNote("Create a robotics workshop watch");
    let writes = 0,
      reads = 0;
    const backend = toolCallingBackend(
      () => [
        { tool: "read_workshop", args: {} },
        { tool: "watch_create", args: {} },
      ],
      "Handled.",
    );
    const { runner } = agent(backend, {
      clock: () => now,
      buildTools: () => ({
        tools: [
          {
            name: "read_workshop",
            description: "Read",
            schema: z.object({}),
            mutates: false,
            async invoke() {
              reads++;
              return { kind: "structured" as const, resultType: "read", data: {} };
            },
          },
          {
            name: "watch_create",
            description: "Create",
            schema: z.object({}),
            mutates: true,
            async invoke() {
              writes++;
              throw new Error("write committed then transport failed");
            },
          },
        ],
        dispose: async () => {},
      }),
    });
    expect(await runner.drain()).toBe(1);
    edit(id, "Create a robotics workshop watch Saturday", T0 + 61_000);
    now = T0 + 90_000;
    expect(await runner.drain()).toBe(1);
    expect(reads).toBe(2);
    expect(writes).toBe(1);
    expect(getNoteRuns(db, [id]).get(id)?.receipt?.text).toContain("fresh separate request");
    const fresh = queueNote("After review, create a separate robotics workshop watch");
    now = T0 + 150_000;
    expect(await runner.drain()).toBe(1);
    expect(writes).toBe(2);
    expect(getNoteRuns(db, [fresh]).get(fresh)?.priorUncertain).toBe(false);
  });
});
