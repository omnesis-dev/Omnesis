// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";

import { type AgentEvent } from "@omnesis/core";
import {
  SCOPE_ADMIN,
  SCOPE_ANSWER,
  SCOPE_READ,
  type DeviceId,
  type Scope,
  type TokenId,
} from "@omnesis/types";
import {
  ReplayBackend,
  UNATTRIBUTED_CALLER,
  type DocumentPort,
  type SearchPort,
} from "@omnesis/agent";

import { AgentError, AgentService } from "../../agent/service.js";
import { FsConversationStore } from "../../agent/conversation-store.js";
import {
  StoredConversationReader,
  type ConversationReader,
} from "../../agent/conversation-reader.js";
import { AnswerService } from "../../privacy/answer-service.js";
import { createAnswerPrivacyTables, recordAnswerEgress } from "../../privacy/store.js";
import { directWriteGate } from "../../write-gate.js";
import { HttpError, errorResponse } from "../errors.js";
import { strictRoute } from "../scope.js";
import { createConversationReadStateTables } from "../../agent/conversation-read-state.js";
import {
  ConversationReadStateService,
  type ConversationReadStatePort,
} from "../../agent/conversation-read-state-service.js";
import {
  createCorpusAuthorization,
  type CorpusAuthorization,
} from "../../access/corpus-authorization.js";
import { tokenAnswerOwnerId } from "../../privacy/token-answer-owner.js";
import { mountAgentRoutes, withCallerResolver } from "./agent.js";
import type { Db } from "../../data/types.js";
import type { AppEnv } from "./types.js";
import type { DeviceAnswerScope } from "../../access/device-answer-scope.js";
import type { AccessGrantCapability } from "../../access/types.js";

const stubSearch: SearchPort = {
  async search(input) {
    return { query: input.query, durationMs: 1, results: [] };
  },
};
const stubDocument: DocumentPort = { fetch: async () => null };

function makeService(): AgentService {
  let n = 0;
  return new AgentService({
    backendFactory: () =>
      new ReplayBackend({
        fixtures: [
          {
            entries: [
              {
                afterMs: 0,
                event: {
                  type: "agent.message.end",
                  payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
                } satisfies AgentEvent,
              },
            ],
          },
        ],
      }),
    ports: { search: stubSearch, document: stubDocument },
    systemPrompt: "test",
    sessionIdGen: () => `S_${++n}`,
    idleTimeoutMs: 60_000,
  });
}

/**
 * A service whose replay backend emits a full multi-event turn (start →
 * two text deltas → end), so SSE-resume tests have a stream of distinctly
 * sequenced events to disconnect across. `maxBufferedEvents` is forwarded
 * so the gap/resync path can be exercised with a tiny buffer.
 */
function makeTurnService(
  maxBufferedEvents?: number,
  fixtureCount = 1,
  stepDelayMs = 0,
): AgentService {
  let n = 0;
  const turn: AgentEvent[] = [
    {
      type: "agent.message.start",
      payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
    },
    { type: "agent.text.delta", payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "a" } },
    { type: "agent.text.delta", payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "b" } },
    {
      type: "agent.message.end",
      payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
    },
  ];
  return new AgentService({
    backendFactory: () =>
      new ReplayBackend({
        fixtures: Array.from({ length: fixtureCount }, () => ({
          entries: turn.map((event) => ({ afterMs: stepDelayMs, event })),
        })),
      }),
    ports: { search: stubSearch, document: stubDocument },
    systemPrompt: "test",
    sessionIdGen: () => `S_${++n}`,
    idleTimeoutMs: 60_000,
    maxBufferedEvents,
  });
}

/** Drive a few microtasks so the replay backend's afterMs:0 turn settles. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
}

/**
 * Read an SSE response body until the decoded text contains `marker`
 * (or a short deadline elapses), then cancel. SSE connections stay open
 * via heartbeats, so reading to EOF would hang — this reads just enough.
 */
async function readUntil(res: Response, marker: string, maxMs = 2000): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    if (buf.includes(marker)) break;
  }
  await reader.cancel();
  return buf;
}

function buildApp(
  service: AgentService,
  extraDeps?: {
    heartbeatMs?: number;
    answerService?: AnswerService;
    harnessOf?: (deviceId: string) => string | null;
    conversationReadState?: ConversationReadStatePort;
    deviceAnswerScope?: (deviceId: string, tokenId: string) => DeviceAnswerScope;
  },
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError((err, c) => {
    if (err instanceof HttpError) return errorResponse(c, err);
    throw err;
  });
  // Auth-stub middleware: each request supplies its caller token id via the
  // `x-test-token` header so a single app instance can act as both caller A
  // and caller B in the same test (the production middleware reads the
  // bearer / cookie; here we keep it trivial).
  app.use("*", async (c, next) => {
    const tokenId = (c.req.header("x-test-token") ?? "tokenA") as TokenId;
    c.set("auth", {
      authMethod: "bearer",
      deviceId: "test-device" as DeviceId,
      tokenId,
      scopes: [SCOPE_ADMIN] as Scope[],
    });
    await next();
  });
  mountAgentRoutes(strictRoute(app), {
    agentService: service,
    answerService: makeAnswerService(service),
    deviceAnswerScope: () => ({ kind: "default" }),
    ...extraDeps,
  });
  return app;
}

function buildDisabledApp(
  reason: string,
  agentConfig?: {
    backend: "off" | "anthropic" | "replay";
    enabled: boolean;
    disabledReason?: string;
    disabledCode?: "remote_inference_disabled";
  },
  conversationReader?: ConversationReader,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError((err, c) => {
    if (err instanceof HttpError) return errorResponse(c, err);
    throw err;
  });
  app.use("*", async (c, next) => {
    const tokenId = (c.req.header("x-test-token") ?? "tokenA") as TokenId;
    c.set("auth", {
      authMethod: "bearer",
      deviceId: "test-device" as DeviceId,
      tokenId,
      scopes: [SCOPE_ADMIN] as Scope[],
    });
    await next();
  });
  mountAgentRoutes(strictRoute(app), {
    agentService: undefined,
    conversationReader,
    disabledReason: reason,
    disabledCode: agentConfig?.disabledCode,
    agentConfig,
  });
  return app;
}

function buildScopedApp(service: AgentService, scopes?: Scope[]): Hono<AppEnv> {
  const scopedApp = new Hono<AppEnv>();
  scopedApp.onError((err, c) => {
    if (err instanceof HttpError) return errorResponse(c, err);
    throw err;
  });
  if (scopes) {
    scopedApp.use("*", async (c, next) => {
      c.set("auth", {
        authMethod: "bearer",
        deviceId: "test-device" as DeviceId,
        tokenId: "tokenA" as TokenId,
        scopes,
      });
      await next();
    });
  }
  mountAgentRoutes(strictRoute(scopedApp), {
    agentService: service,
    answerService: makeAnswerService(service),
    deviceAnswerScope: () => ({ kind: "default" }),
  });
  return scopedApp;
}

function makeAnswerService(
  agentService: AgentService,
  reviewDecision: "allow" | "ask" = "allow",
  policyFamilies: Record<string, { policy: string; revision: string }> = {},
  reviewedPolicies: { policy: string; revision: string }[] = [],
  // The owner a device token holds at release. This database has no device or
  // token tables, so the egress check reads it here: by default the token of
  // a device on no access level.
  currentDeviceOwner: (deviceId: string, tokenId: string) => string | null = (_, tokenId) =>
    tokenAnswerOwnerId(tokenId),
): AnswerService {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE devices (id TEXT PRIMARY KEY)");
  createAnswerPrivacyTables(db);
  let id = 0;
  const writeGate = directWriteGate(db);
  return new AnswerService({
    db,
    writeGate: {
      ...writeGate,
      recordAnswerEgress: async (input) =>
        recordAnswerEgress(db, input, undefined, (_db, deviceId, tokenId) =>
          currentDeviceOwner(deviceId, tokenId),
        ),
    },
    agent: agentService,
    reviewer: {
      review: async (input) => {
        reviewedPolicies.push({ policy: input.policy, revision: input.policyRevision });
        return {
          decision: reviewDecision,
          reductions: [],
          hardStop: false,
          review: {
            recipeVersion: "privacy-reviewer-v1",
            provider: "test",
            model: "reviewer",
            confidence: 1,
            policyRevision: input.policyRevision,
            findings: [],
            rationale: "Allowed by the synthetic route-test policy.",
          },
          audit: {
            stage: input.reviewStage ?? "initial",
            envelope: {
              releaseKind: "answer",
              userPolicy: { revision: input.policyRevision, text: input.policy },
              workflowPurpose: input.workflowPurpose?.trim() || null,
              currentRequest: input.currentQuestion ?? "",
              priorExternalConversation: input.priorExternalConversation ?? [],
              cumulativeDisclosure: input.cumulativeDisclosure ?? {
                revision: 0,
                existenceRevision: 0,
                existenceSignals: 0,
                releasedTurns: 0,
                releasedCharacters: 0,
                olderTurnsOmitted: 0,
                categories: [],
              },
              reviewStage: input.reviewStage ?? "initial",
              candidateAnswer: input.candidateAnswer,
              watchDisclosure: null,
            },
            envelopeDigest: "route-test-envelope",
            rawModelOutput: "{}",
            parsedModelOutput: {},
            fallbackReason: null,
            hardStop: false,
          },
        };
      },
    },
    policyStore: {
      get: async () => ({ policy: "Allow synthetic answers.", revision: "policy-a", updatedAt: 1 }),
      getFamily: async (familyId: string) => {
        const family = policyFamilies[familyId];
        if (!family) return null;
        return {
          policy: family.policy,
          generation: 1,
          digest: `digest-${familyId}`,
          revision: family.revision,
          updatedAt: 1,
          schema: null,
        };
      },
      runIfRevision: async (_revision, operation) => operation(),
      runFamilyIfRevision: async (_familyId, _revision, operation) => operation(),
    },
    idGen: (kind) => `${kind}_${++id}`,
  });
}

let app: Hono<AppEnv>;
let service: AgentService;

beforeEach(() => {
  service = makeService();
  app = buildApp(service);
});

describe("POST /agent/sessions", () => {
  test("creates a session with no body", async () => {
    const res = await app.request("/agent/sessions", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe("S_1");
    expect(body.backend).toBe("replay");
  });

  test("accepts an empty JSON body", async () => {
    const res = await app.request("/agent/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  test("rejects unknown fields with 400 (strict zod)", async () => {
    const res = await app.request("/agent/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resumeFromId: "abc", extra: "x" }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects malformed JSON with 400", async () => {
    const res = await app.request("/agent/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
  });

  test("rejects a >64 KiB body with 413", async () => {
    // 65 KiB of plain ASCII — bodyLimit should reject before the route
    // handler ever sees the payload.
    const giantText = "x".repeat(65 * 1024);
    const res = await app.request("/agent/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resumeFromId: giantText }),
    });
    expect(res.status).toBe(413);
  });

  test("rejects an invalid transcript limit before creating a session", async () => {
    const createSession = vi.spyOn(service, "createSession");
    for (const limit of ["-1", "501", "1.5", "many"]) {
      const res = await app.request(`/agent/sessions?transcriptLimit=${limit}`, {
        method: "POST",
      });
      expect(res.status).toBe(400);
    }
    expect(createSession).not.toHaveBeenCalled();
  });

  test("an empty transcript is shape-only, not a cursor that never advances", async () => {
    // Zero is meaningful on session create and nowhere else. A page of
    // nothing hands back the cursor it was given, so on the paging
    // endpoint a client looping on `hasMore` would spin forever — that
    // endpoint keeps its minimum of one.
    const created = await service.createSession("token:tokenA");
    expect(
      (await app.request("/agent/sessions?transcriptLimit=0", { method: "POST" })).status,
    ).toBe(200);
    expect(
      (await app.request(`/agent/conversations/${created.sessionId}/messages?limit=0`)).status,
    ).toBe(400);
  });

  test("a zero-limit resume returns no messages but still reports the whole transcript", async () => {
    // How the voice ask resumes its continuity thread. It reads nothing
    // from the messages — only `messageCount`, which is how its answer
    // engine finds where this turn starts in the transcript — while the
    // thread itself can be hundreds of kilobytes of prior tool results.
    // So the count must survive a page that carries nothing: a
    // `messageCount` that shrank with the page would silently point a
    // follow-up's answer at the wrong turn.
    //
    // The cap is a property of the page, not of the prompt profile, so
    // the resume asks for no profile at all — naming the voice one would
    // put this behind the experimental gate and make the test depend on
    // an environment it does not otherwise care about.
    service = makeTurnService(undefined, 2);
    app = buildApp(service);
    const created = await service.createSession("token:tokenA");
    service.sendMessage("token:tokenA", created.sessionId, "first");
    await settle();
    service.sendMessage("token:tokenA", created.sessionId, "second");
    await settle();

    const res = await app.request("/agent/sessions?transcriptLimit=0", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resumeFromId: created.sessionId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: unknown[];
      messageCount: number;
      messagesAreVisible: boolean;
      messagePageInfo: { hasMore: boolean };
    };
    expect(body.messages).toEqual([]);
    expect(body.messageCount).toBe(4);
    expect(body.messagesAreVisible).toBe(true);
    // The whole transcript is still there to page back through.
    expect(body.messagePageInfo.hasMore).toBe(true);
  });

  // The visibility a session's tools apply depends on which audience opened it,
  // so the boundary has to say. Without this the thread exists and is never
  // populated, and every caller silently gets the narrowest treatment.
  test("tells the service which audience the session speaks for", async () => {
    const createSession = vi.spyOn(service, "createSession");

    // A device that declares no integration is the operator: the portal, the
    // phone, an admin token minted for their own use.
    const asOperator = buildApp(service, { harnessOf: () => null });
    expect(
      (
        await asOperator.request("/agent/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(200);
    expect(createSession).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ caller: { kind: "operator" } }),
    );

    // A device declaring itself an agent integration speaks only for itself.
    const asIntegration = buildApp(service, { harnessOf: () => "openclaw" });
    expect(
      (
        await asIntegration.request("/agent/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(200);
    expect(createSession).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ caller: { kind: "integration", slug: "openclaw" } }),
    );
  });

  // A wiring with no resolver cannot tell the two audiences apart. Answering
  // "operator" then is the exact bug that shipped once — every off-host
  // integration reading every watch on the install — so the routes fail closed
  // to the audience that sees nothing, and say so in the log.
  test("speaks for nobody, loudly, when the gateway supplied no resolver", async () => {
    const createSession = vi.spyOn(service, "createSession");
    const errors: string[] = [];
    const logError = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => void errors.push(args.join(" ")));

    try {
      const unwired = buildApp(service);
      expect(
        (
          await unwired.request("/agent/sessions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          })
        ).status,
      ).toBe(200);
    } finally {
      logError.mockRestore();
    }

    expect(createSession).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ caller: UNATTRIBUTED_CALLER }),
    );
    expect(errors.join("\n")).toContain("without a caller resolver");
  });

  test("forwards the client's time zone to the service", async () => {
    const createSession = vi.spyOn(service, "createSession");
    const res = await app.request("/agent/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeZone: "Asia/Tokyo" }),
    });
    expect(res.status).toBe(200);
    expect(createSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeZone: "Asia/Tokyo" }),
    );
  });

  // A zone this runtime cannot resolve is no reason to refuse a conversation:
  // the gateway drops it and falls back to its own, exactly as it does for a
  // client too old to send the field at all.
  test("drops an unresolvable zone rather than failing the request", async () => {
    const createSession = vi.spyOn(service, "createSession");
    const res = await app.request("/agent/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeZone: "Mars/Olympus_Mons" }),
    });
    expect(res.status).toBe(200);
    expect(createSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeZone: undefined }),
    );
  });

  test("rejects an absurdly long zone at the schema boundary", async () => {
    const res = await app.request("/agent/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeZone: "A/".repeat(200) }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /answer", () => {
  test("does not mount parallel native-integration Answer routes", async () => {
    const app = buildApp(makeTurnService());
    expect(
      (
        await app.request("/answer/integration", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: "Fictional question." }),
        })
      ).status,
    ).toBe(404);
    expect((await app.request("/answer/completions/task_fictional")).status).toBe(404);
  });

  test("serves a released answer without experimental mode", async () => {
    delete process.env.OMNESIS_EXPERIMENTAL;
    delete process.env.OMNESIS_SYNTHETIC;
    const answerApp = buildApp(makeTurnService(undefined, 2));
    const res = await answerApp.request("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "Fictional question." }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "released", answer: "ab" });
  });

  test("names the running turn when the same request arrives again", async () => {
    // A caller that gave up on its socket asks again with the same request id.
    // It has to be able to tell "still working, ask me again" apart from a
    // conflict waiting cannot fix — otherwise the only way to find out is to
    // start a second turn, and the answer the first one produces is stranded.
    const answerApp = buildApp(makeTurnService(undefined, 2, 30));
    const send = () =>
      answerApp.request("/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "slow", clientRequestId: "fictional-stable-id" }),
      });
    const inFlight = send();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const again = await send();

    expect(again.status).toBe(409);
    const conflict = (await again.json()) as { code: string; detail: { taskId: string } };
    expect(conflict.code).toBe("ANSWER_IN_PROGRESS");

    const settled = await inFlight;
    expect(settled.status).toBe(200);
    const released = (await settled.json()) as { taskId: string };
    // The same task — the repeat attached to the running turn, it did not open a second.
    expect(conflict.detail.taskId).toBe(released.taskId);
  });

  test("does not bind a durable answer task to the client request signal", async () => {
    const turnService = makeTurnService();
    const answerService = makeAnswerService(turnService);
    const originalGenerate = turnService.generateReadOnlyAnswerCandidate.bind(turnService);
    const generate = vi
      .spyOn(turnService, "generateReadOnlyAnswerCandidate")
      .mockImplementation(async (...args) => originalGenerate(...args));
    const answerApp = buildApp(turnService, { answerService });
    const controller = new AbortController();

    const response = await answerApp.request("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "a durable fictional question" }),
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[2]).toBeUndefined();
  });

  test("does not record egress when the durable task finishes after the client disconnects", async () => {
    const turnService = makeTurnService();
    const answerService = makeAnswerService(turnService);
    const answerApp = buildApp(turnService, { answerService });
    const controller = new AbortController();
    const originalAnswer = answerService.answer.bind(answerService);
    let taskId: string | undefined;
    vi.spyOn(answerService, "answer").mockImplementation(async (input) => {
      const result = await originalAnswer(input);
      taskId = result.taskId;
      controller.abort();
      return result;
    });
    const recordEgress = vi.spyOn(answerService, "recordEgress");

    await answerApp
      .request("/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "a durable fictional question" }),
        signal: controller.signal,
      })
      .catch(() => undefined);

    expect(taskId).toBeDefined();
    expect(recordEgress).not.toHaveBeenCalled();
    expect(await answerService.getResponse(taskId!, "token:tokenA")).not.toBeNull();

    const poll = await answerApp.request(`/answer/tasks/${taskId}`);
    expect(poll.status).toBe(200);
    expect(recordEgress).toHaveBeenCalledOnce();
  });

  test("returns an answer and continues it with the returned conversation id", async () => {
    const answerApp = buildApp(makeTurnService(undefined, 2));
    const first = await answerApp.request("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "first" }),
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const firstJson = await first.text();
    const firstBody = JSON.parse(firstJson) as {
      status: string;
      workflowId: string;
      conversationId: string;
      taskId: string;
      answer: string;
    };
    expect(firstJson).toBe(JSON.stringify(firstBody));
    expect(firstBody).toMatchObject({ status: "released", answer: "ab" });

    const polled = await answerApp.request(`/answer/tasks/${firstBody.taskId}`);
    expect(polled.status).toBe(200);
    expect(polled.headers.get("cache-control")).toBe("no-store");
    expect(await polled.text()).toBe(firstJson);

    const followUp = await answerApp.request("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "follow-up", conversationId: firstBody.conversationId }),
    });
    expect(followUp.status).toBe(200);
    expect(followUp.headers.get("cache-control")).toBe("no-store");
    expect(await followUp.json()).toMatchObject({
      status: "released",
      workflowId: firstBody.workflowId,
      conversationId: firstBody.conversationId,
      answer: "ab",
    });
  });

  test("returns 409 when a client request id is reused with different input", async () => {
    const answerApp = buildApp(makeTurnService(undefined, 2));
    const first = await answerApp.request("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "Summarize the fictional project.",
        clientRequestId: "request-reused",
      }),
    });
    expect(first.status).toBe(200);

    const conflict = await answerApp.request("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "Use the same key for a different question.",
        clientRequestId: "request-reused",
      }),
    });
    expect(conflict.status).toBe(409);
  });

  test("returns 409 for a follow-up while the conversation awaits approval", async () => {
    const turnService = makeTurnService(undefined, 2);
    const answerApp = buildApp(turnService, {
      answerService: makeAnswerService(turnService, "ask"),
    });
    const first = await answerApp.request("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "Share the fictional project status.",
        approval: "allow",
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { status: string; conversationId: string };
    expect(firstBody.status).toBe("approval_required");

    const conflict = await answerApp.request("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "Add another detail.",
        conversationId: firstBody.conversationId,
      }),
    });
    expect(conflict.status).toBe(409);
  });

  test("fails closed without response bytes when the egress ledger write fails", async () => {
    const turnService = makeTurnService(undefined, 2);
    const answerService = makeAnswerService(turnService);
    vi.spyOn(answerService, "recordEgress").mockRejectedValue(
      new HttpError(503, "EGRESS_LEDGER_UNAVAILABLE", "Synthetic ledger failure."),
    );
    const answerApp = buildApp(turnService, { answerService });

    const response = await answerApp.request("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "Invented question" }),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("ab");
  });

  test.each([
    {
      label: "validation",
      scopes: [SCOPE_ANSWER] as Scope[],
      body: { question: "   " },
      status: 400,
    },
    {
      label: "scope",
      scopes: [SCOPE_READ] as Scope[],
      body: { question: "question" },
      status: 403,
    },
  ])("sets no-store on early $label errors", async ({ scopes, body, status }) => {
    const answerApp = buildScopedApp(makeTurnService(), scopes);
    const response = await answerApp.request("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("accepts the dedicated answer scope and rejects plain read scope", async () => {
    const readOnlyApp = buildScopedApp(makeTurnService(), [SCOPE_READ] as Scope[]);
    const res = await readOnlyApp.request("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "question" }),
    });
    expect(res.status).toBe(403);

    const answerApp = buildScopedApp(makeTurnService(), [SCOPE_ANSWER] as Scope[]);
    const allowed = await answerApp.request("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "question" }),
    });
    expect(allowed.status).toBe(200);
  });

  test.each([
    { body: { question: "   " }, status: 400 },
    { body: { question: "question", extra: true }, status: 400 },
    { body: { question: "question", conversationId: "../unsafe" }, status: 400 },
  ])("rejects an invalid body with $status", async ({ body, status }) => {
    const res = await app.request("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(status);
  });

  test("rejects a body above 64 KiB", async () => {
    const res = await app.request("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "x".repeat(65 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  test("returns 404 for an unknown conversation", async () => {
    const res = await app.request("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "follow-up", conversationId: "S_missing" }),
    });
    expect(res.status).toBe(404);
  });

  test("does not treat an interactive agent session as an external conversation", async () => {
    const created = await service.createSession("token:tokenA");
    const res = await app.request("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "follow-up", conversationId: created.sessionId }),
    });
    expect(res.status).toBe(404);
  });

  test("accepts 10,000 characters and rejects 10,001", async () => {
    const tooLong = await app.request("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "x".repeat(10_001) }),
    });
    expect(tooLong.status).toBe(400);

    const boundaryApp = buildApp(makeTurnService());
    const boundary = await boundaryApp.request("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "x".repeat(10_000) }),
    });
    expect(boundary.status).toBe(200);
  });

  test("returns 502 instead of a successful empty answer", async () => {
    const res = await app.request("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "question" }),
    });
    expect(res.status).toBe(502);
  });

  test("returns 503 when the agent harness is disabled", async () => {
    const disabledApp = buildDisabledApp("No agent model is assigned.");
    const res = await disabledApp.request("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "question" }),
    });
    expect(res.status).toBe(503);
  });
});

describe("POST /answer on a device's access level", () => {
  const FAMILY_ID = "11111111-1111-4111-8111-111111111111";
  const FAMILY_OTHER = "22222222-2222-4222-8222-222222222222";
  const LEVEL_ID = "33333333-3333-4333-8333-333333333333";

  /** A level's Answer rule as the resolver builds it. */
  function levelScope(
    rule: Partial<AccessGrantCapability> = {},
    levelId = LEVEL_ID,
  ): DeviceAnswerScope {
    const authorization = createCorpusAuthorization(
      {
        principalId: "device:test-device",
        grantId: `level:${levelId}`,
        grantRevision: 1,
        credentialId: "device:test-device",
        accessTokenId: "tokenA",
      },
      [
        {
          capability: "answer",
          sourceMode: "all",
          sourceIds: [],
          releaseMode: "reviewed",
          policyFamilyId: FAMILY_ID,
          policyRevision: "family-rev-9",
          privacyPolicy: FAMILY_ID,
          ...rule,
        },
      ],
      "answer",
    )!;
    return { kind: "level", levelId, authorization };
  }

  function levelApp(deviceAnswerScope: () => DeviceAnswerScope, onGenerate: () => void = () => {}) {
    const turnService = makeTurnService();
    const reviewedPolicies: { policy: string; revision: string }[] = [];
    const answerService = makeAnswerService(
      turnService,
      "allow",
      {
        [FAMILY_ID]: { policy: "Allow fictional family answers.", revision: "family-rev-9" },
        [FAMILY_OTHER]: { policy: "Allow other fictional answers.", revision: "family-rev-3" },
      },
      reviewedPolicies,
      (_deviceId, tokenId) => {
        const scope = deviceAnswerScope();
        if (scope.kind === "unavailable") return null;
        return tokenAnswerOwnerId(
          tokenId,
          scope.kind === "level" ? scope.authorization : undefined,
        );
      },
    );
    // Capture the authorization each candidate is generated under, then
    // generate as an unrestricted caller: the restricted tool wiring is the
    // agent's own concern and is covered in its suite.
    const generatedUnder: (CorpusAuthorization | undefined)[] = [];
    const originalGenerate = turnService.generateReadOnlyAnswerCandidate.bind(turnService);
    vi.spyOn(turnService, "generateReadOnlyAnswerCandidate").mockImplementation(
      async (question, history, signal, onTrace, options) => {
        generatedUnder.push(options?.corpusAuthorization);
        onGenerate();
        return originalGenerate(question, history, signal, onTrace);
      },
    );
    const app = buildApp(turnService, { answerService, deviceAnswerScope });
    return Object.assign(app, { reviewedPolicies, generatedUnder });
  }

  const ask = (app: { request: typeof fetch }, clientRequestId?: string) =>
    app.request("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "fictional level question", clientRequestId }),
    });

  test("answers under the level's Answer rule: its sources and its policy", async () => {
    const scope = levelScope({ sourceMode: "allowlist", sourceIds: ["src-notes"] });
    const app = levelApp(() => scope);
    const res = await ask(app);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("released");
    expect(app.reviewedPolicies).toEqual([
      { policy: "Allow fictional family answers.", revision: "family-rev-9" },
    ]);
    expect(app.generatedUnder).toHaveLength(1);
    expect(app.generatedUnder[0]?.restricted).toBe(true);
    expect(app.generatedUnder[0]?.allowsSource("src-notes")).toBe(true);
    expect(app.generatedUnder[0]?.allowsSource("src-mail")).toBe(false);
  });

  test("a device on no level answers from every source under the default policy", async () => {
    const app = levelApp(() => ({ kind: "default" }));
    const res = await ask(app);
    expect(res.status).toBe(200);
    expect(app.reviewedPolicies).toEqual([
      { policy: "Allow synthetic answers.", revision: "policy-a" },
    ]);
    expect(app.generatedUnder).toEqual([undefined]);
  });

  test("refuses a device whose level can no longer answer, without naming the level", async () => {
    const app = levelApp(() => ({ kind: "unavailable", levelId: LEVEL_ID }));
    const res = await ask(app);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("ACCESS_LEVEL_UNAVAILABLE");
    expect(body.error).not.toContain(LEVEL_ID);
    expect(app.generatedUnder).toEqual([]);
  });

  test("refuses an integration on no access level, and says where to choose one", async () => {
    const app = levelApp(() => ({ kind: "unassigned" }));
    const res = await ask(app);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("ACCESS_LEVEL_REQUIRED");
    expect(body.error).toContain("Devices page");
    expect(app.generatedUnder).toEqual([]);
  });

  test("a gateway without the resolver refuses a device rather than answer it from every source", async () => {
    const turnService = makeTurnService();
    const app = buildApp(turnService, {
      answerService: makeAnswerService(turnService),
      deviceAnswerScope: undefined,
    });
    expect((await ask(app)).status).toBe(503);
  });

  test("an answer made while the device's level changed is not released", async () => {
    let scope = levelScope();
    const app = levelApp(
      () => scope,
      () => {
        // The operator narrows the level while the answer is being made.
        scope = levelScope({ sourceMode: "allowlist", sourceIds: ["src-notes"] });
      },
    );
    const res = await ask(app);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("ANSWER_ACCESS_CHANGED");
  });

  test("an answer made while an unbound device was put on a level is not released", async () => {
    let scope: DeviceAnswerScope = { kind: "default" };
    const app = levelApp(
      () => scope,
      () => {
        scope = levelScope({ sourceMode: "allowlist", sourceIds: ["src-notes"] });
      },
    );
    expect((await ask(app)).status).toBe(403);
  });

  test("a scope change starts a new owner namespace: no replay, no poll of the old answer", async () => {
    let scope = levelScope();
    const app = levelApp(() => scope);
    const first = await ask(app, "fictional-retry-1");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { status: string; taskId: string };
    expect(firstBody.status).toBe("released");

    // The operator narrows the level's sources.
    scope = levelScope({ sourceMode: "allowlist", sourceIds: ["src-notes"] });
    expect((await app.request(`/answer/tasks/${firstBody.taskId}`)).status).toBe(404);
    const second = await ask(app, "fictional-retry-1");
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { taskId: string };
    expect(secondBody.taskId).not.toBe(firstBody.taskId);
    expect(app.generatedUnder.map((auth) => auth?.restricted)).toEqual([false, true]);

    // Taking the device off its level reaches neither; restoring the first scope does.
    scope = { kind: "default" };
    expect((await app.request(`/answer/tasks/${firstBody.taskId}`)).status).toBe(404);
    scope = levelScope();
    expect((await app.request(`/answer/tasks/${firstBody.taskId}`)).status).toBe(200);
  });

  test("a policy change on the level is a new scope too", async () => {
    let scope = levelScope();
    const app = levelApp(() => scope);
    const first = (await (await ask(app, "fictional-retry-2")).json()) as { taskId: string };
    scope = levelScope({ policyFamilyId: FAMILY_OTHER, policyRevision: "family-rev-3" });
    expect((await app.request(`/answer/tasks/${first.taskId}`)).status).toBe(404);
    expect((await ask(app, "fictional-retry-2")).status).toBe(200);
    expect(app.reviewedPolicies.map((policy) => policy.revision)).toEqual([
      "family-rev-9",
      "family-rev-3",
    ]);
  });

  test("a portal session asks under the level of the device whose token opened it", async () => {
    const turnService = makeTurnService();
    const reviewedPolicies: { policy: string; revision: string }[] = [];
    const scope = levelScope();
    const answerService = makeAnswerService(
      turnService,
      "allow",
      { [FAMILY_ID]: { policy: "Allow fictional family answers.", revision: "family-rev-9" } },
      reviewedPolicies,
      (_deviceId, tokenId) =>
        tokenAnswerOwnerId(tokenId, scope.kind === "level" ? scope.authorization : undefined),
    );
    const resolved: string[] = [];
    const sessionApp = new Hono<AppEnv>();
    sessionApp.onError((err, c) => {
      if (err instanceof HttpError) return errorResponse(c, err);
      throw err;
    });
    sessionApp.use("*", async (c, next) => {
      c.set("auth", {
        authMethod: "portal-session",
        deviceId: null,
        credentialDeviceId: "voice-device" as DeviceId,
        tokenId: "tokenA" as TokenId,
        scopes: [SCOPE_ANSWER] as Scope[],
        csrfToken: "csrf",
      });
      await next();
    });
    mountAgentRoutes(strictRoute(sessionApp), {
      agentService: turnService,
      answerService,
      deviceAnswerScope: (deviceId) => {
        resolved.push(deviceId);
        return scope;
      },
    });
    const res = await ask(sessionApp);
    expect(res.status).toBe(200);
    expect(resolved).toContain("voice-device");
    expect(reviewedPolicies).toEqual([
      { policy: "Allow fictional family answers.", revision: "family-rev-9" },
    ]);
  });

  test("an unbound device keeps the plain token owner", async () => {
    const app = levelApp(() => ({ kind: "default" }));
    const { taskId } = (await (await ask(app)).json()) as { taskId: string };
    expect((await app.request(`/answer/tasks/${taskId}`)).status).toBe(200);
  });
});

describe("cross-caller conversation sharing", () => {
  test("caller B can resume a session originally created by caller A", async () => {
    // Conversations are shared across admin-scope callers; the resumer
    // takes over live ownership.
    const created = await service.createSession("token:tokenA");
    const res = await app.request("/agent/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-token": "tokenB" },
      body: JSON.stringify({ resumeFromId: created.sessionId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe(created.sessionId);
  });

  test("caller B can send on a session originally created by caller A", async () => {
    // The cross-device contract: conversations are shared across all
    // admin-scope callers AND every caller can drive any session.
    // Events fan out to every connected SSE listener (per service.ts
    // `broadcastToAllListeners`), with each client filtering by
    // sessionId — that's how iOS and portal stay live on the same
    // conversation simultaneously.
    const created = await service.createSession("token:tokenA");
    const res = await app.request(`/agent/sessions/${created.sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-token": "tokenB" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(200);
  });

  test("caller B can stop a session originally created by caller A", async () => {
    const created = await service.createSession("token:tokenA");
    const cancel = vi.spyOn(service, "cancelSession");

    const res = await app.request(`/agent/sessions/${created.sessionId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-token": "tokenB" },
      body: "{}",
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(cancel).toHaveBeenCalledWith("token:tokenB", created.sessionId);
  });

  test("an ordinary send during Deep Research uses the session-busy client envelope", async () => {
    const created = await service.createSession("token:tokenA");
    const active = (service as unknown as { deepResearchActive: Set<string> }).deepResearchActive;
    active.add(created.sessionId);
    try {
      const res = await app.request(`/agent/sessions/${created.sessionId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-token": "tokenB" },
        body: JSON.stringify({ text: "premature follow-up" }),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: "session is busy; cancel the in-flight turn first",
      });
    } finally {
      active.delete(created.sessionId);
    }
  });
});

describe("POST /agent/sessions/:id/messages — terminal context failure", () => {
  test("returns the stable 409 error envelope for a frozen conversation", async () => {
    const created = await service.createSession("token:tokenA");
    vi.spyOn(service, "sendMessage").mockImplementationOnce(() => {
      throw new AgentError(
        "context_window_exceeded",
        "This conversation no longer fits in the selected model's context window. Start a new conversation to continue.",
      );
    });

    const res = await app.request(`/agent/sessions/${created.sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "one more question" }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "CONTEXT_WINDOW_EXCEEDED",
      error:
        "This conversation no longer fits in the selected model's context window. Start a new conversation to continue.",
    });
  });
});

describe("GET /agent/conversations", () => {
  test("returns a keyset-paginated response", async () => {
    for (const text of ["first", "second", "third"]) {
      const created = await service.createSession("token:tokenA");
      service.sendMessage("token:tokenA", created.sessionId, text);
      await settle();
    }

    const first = await app.request("/agent/conversations?limit=2");
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.conversations).toHaveLength(2);
    expect(firstBody.nextCursor).toEqual(expect.any(String));

    const second = await app.request(
      `/agent/conversations?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.conversations).toHaveLength(1);
    expect(secondBody.nextCursor).toBeNull();
    expect(
      new Set([...firstBody.conversations, ...secondBody.conversations].map((c) => c.id)).size,
    ).toBe(3);
  });

  test("rejects malformed pagination inputs", async () => {
    expect((await app.request("/agent/conversations?limit=0")).status).toBe(400);
    expect((await app.request("/agent/conversations?cursor=not-a-cursor")).status).toBe(400);
  });

  test("reads persisted history while inference remains unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnesis-disabled-conversations-"));
    try {
      const store = new FsConversationStore(join(dir, "conversations"));
      await store.save({
        id: "stored-conversation",
        callerId: "token:tokenA",
        model: "fictional-model",
        backend: "http",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
        title: "Saved question",
        pinned: false,
        messages: [
          { role: "user", parts: [{ kind: "text", text: "Saved question" }] },
          { role: "assistant", parts: [{ kind: "text", text: "Saved answer" }] },
        ],
      });
      const disabledApp = buildDisabledApp(
        "Backend probe failed.",
        { backend: "replay", enabled: false, disabledReason: "Backend probe failed." },
        new StoredConversationReader(store),
      );

      const list = await disabledApp.request("/agent/conversations");
      expect(list.status).toBe(200);
      await expect(list.json()).resolves.toMatchObject({
        conversations: [{ id: "stored-conversation", messageCount: 2 }],
        nextCursor: null,
      });

      const detail = await disabledApp.request("/agent/conversations/stored-conversation");
      expect(detail.status).toBe(200);
      await expect(detail.json()).resolves.toMatchObject({
        id: "stored-conversation",
        messages: [{ role: "user" }, { role: "assistant" }],
      });

      const messages = await disabledApp.request(
        "/agent/conversations/stored-conversation/messages?limit=2",
      );
      expect(messages.status).toBe(200);
      await expect(messages.json()).resolves.toMatchObject({
        messageCount: 2,
        messagesAreVisible: true,
        messages: [{ role: "user" }, { role: "assistant" }],
      });

      const create = await disabledApp.request("/agent/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(create.status).toBe(503);
      await expect(create.json()).resolves.toMatchObject({ error: "Backend probe failed." });

      const send = await disabledApp.request("/agent/sessions/stored-conversation/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Continue" }),
      });
      expect(send.status).toBe(503);
      await expect(send.json()).resolves.toMatchObject({ error: "Backend probe failed." });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("GET /agent/conversations/:id/messages", () => {
  test("returns chronological complete-turn pages with a conversation-bound cursor", async () => {
    service = makeTurnService(undefined, 2);
    app = buildApp(service);
    const created = await service.createSession("token:tokenA");
    service.sendMessage("token:tokenA", created.sessionId, "first");
    await settle();
    service.sendMessage("token:tokenA", created.sessionId, "second");
    await settle();

    const first = await app.request(`/agent/conversations/${created.sessionId}/messages?limit=2`);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      messages: Array<{ role: string }>;
      messageCount: number;
      messagesAreVisible: boolean;
      messagePageInfo: { hasMore: boolean; nextCursor?: string };
    };
    expect(firstBody.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(firstBody).toMatchObject({
      messageCount: 4,
      messagesAreVisible: true,
      messagePageInfo: { hasMore: true },
    });

    const second = await app.request(
      `/agent/conversations/${created.sessionId}/messages?limit=2&cursor=${encodeURIComponent(firstBody.messagePageInfo.nextCursor!)}`,
    );
    const secondBody = (await second.json()) as {
      messages: Array<{ role: string }>;
      messagePageInfo: { hasMore: boolean };
    };
    expect(secondBody.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(secondBody.messagePageInfo.hasMore).toBe(false);

    const other = await service.createSession("token:tokenA");
    expect(
      (
        await app.request(
          `/agent/conversations/${other.sessionId}/messages?cursor=${encodeURIComponent(firstBody.messagePageInfo.nextCursor!)}`,
        )
      ).status,
    ).toBe(400);
  });
});

describe("PATCH /agent/conversations/:id", () => {
  async function seedTwo(): Promise<{ older: string; newer: string }> {
    const a = await service.createSession("token:tokenA");
    service.sendMessage("token:tokenA", a.sessionId, "older");
    await settle();
    const b = await service.createSession("token:tokenA");
    service.sendMessage("token:tokenA", b.sessionId, "newer");
    await settle();
    return { older: a.sessionId, newer: b.sessionId };
  }

  test("pins a conversation and floats it to the top of the list", async () => {
    const { older } = await seedTwo();
    const res = await app.request(`/agent/conversations/${older}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const list = await (await app.request("/agent/conversations")).json();
    expect(list.conversations[0].id).toBe(older);
    expect(list.conversations[0].pinned).toBe(true);
  });

  test("unpins a conversation", async () => {
    const { older } = await seedTwo();
    await app.request(`/agent/conversations/${older}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    const res = await app.request(`/agent/conversations/${older}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: false }),
    });
    expect(res.status).toBe(200);
    const list = await (await app.request("/agent/conversations")).json();
    expect(list.conversations.find((c: { id: string }) => c.id === older).pinned).toBe(false);
  });

  test("returns 404 for an unknown conversation", async () => {
    const res = await app.request("/agent/conversations/s_missing", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(res.status).toBe(404);
  });

  test("rejects a missing or non-boolean pinned with 400", async () => {
    const created = await service.createSession("token:tokenA");
    service.sendMessage("token:tokenA", created.sessionId, "hi");
    await settle();
    const missing = await app.request(`/agent/conversations/${created.sessionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    const wrongType = await app.request(`/agent/conversations/${created.sessionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: "yes" }),
    });
    expect(wrongType.status).toBe(400);
    const extra = await app.request(`/agent/conversations/${created.sessionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true, extra: 1 }),
    });
    expect(extra.status).toBe(400);
  });
});

describe("conversation read state over HTTP", () => {
  let readStateDb: Database.Database;
  let readState: ConversationReadStateService;
  let readStateApp: Hono<AppEnv>;

  beforeEach(() => {
    readStateDb = new Database(":memory:");
    createConversationReadStateTables(readStateDb);
    readState = new ConversationReadStateService({
      db: readStateDb,
      writer: directWriteGate(readStateDb as unknown as Db),
    });
    readStateApp = buildApp(service, { conversationReadState: readState });
  });

  afterEach(() => {
    readStateDb.close();
  });

  async function listedConversations(): Promise<Array<{ id: string; unread: boolean }>> {
    const res = await readStateApp.request("/agent/conversations");
    expect(res.status).toBe(200);
    const body = await res.json();
    return body.conversations;
  }

  test("tells the list which conversations hold something unseen", async () => {
    const created = await service.createSession("token:tokenA");
    service.sendMessage("token:tokenA", created.sessionId, "anything new?");
    await settle();
    await readState.agentContentArrived(created.sessionId);

    const rows = await listedConversations();
    expect(rows.find((row) => row.id === created.sessionId)?.unread).toBe(true);
  });

  test("reports every conversation as read when the gateway keeps no read state", async () => {
    const created = await service.createSession("token:tokenA");
    service.sendMessage("token:tokenA", created.sessionId, "anything new?");
    await settle();

    const res = await app.request("/agent/conversations");
    const body = await res.json();
    expect(
      body.conversations.find((row: { id: string }) => row.id === created.sessionId),
    ).toMatchObject({ unread: false });
  });

  test("marking a conversation seen clears it for every surface", async () => {
    const created = await service.createSession("token:tokenA");
    service.sendMessage("token:tokenA", created.sessionId, "anything new?");
    await settle();
    await readState.agentContentArrived(created.sessionId);

    const seen = await readStateApp.request(`/agent/conversations/${created.sessionId}/seen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(seen.status).toBe(200);
    await expect(seen.json()).resolves.toEqual({ ok: true });

    const rows = await listedConversations();
    expect(rows.find((row) => row.id === created.sessionId)?.unread).toBe(false);
  });

  test("marking an unknown conversation seen stores nothing", async () => {
    // Marking is a delete, so a stale client or a mistyped id cannot mint a
    // row that outlives it.
    const res = await readStateApp.request("/agent/conversations/conv-does-not-exist/seen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const count = readStateDb
      .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM conversation_read_state")
      .get();
    expect(count?.count).toBe(0);
  });

  test("a surface that has stopped rendering stops holding the conversation open", async () => {
    const created = await service.createSession("token:tokenA");
    await readStateApp.request(`/agent/conversations/${created.sessionId}/seen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ viewing: true }),
    });
    expect(readState.isViewing(created.sessionId)).toBe(true);

    await readStateApp.request(`/agent/conversations/${created.sessionId}/seen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ viewing: false }),
    });
    expect(readState.isViewing(created.sessionId)).toBe(false);
  });

  test("holds an accepted voice answer open before it can become unread", async () => {
    delete process.env.OMNESIS_EXPERIMENTAL;
    const created = await service.createSession("token:tokenA");
    const expectContentViewed = vi.spyOn(readState, "expectContentViewed");
    const res = await readStateApp.request(`/agent/sessions/${created.sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "What changed?", viewingForMs: 45_000 }),
    });
    expect(res.status).toBe(200);
    const sent = (await res.json()) as { messageId: string };
    expect(expectContentViewed).toHaveBeenCalledWith(created.sessionId, sent.messageId, 45_000);
  });

  test("does not hold a rejected voice send open", async () => {
    delete process.env.OMNESIS_EXPERIMENTAL;
    const res = await readStateApp.request("/agent/sessions/missing/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "What changed?", viewingForMs: 45_000 }),
    });
    expect(res.status).toBe(404);
    expect(readState.isViewing("missing")).toBe(false);
  });

  test("rejects an out-of-range voice viewing window", async () => {
    const res = await readStateApp.request("/agent/sessions/S_x/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "What changed?", viewingForMs: 999 }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects a bounded voice presentation for Deep Research", async () => {
    delete process.env.OMNESIS_EXPERIMENTAL;
    const res = await readStateApp.request("/agent/sessions/S_x/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Research this", deepResearch: true, viewingForMs: 45_000 }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects a seen body carrying anything else", async () => {
    const res = await readStateApp.request("/agent/conversations/S_x/seen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ viewing: true, pinned: true }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /agent/conversations/:id", () => {
  test("returns 409 while another conversation operation is in progress", async () => {
    vi.spyOn(service, "deleteConversation").mockRejectedValueOnce(
      new AgentError("session_busy", "conversation already has a deletion in progress"),
    );

    const res = await app.request("/agent/conversations/S_busy", { method: "DELETE" });

    expect(res.status).toBe(409);
  });
});

describe("POST /agent/sessions — voice profile", () => {
  const originalExp = process.env.OMNESIS_EXPERIMENTAL;
  afterEach(() => {
    if (originalExp === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
    else process.env.OMNESIS_EXPERIMENTAL = originalExp;
  });

  test("the response carries conversationId mirroring sessionId", async () => {
    const res = await app.request("/agent/sessions", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conversationId).toBe(body.sessionId);
  });

  test("rejects the reserved answer profile with 400", async () => {
    const res = await app.request("/agent/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "answer" }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects an unknown profile value with 400", async () => {
    const res = await app.request("/agent/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "spoken" }),
    });
    expect(res.status).toBe(400);
  });

  test("accepts profile=voice without experimental mode and hands it to the service", async () => {
    delete process.env.OMNESIS_EXPERIMENTAL;
    const createSpy = vi.spyOn(service, "createSession");
    const res = await app.request("/agent/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "voice" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conversationId).toBe(body.sessionId);
    expect(createSpy).toHaveBeenCalledWith(
      "token:tokenA",
      expect.objectContaining({ profile: "voice" }),
    );
  });

  test("accepts profile=interactive when experimental mode is off", async () => {
    delete process.env.OMNESIS_EXPERIMENTAL;
    const res = await app.request("/agent/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "interactive" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("POST /agent/sessions/:id/messages — notifyAfterMs", () => {
  const originalExp = process.env.OMNESIS_EXPERIMENTAL;
  afterEach(() => {
    if (originalExp === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
    else process.env.OMNESIS_EXPERIMENTAL = originalExp;
  });

  test("accepts notifyAfterMs without experimental mode and hands it to the service", async () => {
    delete process.env.OMNESIS_EXPERIMENTAL;
    const created = await service.createSession("token:tokenA");
    const sendSpy = vi.spyOn(service, "sendMessage");
    const res = await app.request(`/agent/sessions/${created.sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", notifyAfterMs: 5000 }),
    });
    expect(res.status).toBe(200);
    expect(sendSpy).toHaveBeenCalledWith(
      "token:tokenA",
      created.sessionId,
      "hi",
      expect.objectContaining({ notifyAfterMs: 5000 }),
    );
  });

  test("rejects notifyAfterMs combined with deepResearch with 400 (no watcher is armed for Deep Research)", async () => {
    delete process.env.OMNESIS_EXPERIMENTAL;
    const created = await service.createSession("token:tokenA");
    const sendSpy = vi.spyOn(service, "sendMessage");
    const res = await app.request(`/agent/sessions/${created.sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", deepResearch: true, notifyAfterMs: 5000 }),
    });
    expect(res.status).toBe(400);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  test.each([
    { label: "below the 1s floor", notifyAfterMs: 999 },
    { label: "above the 10min ceiling", notifyAfterMs: 600_001 },
    { label: "not an integer", notifyAfterMs: 1500.5 },
    { label: "not a number", notifyAfterMs: "2000" },
  ])("rejects a notifyAfterMs $label with 400", async ({ notifyAfterMs }) => {
    delete process.env.OMNESIS_EXPERIMENTAL;
    const created = await service.createSession("token:tokenA");
    const res = await app.request(`/agent/sessions/${created.sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", notifyAfterMs }),
    });
    expect(res.status).toBe(400);
  });
});

describe("Deep Research availability", () => {
  const originalExp = process.env.OMNESIS_EXPERIMENTAL;
  afterEach(() => {
    if (originalExp === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
    else process.env.OMNESIS_EXPERIMENTAL = originalExp;
  });

  test("allows deepResearch=true when experimental mode is off", async () => {
    delete process.env.OMNESIS_EXPERIMENTAL;
    const created = await service.createSession("token:tokenA");
    const res = await app.request(`/agent/sessions/${created.sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "research this", deepResearch: true }),
    });
    expect(res.status).toBe(200);
  });

  test("allows deepResearch=true when experimental mode is on", async () => {
    process.env.OMNESIS_EXPERIMENTAL = "1";
    const created = await service.createSession("token:tokenA");
    const res = await app.request(`/agent/sessions/${created.sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "research this", deepResearch: true }),
    });
    expect(res.status).toBe(200);
  });

  test("an ordinary turn (no deepResearch) remains available when experimental is off", async () => {
    delete process.env.OMNESIS_EXPERIMENTAL;
    const created = await service.createSession("token:tokenA");
    const res = await app.request(`/agent/sessions/${created.sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("GET /agent/events — dead-connection reclamation", () => {
  test("a half-dead SSE connection is reclaimed on the next failed enqueue, not leaked against the cap", async () => {
    // A client socket can die WITHOUT the request's abort signal firing (a
    // dropped TLS connection, a stalled write). The live stream then wedges:
    // the agent keeps running and persisting, but the portal shows nothing
    // until a manual refresh. The fix tears the listener down on the first
    // failed `enqueue`. Here we simulate the dead socket by cancelling the
    // response reader (which does NOT abort the request), then driving an
    // event so the broadcast's failed enqueue triggers teardown.
    //
    // The cap is 4 listeners per caller. We open 6 dead connections; if each
    // leaked, the cap would be exhausted and a fresh connection would fail.
    const created = await service.createSession("token:tokenA");

    for (let i = 0; i < 6; i++) {
      const res = await app.request("/agent/events");
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      await reader.read(); // initial heartbeat — listener is now registered
      await reader.cancel(); // socket dies; the abort signal does NOT fire
      // Drive an event: the broadcast's enqueue into the cancelled stream
      // throws, which must unsubscribe this listener.
      service.sendMessage("token:tokenA", created.sessionId, `m${i}`);
      for (let k = 0; k < 5; k++) await new Promise((r) => setImmediate(r));
    }

    // A fresh connection still streams — the 6 dead ones were reclaimed rather
    // than leaking against the cap of 4. (Without the fix, subscribe() throws
    // `listener_cap_exceeded` inside the stream's start() and this read rejects.)
    const ac = new AbortController();
    const final = await app.request("/agent/events", { signal: ac.signal });
    expect(final.status).toBe(200);
    const finalReader = final.body!.getReader();
    const { value } = await finalReader.read();
    expect(new TextDecoder().decode(value)).toContain("hb");
    ac.abort(); // clean teardown of the live connection's heartbeat timer
  });

  test("a heartbeat into a dead socket reclaims the listener (liveness probe, no event in flight)", async () => {
    // When no event is in flight, the periodic heartbeat is the ONLY thing
    // that touches the socket — so a failed heartbeat enqueue is what detects
    // a dead connection. Inject a short interval and drive reclamation purely
    // through the heartbeat (never sending a message), then prove a fresh
    // connection still streams.
    const hbApp = buildApp(makeService(), { heartbeatMs: 10 });

    for (let i = 0; i < 6; i++) {
      const res = await hbApp.request("/agent/events");
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      await reader.read(); // initial heartbeat — listener registered
      await reader.cancel(); // socket dies; abort signal does NOT fire
      // Wait past a heartbeat tick: the next heartbeat's failed enqueue must
      // tear the listener down. No broadcast is involved.
      await new Promise((r) => setTimeout(r, 40));
    }

    const ac = new AbortController();
    const final = await hbApp.request("/agent/events", { signal: ac.signal });
    expect(final.status).toBe(200);
    const finalReader = final.body!.getReader();
    const { value } = await finalReader.read();
    expect(new TextDecoder().decode(value)).toContain("hb");
    ac.abort();
  });
});

describe("GET /agent/events — SSE resume (Last-Event-ID)", () => {
  test("emits id: lines on live events so a client can record a resume point", async () => {
    const svc = makeTurnService();
    const evApp = buildApp(svc);
    const created = await svc.createSession("token:tokenA");
    const ac = new AbortController();
    const res = await evApp.request("/agent/events", { signal: ac.signal });
    expect(res.status).toBe(200);
    // Listener is registered; now drive the turn so events fan out live.
    svc.sendMessage("token:tokenA", created.sessionId, "hi");
    const text = await readUntil(res, "agent.message.end");
    // Every data frame is preceded by an `id: <n>` line.
    expect(text).toMatch(/id: \d+\ndata: /);
    expect(text).toContain("agent.message.start");
    expect(text).toContain("agent.message.end");
    ac.abort();
  });

  test("replays exactly the events past Last-Event-ID on reconnect", async () => {
    const svc = makeTurnService();
    const evApp = buildApp(svc);
    const created = await svc.createSession("token:tokenA");
    // Turn runs with no live listener → its events land in the buffer
    // (seq 1..4). This is the disconnected window.
    svc.sendMessage("token:tokenA", created.sessionId, "hi");
    await settle();
    // Reconnect claiming we already saw seq 2.
    const ac = new AbortController();
    const res = await evApp.request("/agent/events", {
      headers: { "Last-Event-ID": "2" },
      signal: ac.signal,
    });
    const text = await readUntil(res, "agent.message.end");
    expect(text).toContain("id: 3");
    expect(text).toContain("id: 4");
    // The already-seen events are NOT replayed.
    expect(text).not.toContain("id: 1\n");
    expect(text).not.toContain("id: 2\n");
    ac.abort();
  });

  test("a fresh connect (no Last-Event-ID) replays nothing", async () => {
    const svc = makeTurnService();
    const evApp = buildApp(svc);
    const created = await svc.createSession("token:tokenA");
    svc.sendMessage("token:tokenA", created.sessionId, "hi");
    await settle();
    const ac = new AbortController();
    const res = await evApp.request("/agent/events", { signal: ac.signal });
    // Only the initial heartbeat should arrive — the completed turn is not
    // replayed because the client didn't ask to resume.
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("hb");
    expect(first).not.toContain("agent.message");
    await reader.cancel();
    ac.abort();
  });

  test("sends agent.resync when the reconnect gap predates the buffer", async () => {
    // Buffer of 2 can't cover a client that missed event 1.
    const svc = makeTurnService(2);
    const evApp = buildApp(svc);
    const created = await svc.createSession("token:tokenA");
    svc.sendMessage("token:tokenA", created.sessionId, "hi");
    await settle();
    const ac = new AbortController();
    const res = await evApp.request("/agent/events", {
      headers: { "Last-Event-ID": "1" },
      signal: ac.signal,
    });
    const text = await readUntil(res, "agent.resync");
    expect(text).toContain("agent.resync");
    ac.abort();
  });
});

describe("GET /admin/agent/config", () => {
  test("returns agent config when service is enabled", async () => {
    const configApp = new Hono<AppEnv>();
    configApp.onError((err, c) => {
      if (err instanceof HttpError) return errorResponse(c, err);
      throw err;
    });
    configApp.use("*", async (c, next) => {
      const tokenId = (c.req.header("x-test-token") ?? "tokenA") as TokenId;
      c.set("auth", {
        authMethod: "bearer",
        deviceId: "test-device" as DeviceId,
        tokenId,
        scopes: [SCOPE_ADMIN] as Scope[],
      });
      await next();
    });
    mountAgentRoutes(strictRoute(configApp), {
      agentService: service,
      agentConfig: { backend: "anthropic", enabled: true },
    });

    const res = await configApp.request("/admin/agent/config");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.backend).toBe("anthropic");
    expect(body.enabled).toBe(true);
    expect(body.disabledReason).toBeNull();
    expect(body.disabledCode).toBeNull();
  });

  test("returns disabled reason when agent is off", async () => {
    const disabledApp = buildDisabledApp("Agent harness disabled.", {
      backend: "off",
      enabled: false,
      disabledReason: "Agent harness disabled.",
    });
    const res = await disabledApp.request("/admin/agent/config");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.backend).toBe("off");
    expect(body.enabled).toBe(false);
    expect(body.disabledReason).toBe("Agent harness disabled.");
    expect(body.disabledCode).toBeNull();
  });

  test("defaults to off when no agentConfig provided", async () => {
    const disabledApp = buildDisabledApp("disabled");
    const res = await disabledApp.request("/admin/agent/config");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.backend).toBe("off");
    expect(body.enabled).toBe(false);
  });
});

describe("wiring the caller resolver", () => {
  // The route reading `deps.harnessOf` was covered; the gateway HANDING it one
  // was not. The real gateway supplies its own `agentRouteDeps`, so a resolver
  // that lived only in the fallback branch reached every test and no live
  // install — and an unresolved caller reads as the operator, which would let
  // an off-host integration enumerate every watch on the install.
  const resolver = () => "openclaw";

  test("gives deps a resolver when the caller brought none", () => {
    const deps = withCallerResolver({}, resolver);
    expect(deps.harnessOf).toBe(resolver);
  });

  test("keeps a resolver the caller did bring", () => {
    const own = () => "hermes";
    expect(withCallerResolver({ harnessOf: own }, resolver).harnessOf).toBe(own);
  });

  test("carries the rest of the deps through untouched", () => {
    const deps = withCallerResolver({ disabledReason: "off" }, resolver);
    expect(deps.disabledReason).toBe("off");
  });
});

test("remote inference disabled is actionable in config and session creation", async () => {
  const app = buildDisabledApp("Cloud inference is disabled.", {
    backend: "anthropic",
    enabled: false,
    disabledReason: "Cloud inference is disabled.",
    disabledCode: "remote_inference_disabled",
  });
  const config = await app.request("/admin/agent/config");
  await expect(config.json()).resolves.toMatchObject({
    enabled: false,
    disabledCode: "remote_inference_disabled",
  });
  const create = await app.request("/agent/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(create.status).toBe(503);
  await expect(create.json()).resolves.toMatchObject({
    code: "remote_inference_disabled",
    error: "Cloud inference is disabled.",
  });
});
