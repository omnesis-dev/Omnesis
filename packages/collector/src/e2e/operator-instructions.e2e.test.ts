// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * End-to-end coverage for `OMNESIS.md` — the operator's standing instructions.
 *
 * The unit tests prove each prompt builder renders the section. What only an
 * end-to-end run can prove is that the whole path holds on a real gateway: the
 * file the portal writes over HTTP is the file the store reads off disk, the
 * store the routes write through is the store the agent's prompt builder reads
 * from, and the words actually arrive in the system message a model receives.
 *
 * The model is substituted at the production `agent`-role seam with a scripted
 * OpenAI-compatible server that records every system message and answers with
 * plain text. No inference happens; the assertions are on what the gateway
 * sent, which is the thing under test.
 *
 * Three transitions, in order, because each depends on the last: absent (no
 * section at all), written (the words arrive), deleted (they stop arriving).
 * The middle one is only meaningful against the first, and a feature whose
 * off-switch is untested is a feature you cannot turn off.
 */

import "./synth-env.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { SyntheticE2EHarness } from "./synth-harness.js";
import {
  startOpenAiServer,
  type OpenAiServerHandle,
  type WireMessage,
} from "./brain-bench/openai-server.js";

const MODEL_ID = "operator-instructions-scripted-v1";
const TURN_TIMEOUT_MS = 60_000;

/**
 * Deliberately unlike anything in the prompt or the synthetic corpus, so its
 * presence can only mean the file reached the model.
 */
const MARKER = "ZZOPERATORRULE-9f31: always quote distances in kilometres";
const INSTRUCTIONS = `# House rules\n\n- ${MARKER}\n`;

interface SessionResp {
  sessionId: string;
}
interface MessageResp {
  messageId: string;
}

describe("OMNESIS.md reaches the agent end to end", () => {
  let harness: SyntheticE2EHarness;
  let model: OpenAiServerHandle;
  /** Every system message the gateway sent, in order. */
  let systemPrompts: string[];

  beforeAll(async () => {
    systemPrompts = [];
    model = await startOpenAiServer({
      modelId: MODEL_ID,
      respond: (messages: readonly WireMessage[]) => {
        const system = messages.find((m) => m.role === "system")?.content;
        if (typeof system === "string") systemPrompts.push(system);
        return { kind: "text", text: "Noted." };
      },
    });

    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      // The smallest universe there is: the assertion is on the prompt the
      // gateway builds, not on anything in the corpus.
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

  test("absent by default, then written, then deleted", async () => {
    const path = join(harness.getConfigDir(), "OMNESIS.md");

    // ── 1. A gateway nobody has written the file on ──────────────────────
    const before = await harness.gatewayJson<{ exists: boolean; path: string; maxBytes: number }>(
      "/admin/instructions",
    );
    expect(before.exists).toBe(false);
    expect(before.path).toBe(path);
    expect(before.maxBytes).toBeGreaterThan(0);

    await runTurn(harness, "hello");
    expect(systemPrompts).not.toHaveLength(0);
    expect(latest(systemPrompts)).not.toContain("# The operator's standing instructions");

    // ── 2. Written through the portal's own route ────────────────────────
    const saved = await harness.gatewayJson<{ exists: boolean; updatedAt: number }>(
      "/admin/instructions",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: INSTRUCTIONS }),
      },
    );
    expect(saved.exists).toBe(true);
    // The route is a shell over a plain file: what the portal saved is what an
    // operator opening their editor sees, byte for byte.
    expect(readFileSync(path, "utf8")).toBe(INSTRUCTIONS);

    await runTurn(harness, "hello again");
    const withFile = latest(systemPrompts);
    expect(withFile).toContain("# The operator's standing instructions");
    expect(withFile).toContain(MARKER);
    // Headings and bullets survive the trip — this is prose the operator
    // wrote, not a claim collapsed onto one line.
    expect(withFile).toContain("# House rules");

    // ── 3. Deleted — the agent goes back to its defaults ─────────────────
    const removed = await harness.gatewayJson<{ removed: boolean; exists: boolean }>(
      "/admin/instructions",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedUpdatedAt: saved.updatedAt }),
      },
    );
    expect(removed.removed).toBe(true);
    expect(removed.exists).toBe(false);

    await runTurn(harness, "and once more");
    expect(latest(systemPrompts)).not.toContain(MARKER);
  }, 180_000);
});

function latest(prompts: readonly string[]): string {
  const last = prompts.at(-1);
  if (last === undefined) throw new Error("the scripted model was never called");
  return last;
}

/**
 * Drive one interactive turn to completion. A fresh session each time: the
 * system prompt is resolved when a conversation is created and frozen for its
 * lifetime, so reusing a session would read the file from before the edit —
 * which is the real behaviour, and exactly why each step opens its own.
 */
async function runTurn(harness: SyntheticE2EHarness, text: string): Promise<void> {
  const sse = await fetch(`${harness.gatewayUrl}/agent/events`, {
    headers: { Authorization: `Bearer ${harness.apiKey}`, Accept: "text/event-stream" },
  });
  if (!sse.ok || !sse.body) {
    throw new Error(`SSE subscribe failed: ${sse.status} ${await sse.text()}`);
  }
  const reader = sse.body.getReader();
  try {
    const sessionRes = await fetch(`${harness.gatewayUrl}/agent/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${harness.apiKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (!sessionRes.ok) {
      throw new Error(`session create failed: ${sessionRes.status} ${await sessionRes.text()}`);
    }
    const session = (await sessionRes.json()) as SessionResp;

    const msgRes = await fetch(
      `${harness.gatewayUrl}/agent/sessions/${session.sessionId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${harness.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
      },
    );
    if (!msgRes.ok) {
      throw new Error(`message send failed: ${msgRes.status} ${await msgRes.text()}`);
    }
    const sent = (await msgRes.json()) as MessageResp;
    await readUntilMessageEnd(reader, session.sessionId, sent.messageId);
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
      if (event.type === "agent.error") {
        throw new Error(`agent error: ${JSON.stringify(payload)}`);
      }
    }
  }
  throw new Error(`turn did not complete within ${TURN_TIMEOUT_MS}ms`);
}
