// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * "Chat about this" end to end: the gateway advertises the capability, a
 * task's conversation opens empty with the task's card snapshot, and every
 * turn the user sends in it reaches the model with the task's context in the
 * system message, read from the task as it stands at that turn, including
 * after the task changes and after it is deleted.
 *
 * The model is substituted at the production `agent`-role seam with a
 * scripted OpenAI-compatible server that records every system message and
 * answers with plain text. No inference happens; the assertions are on what
 * the gateway sent.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { SyntheticE2EHarness } from "./synth-harness.js";
import {
  startOpenAiServer,
  type OpenAiServerHandle,
  type WireMessage,
} from "./brain-bench/openai-server.js";

const MODEL_ID = "task-conversation-scripted-v1";
const TURN_TIMEOUT_MS = 60_000;
const HEADING = "## The task this conversation is about";
/** Unlike anything in the prompt or the corpus: present only if the task reached the model. */
const MARKER = "ZZTASKNOTE-4c2e: the landlord asked for the signed copy by courier";

interface TaskResp {
  task: { id: string; title: string };
}
interface ConversationSummary {
  id: string;
  title: string;
  messageCount: number;
  origin?: Record<string, unknown>;
}

describe("a conversation about a task", () => {
  let harness: SyntheticE2EHarness;
  let model: OpenAiServerHandle;
  let systemPrompts: string[];

  beforeAll(async () => {
    systemPrompts = [];
    model = await startOpenAiServer({
      modelId: MODEL_ID,
      respond: (messages: readonly WireMessage[]) => {
        const system = messages.find((m) => m.role === "system")?.content;
        if (typeof system === "string") systemPrompts.push(system);
        return { kind: "text", text: "It is due on the 20th." };
      },
    });
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "e2e-minimal",
      extraInference: {
        backends: { scripted: { type: "http", url: model.url } },
        assignments: { agent: `scripted/${MODEL_ID}` },
      },
    });
    await harness.start();
  }, 240_000);

  afterAll(async () => {
    await harness?.destroy();
    await model?.close();
  });

  test("opens empty and grounds every turn in the task as it stands", async () => {
    // ── The capability clients check before offering the action ──────────
    const status = await harness.gatewayJson<{ capabilities?: Record<string, unknown> }>("/status");
    expect(status.capabilities?.taskConversations).toEqual({ min: 1, max: 1 });
    const health = await harness.gatewayJson<{ capabilities?: Record<string, unknown> }>("/health");
    expect(health.capabilities?.taskConversations).toEqual({ min: 1, max: 1 });

    // ── A task with a note and some history ──────────────────────────────
    const { task } = await harness.gatewayJson<TaskResp>("/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: "Renew the studio lease",
        description: MARKER,
        deadline: { type: "by", date: "2026-11-20" },
      }),
    });
    await harness.gatewayJson(`/tasks/${task.id}/actions`, {
      method: "POST",
      body: JSON.stringify({ action: "migrate", to: "2026-11-12" }),
    });

    // ── Chat about this ──────────────────────────────────────────────────
    const missing = await harness.gatewayFetch("/tasks/loop_missing/conversation", {
      method: "POST",
      body: "{}",
    });
    expect(missing.status).toBe(404);

    const { conversation } = await harness.gatewayJson<{ conversation: ConversationSummary }>(
      `/tasks/${task.id}/conversation`,
      { method: "POST", body: "{}" },
    );
    expect(conversation).toMatchObject({
      title: "Renew the studio lease",
      messageCount: 0,
      origin: {
        kind: "task",
        taskId: task.id,
        runId: task.id,
        task: {
          title: "Renew the studio lease",
          state: "open",
          due: "2026-11-20",
          sourceCount: 0,
        },
        seedMessageCount: 0,
      },
    });

    // The client opens it as it opens any conversation.
    const resumed = await harness.gatewayJson<{
      sessionId: string;
      messages: unknown[];
      origin?: Record<string, unknown>;
    }>("/agent/sessions", {
      method: "POST",
      body: JSON.stringify({ resumeFromId: conversation.id, timeZone: "UTC" }),
    });
    expect(resumed.sessionId).toBe(conversation.id);
    expect(resumed.messages).toEqual([]);
    expect(resumed.origin).toEqual(conversation.origin);

    // ── Turn 1: the task's context reaches the model ─────────────────────
    await sendTurn(harness, conversation.id, "When is this due?");
    const first = latest(systemPrompts);
    expect(first).toContain(HEADING);
    expect(first).toContain(`Task ${task.id}: "Renew the studio lease"`);
    expect(first).toContain("planned for 2026-11-12");
    expect(first).toContain("due 2026-11-20");
    expect(first).toContain(MARKER);
    expect(first).toMatch(/- \d{4}-\d{2}-\d{2} migrated/);

    // ── Turn 2: the task changed; the next turn reads it as it is now ────
    await harness.gatewayJson(`/tasks/${task.id}/actions`, {
      method: "POST",
      body: JSON.stringify({ action: "edit", title: "Renew the lease for unit 4" }),
    });
    await sendTurn(harness, conversation.id, "What did I change?");
    const second = latest(systemPrompts);
    expect(second).toContain(`Task ${task.id}: "Renew the lease for unit 4"`);
    expect(second).toMatch(/- \d{4}-\d{2}-\d{2} edited/);

    // ── Turn 3: the task is gone; the context says so ────────────────────
    await harness.gatewayJson(`/tasks/${task.id}/actions`, {
      method: "POST",
      body: JSON.stringify({ action: "delete" }),
    });
    await sendTurn(harness, conversation.id, "Is it still there?");
    const third = latest(systemPrompts);
    expect(third).toContain(HEADING);
    expect(third).toContain(`${task.id}, which has since been deleted`);
    expect(third).not.toContain(MARKER);

    // ── The transcript is the user's own messages, under the task's title ─
    const page = await harness.gatewayJson<{
      messages: Array<{ role: string }>;
      origin?: Record<string, unknown>;
    }>(`/agent/conversations/${conversation.id}/messages`);
    expect(page.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(page.origin).toMatchObject({ kind: "task", taskId: task.id });
    const list = await harness.gatewayJson<{ conversations: ConversationSummary[] }>(
      "/agent/conversations",
    );
    expect(list.conversations.find((c) => c.id === conversation.id)).toMatchObject({
      title: "Renew the studio lease",
      origin: { kind: "task", taskId: task.id, runId: task.id },
    });

    // A plain conversation carries no task context.
    const plain = await harness.gatewayJson<{ sessionId: string }>("/agent/sessions", {
      method: "POST",
      body: "{}",
    });
    await sendTurn(harness, plain.sessionId, "Hello");
    expect(latest(systemPrompts)).not.toContain(HEADING);
  }, 240_000);
});

function latest(prompts: readonly string[]): string {
  const last = prompts.at(-1);
  if (last === undefined) throw new Error("the scripted model was never called");
  return last;
}

/** Send one message in a live session and wait for its reply to finish. */
async function sendTurn(harness: SyntheticE2EHarness, sessionId: string, text: string) {
  const sse = await fetch(`${harness.gatewayUrl}/agent/events`, {
    headers: { Authorization: `Bearer ${harness.apiKey}`, Accept: "text/event-stream" },
  });
  if (!sse.ok || !sse.body) throw new Error(`SSE subscribe failed: ${sse.status}`);
  const reader = sse.body.getReader();
  try {
    const sent = await harness.gatewayJson<{ messageId: string }>(
      `/agent/sessions/${sessionId}/messages`,
      { method: "POST", body: JSON.stringify({ text }) },
    );
    await readUntilMessageEnd(reader, sessionId, sent.messageId);
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* best effort */
    }
  }
}

async function readUntilMessageEnd(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  sessionId: string,
  messageId: string,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf("\n\n");
    while (cut !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      cut = buffer.indexOf("\n\n");
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      let event: { type?: string; payload?: Record<string, unknown> };
      try {
        event = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      const payload = event.payload ?? {};
      if (payload.sessionId !== sessionId) continue;
      if (event.type === "agent.message.end" && payload.messageId === messageId) return;
      if (event.type === "agent.error") throw new Error(`agent error: ${JSON.stringify(payload)}`);
    }
  }
  throw new Error(`turn did not complete within ${TURN_TIMEOUT_MS}ms`);
}
