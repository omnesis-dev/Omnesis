// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Drive one agent turn against a spawned gateway and collect its streamed events. */

import type { SyntheticE2EHarness } from "./synth-harness.js";

export interface AgentEvent {
  type: string;
  payload: Record<string, unknown>;
}

interface SearchResponse {
  results?: unknown[];
}

const TURN_TIMEOUT_MS = 20_000;

export async function waitForAgentSearchReady(
  harness: SyntheticE2EHarness,
  query: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: SearchResponse | undefined;
  while (Date.now() < deadline) {
    await harness.refreshSearchSnapshot();
    last = await gatewayJson<SearchResponse>(harness, "/search", {
      method: "POST",
      body: JSON.stringify({ text: query, limit: 3 }),
    });
    if ((last.results ?? []).length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`search did not become ready for ${query}: ${JSON.stringify(last)}`);
}

export async function runAgentTurn(
  harness: SyntheticE2EHarness,
  text: string,
): Promise<{
  session: { sessionId: string; backend: string; model: string };
  events: AgentEvent[];
}> {
  const sse = await fetch(`${harness.gatewayUrl}/agent/events`, {
    headers: { Authorization: `Bearer ${harness.apiKey}`, Accept: "text/event-stream" },
  });
  if (!sse.ok || !sse.body) {
    throw new Error(`SSE subscribe failed: ${sse.status} ${await sse.text()}`);
  }
  const reader = sse.body.getReader();

  try {
    const session = await gatewayJson<{ sessionId: string; backend: string; model: string }>(
      harness,
      "/agent/sessions",
      {
        method: "POST",
        body: "{}",
      },
    );

    const sent = await gatewayJson<{ messageId: string }>(
      harness,
      `/agent/sessions/${session.sessionId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ text }),
      },
    );

    const events = await readEventsUntilMessageEnd(reader, session.sessionId, sent.messageId);
    return { session, events };
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* best effort */
    }
  }
}

export async function gatewayJson<T>(
  harness: SyntheticE2EHarness,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${harness.apiKey}`);
  headers.set("Content-Type", "application/json");
  const res = await fetch(`${harness.gatewayUrl}${path}`, { ...init, headers });
  if (!res.ok) {
    throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function readEventsUntilMessageEnd(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  sessionId: string,
  messageId: string,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + TURN_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const next = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value?: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true as const }), remaining),
      ),
    ]);
    if (next.done || !next.value) break;
    buffer += decoder.decode(next.value, { stream: true });

    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      const json = dataLine.slice("data:".length).trim();
      if (!json) continue;
      let parsed: AgentEvent;
      try {
        parsed = JSON.parse(json) as AgentEvent;
      } catch {
        continue;
      }
      if (parsed.payload.sessionId !== sessionId) continue;
      events.push(parsed);
      if (parsed.type === "agent.message.end" && parsed.payload.messageId === messageId) {
        return events;
      }
    }
  }

  throw new Error(`Did not see agent.message.end for ${sessionId}/${messageId}`);
}
