// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Synthetic context-window acceptance coverage.
 *
 * A real Responses backend talks to an invented, loopback-only compatible
 * endpoint with a deliberately tiny configured window. The tests then drive
 * the real interactive persistence and cognition-queue settlement paths. No
 * live provider or corpus data is involved.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { OpenAIResponsesBackend, type DocumentPort, type SearchPort } from "@omnesis/agent";
import { createLogger, type AgentEvent } from "@omnesis/core";

import { createDatabase } from "../db.js";
import { directWriteGate } from "../write-gate.js";
import { createCognitionDrainerTasks } from "../brain/run-drainer.js";
import { CognitionRunDriver } from "../brain/run-driver.js";
import { getCognitionRun } from "../brain/storage/run-queue.js";
import { FsCognitionTranscriptStore } from "../brain/transcripts.js";
import { FsConversationStore } from "./conversation-store.js";
import { AgentService } from "./service.js";
import type { TaskContext } from "../scheduler/types.js";
import type { Scheduler } from "../scheduler/scheduler.js";

const SAFE_CONTEXT_MESSAGE =
  "This conversation no longer fits in the selected model's context window. Start a new conversation to continue.";
const MODEL = "fictional-tiny-responses-model";
const CONTEXT_WINDOW_TOKENS = 1_000;
const MAX_OUTPUT_TOKENS = 128;
const log = createLogger("test").child("context-window-e2e");

const stubDocument: DocumentPort = { fetch: async () => null };
const stubSearch: SearchPort = {
  async search(input) {
    return {
      query: input.query,
      durationMs: 1,
      results: [
        {
          documentId: "fictional-doc-1",
          sourceType: "fictional-notes",
          sourceId: "fictional-notes:self",
          title: "Riverside project outline",
          snippet: "An invented project note used only by the context-window acceptance test.",
        },
      ],
    };
  },
};

interface FakeResponsesEndpoint {
  baseUrl: string;
  countBodies: Array<Record<string, unknown>>;
  createBodies: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

const cleanupPaths: string[] = [];
const openEndpoints: FakeResponsesEndpoint[] = [];

describe("context-window V1 acceptance", () => {
  beforeEach(() => {
    cleanupPaths.length = 0;
    openEndpoints.length = 0;
  });

  afterEach(async () => {
    await Promise.all(openEndpoints.splice(0).map((endpoint) => endpoint.close()));
    for (const path of cleanupPaths.splice(0)) {
      if (path.endsWith(".db")) {
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          if (existsSync(path + suffix)) unlinkSync(path + suffix);
        }
      } else {
        rmSync(path, { recursive: true, force: true });
      }
    }
  });

  test("an ordinary request below the threshold is unchanged and reports its count", async () => {
    const endpoint = await startFakeResponsesEndpoint();
    openEndpoints.push(endpoint);
    const backend = makeBackend(endpoint.baseUrl);

    const events: AgentEvent[] = [];
    for await (const event of backend.runTurn({
      sessionId: "ordinary-session",
      messageId: "ordinary-message",
      history: [],
      userMessage: "ordinary request",
      tools: [],
      systemPrompt: "Answer briefly.",
    })) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "agent.text.delta",
      payload: {
        sessionId: "ordinary-session",
        messageId: "ordinary-message",
        delta: "Ordinary answer.",
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "agent.message.end",
      payload: {
        stopReason: "end_turn",
        context: {
          inputTokens: 100,
          peakInputTokens: 100,
          contextWindowTokens: CONTEXT_WINDOW_TOKENS,
          measurement: "provider_reported",
          limitSource: "configured",
          requestIteration: 1,
        },
      },
    });
    expect(endpoint.countBodies).toHaveLength(1);
    expect(endpoint.createBodies).toHaveLength(1);
    expect(endpoint.createBodies[0]).toMatchObject({
      truncation: "disabled",
      max_output_tokens: MAX_OUTPUT_TOKENS,
    });
  });

  test("first-request exhaustion freezes and survives reloading an interactive thread", async () => {
    const endpoint = await startFakeResponsesEndpoint();
    openEndpoints.push(endpoint);
    const dir = mkdtempSync(join(tmpdir(), "omnesis-context-e2e-"));
    cleanupPaths.push(dir);
    const store = new FsConversationStore(join(dir, "conversations"));
    let backendCreations = 0;
    let resolveTurn!: () => void;
    const turnComplete = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    const service = new AgentService({
      backendFactory: () => {
        backendCreations += 1;
        return makeBackend(endpoint.baseUrl);
      },
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "Answer briefly.",
      store,
      sessionIdGen: () => "first-overflow-session",
      idleTimeoutMs: 60_000,
      onTurnComplete: () => resolveTurn(),
    });

    const created = await service.createSession("device:fictional");
    service.sendMessage("device:fictional", created.sessionId, "first overflow");
    await turnComplete;

    const stored = await store.load(created.sessionId);
    expect(stored?.terminalFailure).toMatchObject({
      code: "context_window_exceeded",
      message: SAFE_CONTEXT_MESSAGE,
      retryable: false,
      context: {
        inputTokens: 900,
        measurement: "provider_count",
        requestIteration: 1,
      },
    });
    expect(stored?.messages).toEqual([
      { role: "user", parts: [{ kind: "text", text: "first overflow" }] },
    ]);
    expect(endpoint.countBodies).toHaveLength(1);
    expect(endpoint.createBodies).toHaveLength(0);
    await service.dispose();

    const cold = new AgentService({
      backendFactory: () => {
        backendCreations += 1;
        return makeBackend(endpoint.baseUrl);
      },
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "Answer briefly.",
      store,
      sessionIdGen: () => "unused",
      idleTimeoutMs: 60_000,
    });
    const resumed = await cold.createSession("device:fictional", {
      resumeFromId: created.sessionId,
    });
    expect(resumed.terminalFailure).toEqual(stored?.terminalFailure);
    expect(() =>
      cold.sendMessage("device:fictional", created.sessionId, "must not reach the provider"),
    ).toThrowError(expect.objectContaining({ code: "context_window_exceeded" }));
    expect(endpoint.countBodies).toHaveLength(1);
    expect(endpoint.createBodies).toHaveLength(0);
    expect(backendCreations).toBe(2);
    await cold.dispose();
  });

  test("a tool result can exhaust the next request while preserving partial output", async () => {
    const endpoint = await startFakeResponsesEndpoint();
    openEndpoints.push(endpoint);
    const dir = mkdtempSync(join(tmpdir(), "omnesis-context-tool-e2e-"));
    cleanupPaths.push(dir);
    const store = new FsConversationStore(join(dir, "conversations"));
    let resolveTurn!: () => void;
    const turnComplete = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    const service = new AgentService({
      backendFactory: () => makeBackend(endpoint.baseUrl),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "Use tools when needed.",
      store,
      sessionIdGen: () => "tool-overflow-session",
      idleTimeoutMs: 60_000,
      onTurnComplete: () => resolveTurn(),
    });

    const created = await service.createSession("device:fictional");
    service.sendMessage("device:fictional", created.sessionId, "tool growth request");
    await turnComplete;

    const stored = await store.load(created.sessionId);
    expect(stored?.terminalFailure).toMatchObject({
      code: "context_window_exceeded",
      context: {
        inputTokens: 900,
        peakInputTokens: 900,
        requestIteration: 2,
      },
    });
    expect(stored?.messages).toHaveLength(3);
    expect(stored?.messages[0]).toEqual({
      role: "user",
      parts: [{ kind: "text", text: "tool growth request" }],
    });
    expect(stored?.messages[1]).toMatchObject({
      role: "assistant",
      parts: [
        { kind: "text", text: "I will check the invented notes." },
        { kind: "tool_use", toolCallId: "call_1", tool: "search_documents" },
      ],
    });
    expect(stored?.messages[2]).toMatchObject({
      role: "user",
      parts: [{ kind: "tool_result", toolCallId: "call_1" }],
    });
    expect(endpoint.countBodies).toHaveLength(2);
    expect(endpoint.countBodies[1]).toMatchObject({ previous_response_id: "response_1" });
    expect(endpoint.createBodies).toHaveLength(1);
    await service.dispose();
  });

  test("a queued background payload makes one attempt and settles context failure", async () => {
    const endpoint = await startFakeResponsesEndpoint();
    openEndpoints.push(endpoint);
    const dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    cleanupPaths.push(dbPath);
    const db = createDatabase(dbPath);
    const dir = mkdtempSync(join(tmpdir(), "omnesis-context-queue-e2e-"));
    cleanupPaths.push(dir);
    const transcripts = new FsCognitionTranscriptStore(join(dir, "transcripts"));
    const writeGate = directWriteGate(db);
    const driver = new CognitionRunDriver({
      resolveBackend: () => makeBackend(endpoint.baseUrl),
      transcripts,
      log,
      clock: () => 100_000,
    });
    const scheduler = {} as unknown as Scheduler;
    const [drain] = createCognitionDrainerTasks(
      {
        db,
        writeGate,
        driver,
        transcripts,
        log,
        isEnabled: () => true,
        getBudgetVerdict: () => ({ exhausted: false as const }),
        getWorkerConcurrency: () => 1,
        getResurrectDebounceMs: () => 0,
        clock: () => 100_000,
        maxAttempts: 5,
      },
      scheduler,
    ).tasks;
    const taskContext: TaskContext = {
      shouldYield: () => false,
      elapsedMs: () => 0,
      signal: new AbortController().signal,
      log,
    };

    await writeGate.enqueueCognitionRun(
      {
        id: "context-queue-run",
        kind: "data",
        payload: { docId: "fictional-doc-1", event: "created", datumAt: 100_000 },
      },
      100_000,
    );
    await drain!.run(undefined, taskContext);

    expect(getCognitionRun(db, "context-queue-run")).toMatchObject({
      status: "failed",
      attempts: 1,
      failureCode: "context_window_exceeded",
    });
    expect(endpoint.countBodies).toHaveLength(1);
    expect(endpoint.createBodies).toHaveLength(0);
    await drain!.run(undefined, taskContext);
    expect(endpoint.countBodies).toHaveLength(1);
    db.close();
  });
});

function makeBackend(baseUrl: string): OpenAIResponsesBackend {
  return new OpenAIResponsesBackend({
    baseUrl,
    model: MODEL,
    allowRemoteInference: false,
    modelLimits: {
      contextWindowTokens: CONTEXT_WINDOW_TOKENS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  });
}

async function startFakeResponsesEndpoint(): Promise<FakeResponsesEndpoint> {
  const countBodies: Array<Record<string, unknown>> = [];
  const createBodies: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    void handleFakeRequest(request, response, countBodies, createBodies);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake endpoint has no TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    countBodies,
    createBodies,
    close: () => closeServer(server),
  };
}

async function handleFakeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  countBodies: Array<Record<string, unknown>>,
  createBodies: Array<Record<string, unknown>>,
): Promise<void> {
  const body = await readJsonBody(request);
  if (request.url === "/v1/responses/input_tokens") {
    countBodies.push(body);
    const serialized = JSON.stringify(body);
    const inputTokens =
      body.previous_response_id === "response_1" ||
      serialized.includes("first overflow") ||
      serialized.includes("Background Cognition Steward run")
        ? 900
        : 100;
    respondJson(response, 200, { input_tokens: inputTokens });
    return;
  }
  if (request.url !== "/v1/responses") {
    respondJson(response, 404, { error: { code: "not_found", message: "not found" } });
    return;
  }

  createBodies.push(body);
  const serialized = JSON.stringify(body);
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  if (serialized.includes("tool growth request")) {
    writeSse(response, {
      type: "response.output_text.delta",
      delta: "I will check the invented notes.",
    });
    writeSse(response, {
      type: "response.output_item.added",
      item: {
        id: "item_1",
        type: "function_call",
        call_id: "call_1",
        name: "search_documents",
        arguments: "",
      },
    });
    writeSse(response, {
      type: "response.output_item.done",
      item: {
        id: "item_1",
        type: "function_call",
        call_id: "call_1",
        name: "search_documents",
        arguments: JSON.stringify({ query: "Riverside project" }),
      },
    });
    writeSse(response, {
      type: "response.completed",
      response: {
        id: "response_1",
        status: "completed",
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    });
  } else {
    writeSse(response, { type: "response.output_text.delta", delta: "Ordinary answer." });
    writeSse(response, {
      type: "response.completed",
      response: {
        id: "ordinary_response",
        status: "completed",
        usage: { input_tokens: 100, output_tokens: 4 },
      },
    });
  }
  response.write("data: [DONE]\n\n");
  response.end();
}

function writeSse(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
