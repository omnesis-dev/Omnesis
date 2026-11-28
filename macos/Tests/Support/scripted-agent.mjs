// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer } from "node:http";
import { linkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.OMNESIS_GUI_FIXTURE_ROOT;
if (!root) throw new Error("An owned fixture directory is required");
const clients = new Set();
let sends = 0,
  cancels = 0,
  creates = 0,
  documentReads = 0,
  historyRequests = 0,
  unauthorized = 0,
  sequence = 0;
const messages = [];
let partial = "";
let busy = false,
  lastTurnFailure = null;
const reference = {
  documentId: "fictional-document",
  sourceType: "example",
  sourceId: "example:notes",
  title: "Fictional project outline",
  snippet: "The outline separates confirmed decisions from questions for the planning session.",
  url: "https://example.com/fictional-evidence",
  unitName: "notes",
};
const emit = (type, payload) => {
  const id = ++sequence;
  for (const client of clients)
    client.write(`id: ${id}\ndata: ${JSON.stringify({ type, payload })}\n\n`);
};
function finish(reason) {
  if (!busy) return;
  busy = false;
  lastTurnFailure =
    reason === "canceled"
      ? {
          code: "canceled",
          message: "The response was stopped.",
          retryable: true,
          backend: "fixture",
          model: "fictional-scripted",
        }
      : null;
  if (reason === "end_turn") {
    messages.push({
      role: "user",
      parts: [
        {
          kind: "tool_result",
          toolCallId: "citation-one",
          result: { kind: "annotate.recorded", documentId: reference.documentId, ref: reference },
        },
      ],
    });
    emit("agent.citation", {
      sessionId: "fixture-session",
      messageId: `assistant-${sends}`,
      toolCallId: "citation-one",
      ref: reference,
    });
  }
  const persisted =
    reason === "end_turn"
      ? partial +
        " This is the saved answer.\n\n## What matters\n\n- The **fictional project** is ready for review.\n- Its next step is a short planning session.\n\n[Read the source](https://example.com/fictional-evidence)\n\n## A practical next step\n\nThe outline separates the decisions that are ready from the questions that still need a conversation. Start by reviewing the proposed schedule, then agree who will write the first draft. The notes do not record a final deadline, so it would be better to confirm one than assume it is fixed.\n\nThe [planning note](https://example.org/fictional-plan) also suggests keeping the initial review small. A short session can settle the remaining choices before the wider group sees the draft.\n\n```text\nExample reference: PROJECT-42\n```"
      : partial;
  messages.push({ role: "assistant", parts: [{ kind: "text", text: persisted }] });
  emit("agent.message.end", {
    sessionId: "fixture-session",
    messageId: `assistant-${sends}`,
    stopReason: reason,
  });
}
const server = createServer(async (request, response) => {
  if (request.headers.authorization !== "Bearer gui-fixture-token") {
    unauthorized++;
    response.writeHead(401);
    response.end();
    return;
  }
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16384) {
      response.writeHead(413);
      response.end();
      return;
    }
  }
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  const json = (value) => {
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(value));
  };
  if (path === "/fixture-status")
    return json({
      sends,
      cancels,
      creates,
      documentReads,
      historyRequests,
      unauthorized,
      streams: clients.size,
      messages,
    });
  if (path === "/documents/fictional-document") {
    documentReads++;
    return json({
      id: "fictional-document",
      provider_id: "example",
      source_id: "example:notes",
      external_id: "fictional-note",
      title: reference.title,
      content:
        "## Original project note\n\nThis is the full indexed document, read through the authenticated library connection. The planning session will confirm the schedule and the first draft owner.",
      content_hash: "fixture-content-hash",
      metadata: {},
      source_created_at: "2026-01-01T12:00:00Z",
    });
  }
  if (path === "/search" && request.method === "POST")
    return json({
      results: [
        {
          documentId: reference.documentId,
          sourceId: reference.sourceId,
          documentType: "note",
          title: reference.title,
          sourceCreatedAt: "2026-01-01T12:00:00Z",
          chunkText:
            "The outline separates confirmed decisions from open questions. This is only a preview; read the complete indexed document for the full context.",
          score: 1,
        },
      ],
    });
  if (path === "/agent/model")
    return json({
      providerId: "fixture",
      providerLabel: "Scripted provider",
      modelName: "Fictional model",
      available: true,
      configured: true,
    });
  if (path === "/agent/conversations") {
    historyRequests++;
    return json({
      conversations: messages.length
        ? [
            {
              id: "fixture-conversation",
              title: "Fictional conversation",
              model: "fictional-scripted",
              backend: "fixture",
              createdAt: "2026-01-01T12:00:00Z",
              updatedAt: "2026-01-01T12:00:00Z",
              messageCount: messages.length,
              pinned: false,
              unread: false,
            },
          ]
        : [],
      nextCursor: null,
    });
  }
  if (path === "/fixture-complete" && request.method === "POST") {
    const rest = " fixture has one item.";
    partial += rest;
    emit("agent.text.delta", {
      sessionId: "fixture-session",
      messageId: `assistant-${sends}`,
      delta: rest,
    });
    finish("end_turn");
    return json({ completed: true });
  }
  if (path === "/agent/events") {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    response.write(": ready\n\n");
    clients.add(response);
    response.on("close", () => clients.delete(response));
    return;
  }
  if (path === "/agent/sessions" && request.method === "POST") {
    const params = JSON.parse(body || "{}");
    if (params.resumeFromId != null && params.resumeFromId !== "fixture-conversation") {
      response.writeHead(400);
      response.end();
      return;
    }
    creates++;
    return json({
      sessionId: "fixture-session",
      conversationId: "fixture-conversation",
      model: "fictional-scripted",
      backend: "fixture",
      title: "Fictional conversation",
      busy,
      lastTurnFailure,
      eventCursor: sequence,
      messages:
        busy && partial
          ? [...messages, { role: "assistant", parts: [{ kind: "text", text: partial }] }]
          : messages,
    });
  }
  if (path === "/agent/sessions/fixture-session/messages" && request.method === "POST") {
    const { text } = JSON.parse(body);
    if (typeof text !== "string" || !text) {
      response.writeHead(400);
      response.end();
      return;
    }
    sends++;
    busy = true;
    partial = "";
    messages.push({ role: "user", parts: [{ kind: "text", text }] });
    json({ messageId: `assistant-${sends}`, userMessageId: `user-${sends}` });
    setTimeout(() => {
      emit("agent.user.message", {
        sessionId: "fixture-session",
        userMessageId: `user-${sends}`,
        text,
      });
      emit("agent.message.start", {
        sessionId: "fixture-session",
        messageId: `assistant-${sends}`,
      });
      partial = sends === 1 ? "The fictional" : "Another fictional";
      emit("agent.text.delta", {
        sessionId: "fixture-session",
        messageId: `assistant-${sends}`,
        delta: partial,
      });
    }, 20);
    return;
  }
  if (path === "/agent/sessions/fixture-session/cancel" && request.method === "POST") {
    cancels++;
    finish("canceled");
    return json({ ok: true });
  }
  response.writeHead(404);
  response.end();
});
server.listen(0, "127.0.0.1", () => {
  const pending = join(root, "endpoint.pending");
  writeFileSync(pending, JSON.stringify({ port: server.address().port }), {
    mode: 0o600,
    flag: "wx",
  });
  // Publish complete bytes atomically, without replacing an existing endpoint.
  linkSync(pending, join(root, "endpoint.json"));
  unlinkSync(pending);
});
process.on("SIGTERM", () => {
  for (const client of clients) client.end();
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
