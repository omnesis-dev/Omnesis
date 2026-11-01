// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { APNS_WAKE_PAYLOAD } from "@omnesis/core/push";
import { BrainBench, call, compressCognitionCadences, ref, waitFor } from "./brain-bench/index.js";

compressCognitionCadences();

const REQUEST = "Cancel the reminder to restock the copper clips.";
const QUESTION = "I found a task for brass clips, not copper clips. Did you mean the brass clips?";
const REPLY = "Yes, cancel the brass clips task.";
const SCOPED_REQUEST =
  "About this task: add a task to clean the brass stencils, then move this task after I confirm the day.";
const CORRECTION = "Correction: move the label task to 2032-10-10 instead.";
const SCOPED_QUESTION = "Which day should I move the label-sorting task to?";
const SCOPED_REPLY = "Use the date from my correction.";
const HELPER_TITLE = "Clean the brass stencils";
const ORDINARY_NOTE =
  "The fictional workshop shutters are blue. Save the note only; no action needed.";

interface NoteReceipt {
  state: string;
  receipt: {
    text: string;
    changes: Array<{ taskId?: string; text: string }>;
    conversationId?: string;
  } | null;
}

interface NoteRow {
  id: string;
  day: string;
  text: string;
  agent?: NoteReceipt;
}

interface Conversation {
  id?: string;
  origin?: { kind: string; noteId?: string; taskId?: string; revision?: number };
  messages: unknown[];
}

describe("owner-note clarification handoff on a stable gateway", () => {
  let bench: BrainBench;
  let phone: { token: string; authToken: string };

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: false,
      universe: "e2e-minimal",
      brainAgent: false,
      syncSources: false,
      apns: true,
      agent: {
        behaviors: [
          {
            messageContains: CORRECTION,
            plan: { calls: [], finalText: "Saved your corrected plan." },
          },
          {
            messageContains: REQUEST,
            plan: {
              calls: [
                call("task_list", { query: "clips" }),
                call("continue_in_chat", { question: QUESTION, context: "No task was changed." }),
                // A handoff must end the Note turn before another action can start.
                call("task_update", {
                  id: ref("task_list", "tasks.0.id"),
                  action: "strike",
                }),
              ],
            },
          },
          {
            messageContains: REPLY,
            plan: {
              calls: [
                call("task_list", { query: "brass clips" }),
                call("task_update", {
                  id: ref("task_list", "tasks.0.id"),
                  action: "strike",
                }),
              ],
              finalText: "Cancelled the brass clips task.",
            },
          },
          {
            messageContains: SCOPED_REQUEST,
            plan: {
              calls: [
                call("task_create", { title: HELPER_TITLE }),
                call("continue_in_chat", {
                  question: SCOPED_QUESTION,
                  context: "The helper task was created successfully. Do not create it again.",
                }),
              ],
            },
          },
          {
            messageContains: SCOPED_REPLY,
            plan: {
              calls: [
                call("task_list", { query: "silver labels" }),
                call("task_update", {
                  id: ref("task_list", "tasks.0.id"),
                  action: "migrate",
                  to: "2032-10-10",
                }),
              ],
              finalText: "Moved the label task to October 10, 2032.",
            },
          },
          {
            messageContains: ORDINARY_NOTE,
            plan: { calls: [], finalText: "Saved your note." },
          },
        ],
      },
    });
    expect(
      (await bench.harness.gatewayJson<{ capabilities: Record<string, unknown> }>("/status"))
        .capabilities.taskNoteCapture,
    ).toEqual({ min: 1, max: 1 });
    phone = await bench.harness.registerFakeIosDevice("Fictional clarification phone");
  }, 240_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  async function capture(text: string, taskId?: string): Promise<NoteRow> {
    const id = randomUUID();
    const capturedAt = new Date().toISOString();
    const response = await bench.harness.gatewayFetch("/notes", {
      method: "POST",
      body: JSON.stringify({
        id,
        text,
        capturedAt,
        capturedTimeZoneId: "UTC",
        capturedUtcOffsetSeconds: 0,
        ...(taskId ? { taskId } : {}),
      }),
    });
    expect(response.status).toBe(201);
    return settledNote(id, capturedAt.slice(0, 10));
  }

  async function settledNote(id: string, day: string): Promise<NoteRow> {
    return waitFor(
      "the captured note's final result",
      async () => {
        const { entries } = await bench.harness.gatewayJson<{ entries: NoteRow[] }>(
          `/notes?day=${day}`,
        );
        const note = entries.find((entry) => entry.id === id);
        return note?.agent?.state === "done" ? note : null;
      },
      90_000,
    );
  }

  async function reply(conversationId: string, text: string): Promise<void> {
    await bench.harness.gatewayJson("/agent/sessions", {
      method: "POST",
      body: JSON.stringify({ resumeFromId: conversationId, timeZone: "UTC" }),
    });
    const response = await bench.harness.gatewayFetch(
      `/agent/sessions/${conversationId}/messages`,
      { method: "POST", body: JSON.stringify({ text }) },
    );
    expect(response.status).toBe(200);
    await waitFor(
      "the normal interactive continuation",
      async () => {
        const controls = await bench.harness.gatewayJson<{ busy: boolean }>(
          `/agent/sessions/${conversationId}/controls`,
        );
        const calls = bench.conversationCalls.filter((entry) => entry.context.message === text);
        return calls.length > 0 && !controls.busy ? true : null;
      },
      60_000,
    );
  }

  test("saves a question, privately notifies, survives restart and acts only after the reply", async () => {
    const target = await bench.obs.createTask({ title: "Restock the brass clips" });
    const taskId = target.task!.id;
    const wakesBefore = bench.harness.getApnsPushes().length;
    const note = await capture(REQUEST);
    const conversationId = note.agent!.receipt!.conversationId;
    expect(conversationId).toBeTruthy();
    expect(note.agent!.receipt!.changes).toEqual([]);
    expect((await bench.obs.task(taskId)).task.state).toBe("open");
    const conversation = await bench.harness.gatewayJson<Conversation>(
      `/agent/conversations/${conversationId!}`,
    );
    expect(conversation.origin).toMatchObject({ kind: "note", noteId: note.id });
    expect(JSON.stringify(conversation.messages)).toContain(REQUEST);
    expect(JSON.stringify(conversation.messages)).toContain(QUESTION);

    await waitFor(
      "the private conversation wake",
      async () => (bench.harness.getApnsPushes().length > wakesBefore ? true : null),
      15_000,
    );
    expect(bench.harness.getApnsPushes().at(-1)!.payload).toEqual(APNS_WAKE_PAYLOAD);
    const claim = await fetch(`${bench.harness.gatewayUrl}/notifications/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${phone.authToken}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(claim.status).toBe(200);
    const delivery = (await claim.json()) as {
      id: string;
      kind: string;
      targetId: string;
      body: string;
    };
    expect(delivery).toMatchObject({
      kind: "conversation",
      targetId: conversationId,
      body: QUESTION,
    });
    expect(
      (
        await fetch(`${bench.harness.gatewayUrl}/notifications/confirm`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${phone.authToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ id: delivery.id }),
        })
      ).status,
    ).toBe(200);

    await bench.harness.restartGateway();
    expect((await bench.obs.task(taskId)).task.state).toBe("open");
    expect(
      JSON.stringify(
        (await bench.harness.gatewayJson<Conversation>(`/agent/conversations/${conversationId!}`))
          .messages,
      ).split(QUESTION),
    ).toHaveLength(2);
    await reply(conversationId!, REPLY);
    expect((await bench.obs.task(taskId)).task.state).toBe("dismissed");
    const resumed = bench.conversationCalls.find((entry) => entry.context.message === REPLY)!;
    expect(JSON.stringify(resumed.context.history)).toContain(REQUEST);
    expect(JSON.stringify(resumed.context.history)).toContain(QUESTION);
    expect(resumed.context.systemPrompt).not.toContain("reading one note the user just told you");
  }, 240_000);

  test("keeps task context, completed work and a later correction when the user continues", async () => {
    const target = await bench.obs.createTask({ title: "Sort the silver labels" });
    const taskId = target.task!.id;
    const note = await capture(SCOPED_REQUEST, taskId);
    const conversationId = note.agent!.receipt!.conversationId;
    expect(conversationId).toBeTruthy();
    const created = note.agent!.receipt!.changes.find((change) =>
      change.text.includes(HELPER_TITLE),
    );
    expect(created?.taskId).toBeTruthy();
    expect((await bench.obs.task(taskId)).task.state).toBe("open");

    const corrected = `${SCOPED_REQUEST}\n${CORRECTION}`;
    const response = await bench.harness.gatewayFetch(`/notes/${note.id}`, {
      method: "PATCH",
      body: JSON.stringify({ text: corrected }),
    });
    expect(response.status).toBe(200);
    const edited = await settledNote(note.id, note.day);
    expect(edited.text).toBe(corrected);
    await reply(conversationId!, SCOPED_REPLY);
    expect((await bench.obs.task(taskId)).task.scheduledFor).toBe("2032-10-10");
    expect(
      (await bench.obs.tasks("anytime")).tasks.filter((task) => task.title === HELPER_TITLE),
    ).toHaveLength(1);
    const resumed = bench.conversationCalls.find(
      (entry) => entry.context.message === SCOPED_REPLY,
    )!;
    expect(resumed.context.systemPrompt).toContain(CORRECTION);
    expect(resumed.context.systemPrompt).toContain(taskId);
    expect(resumed.context.systemPrompt).toContain(created!.taskId!);
    expect(resumed.context.systemPrompt).toContain(HELPER_TITLE);
    expect(resumed.context.systemPrompt).not.toContain("reading one note the user just told you");
  }, 240_000);

  test("deleting a clarification removes its pending question and prevents recreation", async () => {
    await bench.obs.createTask({ title: "Restock the brass clips" });
    const note = await capture(REQUEST);
    const conversationId = note.agent!.receipt!.conversationId;
    expect(conversationId).toBeTruthy();
    expect(
      (
        await bench.harness.gatewayFetch(`/agent/conversations/${conversationId!}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(200);
    await bench.harness.restartGateway();
    expect(
      (await bench.harness.gatewayFetch(`/agent/conversations/${conversationId!}`)).status,
    ).toBe(404);
    const after = await settledNote(note.id, note.day);
    expect(after.agent!.receipt!.conversationId).toBeUndefined();

    let drained = false;
    for (let remaining = 0; remaining < 10; remaining++) {
      const response = await fetch(`${bench.harness.gatewayUrl}/notifications/claim`, {
        method: "POST",
        headers: { authorization: `Bearer ${phone.authToken}`, "content-type": "application/json" },
        body: "{}",
      });
      if (response.status === 204) {
        drained = true;
        break;
      }
      expect(response.status).toBe(200);
      const delivery = (await response.json()) as { id: string; targetId: string };
      expect(delivery.targetId).not.toBe(conversationId);
      expect(
        (
          await fetch(`${bench.harness.gatewayUrl}/notifications/confirm`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${phone.authToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ id: delivery.id }),
          })
        ).status,
      ).toBe(200);
    }
    expect(drained).toBe(true);
  }, 180_000);

  test("an ordinary capture stays a note without a new chat", async () => {
    const before = await bench.harness.gatewayJson<{ conversations: unknown[] }>(
      "/agent/conversations",
    );
    const note = await capture(ORDINARY_NOTE);
    expect(note.agent!.receipt).toMatchObject({ text: "Saved your note.", changes: [] });
    expect(note.agent!.receipt!.conversationId).toBeUndefined();
    const after = await bench.harness.gatewayJson<{ conversations: unknown[] }>(
      "/agent/conversations",
    );
    expect(after.conversations).toHaveLength(before.conversations.length);
  }, 120_000);
});
