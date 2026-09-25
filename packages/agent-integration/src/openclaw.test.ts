// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isToolResultError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, test, vi } from "vitest";

import { AgentIntegrationClient } from "./client.js";
import {
  firingAnswerConversationHandle,
  firingAnswerRequestId,
  integrationAnswerRequestId,
} from "./answer-wait.js";
import {
  GatewayRequestTimeoutError,
  IntegrationHttpError,
  PinnedGatewayHttpClient,
} from "./http.js";
import { DurableIntegrationInbox } from "./inbox.js";
import {
  isSessionRoute,
  OpenClawCompletionRoutes,
  SESSION_ROUTE_CHANNEL,
} from "./openclaw-completion-routes.js";
import { DurableTranscriptIngestor } from "./ingestion.js";
import { NativeAnswerMcpClient } from "./native-answer-mcp.js";
import { type IntegrationOAuthProvider, SerializedIntegrationAuthProvider } from "./oauth.js";
import {
  identityFromSession,
  isConversationSession,
  OPENCLAW_PLUGIN_DEFINITION,
  openClawRunIdentity,
  openClawAnswerBudget,
  OpenClawTranscriptSource,
  registerOpenClawIntegration,
  answerCompletionContinuation,
  backgroundPrompt,
  sendAnswerCompletion,
} from "./openclaw.js";
import {
  AGENT_INTEGRATION_PROTOCOL_MIN_VERSION,
  AGENT_INTEGRATION_PROTOCOL_VERSION,
  type SubscriptionDelivery,
} from "./protocol.js";

const tempDirs: string[] = [];
/** Closed before their directories go, so no SQLite handle outlives the test. */
const openedRouteStores: OpenClawCompletionRoutes[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const store of openedRouteStores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function api(mode: string) {
  const services: Array<Record<string, unknown>> = [];
  const hooks: Array<{ events: string[]; options: Record<string, unknown> }> = [];
  const tools: Array<{
    factory: (context: { sessionKey?: string }) => Record<string, unknown> | null;
    options: Record<string, unknown>;
  }> = [];
  return {
    registrationMode: mode,
    pluginConfig: {},
    logger: { warn: vi.fn() },
    registerHook: vi.fn(
      (events: string | string[], _handler: () => void, options: Record<string, unknown>) =>
        hooks.push({
          events: Array.isArray(events) ? events : [events],
          options,
        }),
    ),
    registerService: vi.fn((service: Record<string, unknown>) => services.push(service)),
    registerTool: vi.fn(
      (
        factory: (context: { sessionKey?: string }) => Record<string, unknown> | null,
        options: Record<string, unknown>,
      ) => tools.push({ factory, options }),
    ),
    runtime: {
      agent: { session: { listSessionEntries: () => [] } },
      subagent: {
        run: vi.fn(async () => ({ runId: "run-fictional-1" })),
        waitForRun: vi.fn(async () => ({ status: "ok" as const })),
        getSessionMessages: vi.fn(async () => ({ messages: [] as unknown[] })),
      },
      channel: { outbound: { loadAdapter: vi.fn() } },
    },
    services,
    hooks,
    tools,
  };
}

function transcriptEvent(
  index: number,
  overrides: {
    id?: string;
    role?: string;
    content?: unknown;
    timestamp?: number | string;
  } = {},
) {
  return {
    type: "message",
    id: overrides.id ?? `fictional-record-${index}`,
    timestamp: overrides.timestamp ?? 1_800_000_000_000 + index,
    message: {
      role: overrides.role ?? (index % 2 === 0 ? "user" : "assistant"),
      content: overrides.content ?? `Fictional transcript message ${index}`,
    },
  };
}

describe("who owns an answer's identity", () => {
  test("the model is offered a timeout grant, never an identifier", () => {
    const fake = api("tool-discovery");
    registerOpenClawIntegration(fake as never);
    const tool = fake.tools
      .find(({ options }) => options.name === "omnesis_answer")!
      .factory({ sessionKey: "agent:main:cron:job:run:one" }) as {
      parameters: { properties: Record<string, unknown>; required: string[] };
    };
    // A workflow or conversation id means nothing outside Omnesis, so offering
    // one invites the model to supply a harness identifier that names nothing
    // and is rejected as not-found on every attempt alike. A timeout is a
    // different thing: the host consumes it, and a wrong value only shortens
    // the wait.
    expect(Object.keys(tool.parameters.properties).sort()).toEqual([
      "question",
      "timeoutMs",
      "timeoutSeconds",
    ]);
    expect(tool.parameters.required).toEqual(["question"]);
  });
});

describe("answer completion transport during a rolling upgrade", () => {
  async function setupCompletion() {
    const stateDir = mkdtempSync(join(tmpdir(), "omnesis-openclaw-completion-transport-"));
    tempDirs.push(stateDir);
    mkdirSync(join(stateDir, "omnesis"));
    writeFileSync(
      join(stateDir, "omnesis", "integration.json"),
      `${JSON.stringify({
        gatewayUrl: "http://127.0.0.1:1",
        deliveryToken: "omn_fictional_delivery",
        ingestionToken: "omn_fictional_ingestion",
        managementToken: "omn_fictional_management",
        oauth: {
          redirectUri: "http://127.0.0.1:48123/callback",
          clientInformation: { client_id: "client_fictional" },
          tokens: {
            access_token: "omn_fictional_agent",
            refresh_token: "refresh_fictional",
            token_type: "Bearer",
          },
        },
      })}\n`,
    );
    let completionStarter: ((delivery: AnswerCompletionDelivery) => Promise<void>) | undefined;
    vi.spyOn(AgentIntegrationClient.prototype, "start").mockImplementation(function () {
      completionStarter = (
        this as unknown as {
          opts: { completionStarter?: (delivery: AnswerCompletionDelivery) => Promise<void> };
        }
      ).opts.completionStarter;
    });
    vi.spyOn(DurableTranscriptIngestor.prototype, "start").mockImplementation(() => {});
    vi.spyOn(AgentIntegrationClient.prototype, "stop").mockResolvedValue();
    vi.spyOn(DurableTranscriptIngestor.prototype, "stop").mockResolvedValue();
    const fake = api("full");
    registerOpenClawIntegration(fake as never);
    const service = fake.services[0] as {
      start(context: { stateDir: string; logger: { warn(message: string): void } }): Promise<void>;
      stop(): Promise<void>;
    };
    await service.start({ stateDir, logger: { warn: vi.fn() } });
    const routes = new OpenClawCompletionRoutes(
      join(stateDir, "omnesis", "answer-completion-routes.sqlite"),
    );
    routes.put({
      nativeConversationId: "native_completion",
      taskId: "task_completion",
      channel: SESSION_ROUTE_CHANNEL,
      to: "agent:main:fictional-completion",
    });
    routes.close();
    const delivery: AnswerCompletionDelivery = {
      protocolVersion: 3,
      deliveryId: "acdl_completion",
      taskId: "task_completion",
      nativeConversationId: "native_completion",
      answer: {
        token: "omn_fictional_completion",
        expiresAt: 1_900_000_000_000,
        endpoint: "/mcp",
      },
    };
    return { fake, service, delivery, run: () => completionStarter!(delivery) };
  }

  test("retrieves a completion through the installation OAuth principal", async () => {
    const tokens: string[] = [];
    const registeredNames: string[] = [];
    type AuthProviderInternals = {
      provider: IntegrationOAuthProvider;
      token(): Promise<string | undefined>;
    };
    // The keepalive builds its own provider per tick; its first tick fires at
    // start, so the name it would register under is observable here too.
    vi.spyOn(SerializedIntegrationAuthProvider.prototype, "renew").mockImplementation(
      async function () {
        registeredNames.push(
          (this as unknown as AuthProviderInternals).provider.clientMetadata.client_name!,
        );
      },
    );
    vi.spyOn(NativeAnswerMcpClient.prototype, "getTask").mockImplementation(async function () {
      const authProvider = (this as unknown as { authProvider: AuthProviderInternals })
        .authProvider;
      registeredNames.push(authProvider.provider.clientMetadata.client_name!);
      tokens.push((await authProvider.token())!);
      return Promise.resolve({
        workflowId: "wf_fictional",
        conversationId: "conv_fictional",
        taskId: "task_completion",
        status: "released",
        releaseId: "release_fictional",
        answer: "Fictional approved answer.",
      });
    });
    const { fake, service, run } = await setupCompletion();
    await run();
    expect(tokens).toEqual(["omn_fictional_agent"]);
    expect(registeredNames).toEqual(["OpenClaw", "OpenClaw"]);
    expect(fake.runtime.subagent.run).toHaveBeenCalledTimes(1);
    await service.stop();
  });
});

describe("the window one tool call may use", () => {
  const HOST_DEFAULT_MS = 90_000;

  test("stays inside the host's default when nothing was granted", () => {
    const budget = openClawAnswerBudget({});
    expect(budget.deadlineMs).toBe(HOST_DEFAULT_MS - 15_000);
  });

  test("uses a granted window, capped by the module's own ceiling", () => {
    expect(openClawAnswerBudget({ timeoutMs: 600_000 }).deadlineMs).toBe(420_000);
    expect(openClawAnswerBudget({ timeoutSeconds: 600 }).deadlineMs).toBe(420_000);
  });

  test("never waits past a grant, however small", () => {
    // A fixed margin cannot be subtracted from a grant smaller than itself.
    // Waiting past the grant is what gets the call killed mid-answer, which is
    // the failure this whole mechanism exists to avoid.
    for (const granted of [1_000, 20_000, 30_000, 44_000, 45_000, 90_000, 600_000]) {
      const budget = openClawAnswerBudget({ timeoutMs: granted });
      expect(budget.deadlineMs!).toBeLessThan(granted);
      expect(budget.submitTimeoutMs!).toBeLessThanOrEqual(budget.deadlineMs!);
    }
  });

  test("treats a nonsense grant as no grant", () => {
    const fallback = openClawAnswerBudget({}).deadlineMs;
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "600000", null, {}]) {
      expect(openClawAnswerBudget({ timeoutMs: bad }).deadlineMs).toBe(fallback);
    }
  });

  test("keeps the submit-then-poll ladder rather than one long request", () => {
    // One request held open for the whole window never reaches a poll, so a
    // mid-window blip would settle the ask instead of being retried.
    const budget = openClawAnswerBudget({ timeoutMs: 600_000 });
    expect(budget.submitTimeoutMs).toBeLessThan(budget.deadlineMs!);
  });
});

describe("openClawRunIdentity", () => {
  test("reads a scheduled run out of the trusted session key", () => {
    const identity = openClawRunIdentity({
      sessionKey: "agent:main:cron:fictional-job:run:fictional-run",
    });
    expect(identity.scheduled).toBe(true);
    // The whole key is the generation: it carries the job as well as the run,
    // so two jobs that share a run id stay distinct asks.
    expect(identity.generation).toBe("agent:main:cron:fictional-job:run:fictional-run");
  });

  test("gives every firing of one job its own generation", () => {
    const monday = openClawRunIdentity({ sessionKey: "agent:main:cron:job:run:monday" });
    const tuesday = openClawRunIdentity({ sessionKey: "agent:main:cron:job:run:tuesday" });
    expect(monday.generation).not.toBe(tuesday.generation);
  });

  test("treats a conversation as unscheduled and prefers the session generation", () => {
    expect(
      openClawRunIdentity({ sessionKey: "agent:main:slack:channel:c1", sessionId: "era-1" }),
    ).toEqual({ scheduled: false, generation: "era-1" });
    // Some channel turns expose the key before the generation.
    expect(openClawRunIdentity({ sessionKey: "agent:main:slack:channel:c1" })).toEqual({
      scheduled: false,
      generation: "agent:main:slack:channel:c1",
    });
    expect(openClawRunIdentity({})).toEqual({ scheduled: false, generation: "" });
  });

  test("does not mistake a cron-shaped conversation key for a scheduled run", () => {
    // A key naming a cron but not a run of one is a conversation about it.
    expect(openClawRunIdentity({ sessionKey: "agent:main:cron:fictional-job" }).scheduled).toBe(
      false,
    );
  });
});

describe("OpenClaw plugin registration", () => {
  test.each(["setup-only", "setup-runtime", "cli-metadata"])(
    "performs no lifecycle or I/O registration in %s mode",
    (mode) => {
      const fake = api(mode);
      registerOpenClawIntegration(fake as never);
      expect(fake.registerService).not.toHaveBeenCalled();
      expect(fake.registerTool).not.toHaveBeenCalled();
      expect(fake.registerHook).not.toHaveBeenCalled();
    },
  );

  test("exposes its static runtime shape in non-activating discovery mode", () => {
    const fake = api("discovery");
    registerOpenClawIntegration(fake as never);
    expect(fake.services).toHaveLength(1);
    expect(fake.hooks).toHaveLength(1);
    expect(fake.tools).toHaveLength(3);
  });

  test("exposes only tools in scoped tool-discovery mode", () => {
    const fake = api("tool-discovery");
    registerOpenClawIntegration(fake as never);
    expect(fake.services).toHaveLength(0);
    expect(fake.hooks).toHaveLength(0);
    expect(fake.tools).toHaveLength(3);
  });

  test("owns work through one managed service in full mode", () => {
    const fake = api("full");
    registerOpenClawIntegration(fake as never);
    expect(fake.services).toHaveLength(1);
    expect(fake.services[0]).toMatchObject({
      id: "omnesis-integration",
      start: expect.any(Function),
      stop: expect.any(Function),
    });
    expect(fake.hooks).toEqual([
      {
        events: ["message_received", "reply_payload_sending"],
        options: {
          name: "omnesis-transcript-ingestion-nudge",
          description: "Queues durable transcript ingestion after conversation activity.",
        },
      },
    ]);
    expect(fake.tools).toHaveLength(3);
  });

  test("discovery-time tool factories delegate to the active full-runtime service", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "omnesis-openclaw-registration-lifecycle-"));
    tempDirs.push(stateDir);
    mkdirSync(join(stateDir, "omnesis"));
    writeFileSync(
      join(stateDir, "omnesis", "integration.json"),
      `${JSON.stringify({
        gatewayUrl: "http://127.0.0.1:1",
        deliveryToken: "omn_fictional_delivery",
        ingestionToken: "omn_fictional_ingestion",
        managementToken: "omn_fictional_management",
        oauth: {
          redirectUri: "http://127.0.0.1:48123/callback",
          clientInformation: { client_id: "client_fictional" },
          tokens: {
            access_token: "omn_fictional_agent",
            refresh_token: "refresh_fictional",
            token_type: "Bearer",
          },
        },
      })}\n`,
    );
    vi.spyOn(AgentIntegrationClient.prototype, "start").mockImplementation(() => {});
    vi.spyOn(DurableTranscriptIngestor.prototype, "start").mockImplementation(() => {});
    vi.spyOn(AgentIntegrationClient.prototype, "stop").mockResolvedValue();
    vi.spyOn(DurableTranscriptIngestor.prototype, "stop").mockResolvedValue();
    vi.spyOn(DurableIntegrationInbox.prototype, "getFiringAuthority").mockReturnValue({
      deliveryId: "sdel_fictional",
      firingId: "sf_fictional",
      nativeSessionId: "agent:main:subagent:omnesis-wf_fictional",
      endpoint: "/subscriptions/firings/sf_fictional/answer",
      token: "omn_fictional_firing",
      expiresAt: 1_900_000_000_000,
    });
    const gatewayAnswer = {
      workflowId: "wf_fictional",
      conversationId: "conv_fictional",
      taskId: "task_fictional",
      status: "denied",
      reason: "hard_stop",
    };
    const postJson = vi
      .spyOn(PinnedGatewayHttpClient.prototype, "postJson")
      .mockResolvedValue(gatewayAnswer);

    const discovery = api("tool-discovery");
    registerOpenClawIntegration(discovery as never);
    const retainedFactory = discovery.tools.find(
      ({ options }) => options.name === "omnesis_subscription_answer",
    )!.factory;

    const full = api("full");
    registerOpenClawIntegration(full as never);
    const service = full.services[0] as {
      start(context: { stateDir: string; logger: { warn(message: string): void } }): Promise<void>;
      stop(): Promise<void>;
    };
    await service.start({ stateDir, logger: { warn: vi.fn() } });

    const retainedTool = retainedFactory({
      sessionKey: "agent:main:subagent:omnesis-wf_fictional",
    }) as {
      execute(
        id: string,
        input: Record<string, unknown>,
      ): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
    };
    const result = await retainedTool.execute("call_fictional", {
      firingId: "sf_fictional",
      question: "What caused the fictional firing?",
      // Defensive regression: a model may still emit a field learned from an
      // older tool schema. It must never be forwarded as gateway identity.
      conversationId: "wf_mistaken_for_a_conversation",
    });
    expect(result.content[0]).toEqual({
      type: "text",
      text: '{"workflowId":"wf_fictional","conversationId":"conv_fictional","taskId":"task_fictional","status":"denied","reason":"hard_stop"}',
    });
    expect(result.details).toEqual({ ok: true, response: gatewayAnswer });
    expect(isToolResultError({ content: result.content, details: gatewayAnswer })).toBe(true);
    expect(isToolResultError(result)).toBe(false);
    // The idempotency key is derived from the ask rather than invented by the
    // model, so a repeat of this call cannot buy a second agent turn.
    expect(postJson).toHaveBeenCalledWith(
      "/subscriptions/firings/sf_fictional/answer",
      {
        question: "What caused the fictional firing?",
        clientRequestId: firingAnswerRequestId({
          endpoint: "/subscriptions/firings/sf_fictional/answer",
          question: "What caused the fictional firing?",
        }),
        // And the route an answer held for approval comes back through: this
        // tool call ends the moment the gateway says it is held, so without
        // one the approved answer would have nowhere to go.
        nativeConversationId: firingAnswerConversationHandle({
          endpoint: "/subscriptions/firings/sf_fictional/answer",
          question: "What caused the fictional firing?",
        }),
      },
      undefined,
      { timeoutMs: expect.any(Number) },
    );
    await service.stop();
  });

  test("waits out an answer turn that outlives an ordinary request budget", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "omnesis-openclaw-answer-wait-"));
    tempDirs.push(stateDir);
    mkdirSync(join(stateDir, "omnesis"));
    writeFileSync(
      join(stateDir, "omnesis", "integration.json"),
      `${JSON.stringify({
        gatewayUrl: "http://127.0.0.1:1",
        deliveryToken: "omn_fictional_delivery",
        ingestionToken: "omn_fictional_ingestion",
        managementToken: "omn_fictional_management",
        oauth: {
          redirectUri: "http://127.0.0.1:48123/callback",
          clientInformation: { client_id: "client_fictional" },
          tokens: {
            access_token: "omn_fictional_agent",
            refresh_token: "refresh_fictional",
            token_type: "Bearer",
          },
        },
      })}\n`,
    );
    vi.spyOn(AgentIntegrationClient.prototype, "start").mockImplementation(() => {});
    vi.spyOn(DurableTranscriptIngestor.prototype, "start").mockImplementation(() => {});
    vi.spyOn(AgentIntegrationClient.prototype, "stop").mockResolvedValue();
    vi.spyOn(DurableTranscriptIngestor.prototype, "stop").mockResolvedValue();
    vi.spyOn(DurableIntegrationInbox.prototype, "getFiringAuthority").mockReturnValue({
      deliveryId: "sdel_fictional",
      firingId: "sf_fictional",
      nativeSessionId: "agent:main:subagent:omnesis-wf_fictional",
      endpoint: "/subscriptions/firings/sf_fictional/answer",
      token: "omn_fictional_firing",
      expiresAt: 1_900_000_000_000,
    });
    const released = {
      workflowId: "wf_fictional",
      conversationId: "conv_fictional",
      taskId: "task_fictional",
      status: "released",
      releaseId: "rel_fictional",
      answer: "A wholly invented invoice arrived on the watched thread.",
    };
    // The live shape: the first request's budget elapses while the gateway is
    // still running the turn, and the turn then finishes.
    let call = 0;
    const postJson = vi
      .spyOn(PinnedGatewayHttpClient.prototype, "postJson")
      .mockImplementation(async () => {
        call += 1;
        if (call === 1) throw new GatewayRequestTimeoutError(20_000);
        return released as never;
      });

    const full = api("full");
    registerOpenClawIntegration(full as never);
    const service = full.services[0] as {
      start(context: { stateDir: string; logger: { warn(message: string): void } }): Promise<void>;
      stop(): Promise<void>;
    };
    await service.start({ stateDir, logger: { warn: vi.fn() } });
    const tool = full.tools
      .find(({ options }) => options.name === "omnesis_subscription_answer")!
      .factory({ sessionKey: "agent:main:subagent:omnesis-wf_fictional" }) as {
      execute(
        id: string,
        input: Record<string, unknown>,
      ): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
    };

    const result = await tool.execute("call_fictional", {
      firingId: "sf_fictional",
      question: "What caused the fictional firing?",
    });

    expect(result.details).toEqual({ ok: true, response: released });
    expect(postJson).toHaveBeenCalledTimes(2);
    // Both attempts carry one request id, so the second collects the turn the
    // first abandoned rather than starting another one.
    const ids = postJson.mock.calls.map(
      (args) => (args[1] as { clientRequestId: string }).clientRequestId,
    );
    expect(new Set(ids).size).toBe(1);
    await service.stop();
  }, 20_000);

  test.each([
    { subscriptions: false, offered: ["omnesis_answer"] },
    {
      subscriptions: true,
      offered: ["omnesis_answer", "omnesis_subscription_answer", "omnesis_subscriptions"],
    },
  ])(
    "offers the tools the recorded gateway capability allows (subscriptions: $subscriptions)",
    async ({ subscriptions, offered }) => {
      // The gateway is unreachable here, which is the point: the answer this
      // installation was last given is what decides its tool set, so a start
      // with nothing to ask cannot silently drop or invent a tool.
      const stateDir = mkdtempSync(join(tmpdir(), "omnesis-openclaw-capability-"));
      tempDirs.push(stateDir);
      mkdirSync(join(stateDir, "omnesis"));
      writeFileSync(
        join(stateDir, "omnesis", "integration.json"),
        `${JSON.stringify({
          gatewayUrl: "http://127.0.0.1:1",
          deliveryToken: "omn_fictional_delivery",
          ingestionToken: "omn_fictional_ingestion",
          managementToken: "omn_fictional_management",
          oauth: {
            redirectUri: "http://127.0.0.1:48123/callback",
            clientInformation: { client_id: "client_fictional" },
            tokens: {
              access_token: "omn_fictional_agent",
              refresh_token: "refresh_fictional",
              token_type: "Bearer",
            },
          },
          capabilities: { subscriptions },
        })}\n`,
      );
      vi.spyOn(AgentIntegrationClient.prototype, "start").mockImplementation(() => {});
      vi.spyOn(DurableTranscriptIngestor.prototype, "start").mockImplementation(() => {});
      vi.spyOn(AgentIntegrationClient.prototype, "stop").mockResolvedValue();
      vi.spyOn(DurableTranscriptIngestor.prototype, "stop").mockResolvedValue();

      const full = api("full");
      registerOpenClawIntegration(full as never);
      const service = full.services[0] as {
        start(context: {
          stateDir: string;
          logger: { warn(message: string): void };
        }): Promise<void>;
        stop(): Promise<void>;
      };
      await service.start({ stateDir, logger: { warn: vi.fn() } });
      try {
        const resolved = full.tools
          .filter(
            ({ factory }) =>
              factory({
                sessionKey: "agent:main:subagent:omnesis-fictional",
                senderIsOwner: true,
              } as never) !== null,
          )
          .map(({ options }) => options.name)
          .sort();
        expect(resolved).toEqual(offered);
      } finally {
        await service.stop();
      }
    },
  );

  test("returns only a locally mapped typed 422 to the subscription tool", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "omnesis-openclaw-management-error-"));
    tempDirs.push(stateDir);
    mkdirSync(join(stateDir, "omnesis"));
    writeFileSync(
      join(stateDir, "omnesis", "integration.json"),
      `${JSON.stringify({
        gatewayUrl: "http://127.0.0.1:1",
        deliveryToken: "omn_fictional_delivery",
        ingestionToken: "omn_fictional_ingestion",
        managementToken: "omn_fictional_management",
        oauth: {
          redirectUri: "http://127.0.0.1:48123/callback",
          clientInformation: { client_id: "client_fictional" },
          tokens: {
            access_token: "omn_fictional_agent",
            refresh_token: "refresh_fictional",
            token_type: "Bearer",
          },
        },
      })}\n`,
    );
    vi.spyOn(AgentIntegrationClient.prototype, "start").mockImplementation(() => {});
    vi.spyOn(DurableTranscriptIngestor.prototype, "start").mockImplementation(() => {});
    vi.spyOn(AgentIntegrationClient.prototype, "stop").mockResolvedValue();
    vi.spyOn(DurableTranscriptIngestor.prototype, "stop").mockResolvedValue();
    const gatewayError = {
      error: "Injected gateway prose must-not-leave.",
      code: "SUBSCRIPTION_CONDITION_UNSUPPORTED",
      details: {
        reason: "unsupported_condition",
        privateCatalogState: "must-not-leave",
      },
    };
    vi.spyOn(PinnedGatewayHttpClient.prototype, "requestJson").mockRejectedValue(
      new IntegrationHttpError(422, "gateway rejected request (HTTP 422)", gatewayError),
    );

    const full = api("full");
    registerOpenClawIntegration(full as never);
    const service = full.services[0] as {
      start(context: { stateDir: string; logger: { warn(message: string): void } }): Promise<void>;
      stop(): Promise<void>;
    };
    await service.start({ stateDir, logger: { warn: vi.fn() } });
    const tool = full.tools
      .find(({ options }) => options.name === "omnesis_subscriptions")!
      .factory({ sessionKey: "agent:main:fictional", senderIsOwner: true } as never) as {
      execute(
        id: string,
        input: Record<string, unknown>,
      ): Promise<{ content: Array<{ text: string }>; details: unknown }>;
    };

    await expect(
      tool.execute("call_fictional", {
        action: "create",
        condition: "A fictional grouped warehouse total crosses its approved threshold.",
        reaction: "Notify that the approved condition became true.",
        idempotencyKey: "fictional-watch-request",
      }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "The requested subscription condition is not currently supported.",
            code: "SUBSCRIPTION_CONDITION_UNSUPPORTED",
            details: { reason: "unsupported_condition" },
          }),
        },
      ],
      details: {
        error: "The requested subscription condition is not currently supported.",
        code: "SUBSCRIPTION_CONDITION_UNSUPPORTED",
        details: { reason: "unsupported_condition" },
      },
    });
    await service.stop();
  });

  test("closes its inbox when startup fails after opening durable state", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "omnesis-openclaw-start-failure-"));
    tempDirs.push(stateDir);
    mkdirSync(join(stateDir, "omnesis"));
    writeFileSync(
      join(stateDir, "omnesis", "integration.json"),
      `${JSON.stringify({
        gatewayUrl: "https://gateway.example.org:7600",
        deliveryToken: "omn_fictional_delivery",
        ingestionToken: "omn_fictional_ingestion",
        managementToken: "omn_fictional_management",
        oauth: {
          redirectUri: "http://127.0.0.1:48123/callback",
          clientInformation: { client_id: "client_fictional" },
          tokens: {
            access_token: "omn_fictional_agent",
            refresh_token: "refresh_fictional",
            token_type: "Bearer",
          },
        },
      })}\n`,
    );
    const close = vi.spyOn(DurableIntegrationInbox.prototype, "close");
    const fake = api("full");
    registerOpenClawIntegration(fake as never);
    const service = fake.services[0] as {
      start(context: { stateDir: string; logger: { warn(message: string): void } }): Promise<void>;
    };

    await expect(service.start({ stateDir, logger: { warn: vi.fn() } })).rejects.toThrow(
      /pinned TLS trust/,
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("keeps legacy ingestion and delivery running while directing OAuth tools to repair", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "omnesis-openclaw-legacy-"));
    tempDirs.push(stateDir);
    mkdirSync(join(stateDir, "omnesis"));
    writeFileSync(
      join(stateDir, "omnesis", "integration.json"),
      JSON.stringify({
        gatewayUrl: "http://127.0.0.1:1",
        deliveryToken: "omn_fictional_delivery",
        ingestionToken: "omn_fictional_ingestion",
      }),
    );
    const deliveryStart = vi
      .spyOn(AgentIntegrationClient.prototype, "start")
      .mockImplementation(() => {});
    const ingestionStart = vi
      .spyOn(DurableTranscriptIngestor.prototype, "start")
      .mockImplementation(() => {});
    vi.spyOn(AgentIntegrationClient.prototype, "stop").mockResolvedValue();
    vi.spyOn(DurableTranscriptIngestor.prototype, "stop").mockResolvedValue();
    const fake = api("full");
    registerOpenClawIntegration(fake as never);
    const service = fake.services[0] as {
      start(context: { stateDir: string; logger: { warn(message: string): void } }): Promise<void>;
      stop(): Promise<void>;
    };
    await service.start({ stateDir, logger: fake.logger });

    expect(deliveryStart).toHaveBeenCalledOnce();
    expect(ingestionStart).toHaveBeenCalledOnce();
    const answer = fake.tools
      .find(({ options }) => options.name === "omnesis_answer")!
      .factory({ sessionKey: "agent:main:main" }) as {
      execute(id: string, input: Record<string, unknown>): Promise<unknown>;
    };
    await expect(
      answer.execute("call-legacy", { question: "A fictional question?" }),
    ).rejects.toBeInstanceOf(Error);
    await service.stop();
  });

  test("closes and resets durable state even when a managed stop rejects", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "omnesis-openclaw-stop-failure-"));
    tempDirs.push(stateDir);
    mkdirSync(join(stateDir, "omnesis"));
    writeFileSync(
      join(stateDir, "omnesis", "integration.json"),
      `${JSON.stringify({
        gatewayUrl: "http://127.0.0.1:1",
        deliveryToken: "omn_fictional_delivery",
        ingestionToken: "omn_fictional_ingestion",
        managementToken: "omn_fictional_management",
        oauth: {
          redirectUri: "http://127.0.0.1:48123/callback",
          clientInformation: { client_id: "client_fictional" },
          tokens: {
            access_token: "omn_fictional_agent",
            refresh_token: "refresh_fictional",
            token_type: "Bearer",
          },
        },
      })}\n`,
    );
    vi.spyOn(AgentIntegrationClient.prototype, "start").mockImplementation(() => {});
    vi.spyOn(DurableTranscriptIngestor.prototype, "start").mockImplementation(() => {});
    vi.spyOn(AgentIntegrationClient.prototype, "stop").mockRejectedValue(
      new Error("fictional delivery stop failure"),
    );
    vi.spyOn(DurableTranscriptIngestor.prototype, "stop").mockResolvedValue();
    const close = vi.spyOn(DurableIntegrationInbox.prototype, "close");
    const fake = api("full");
    registerOpenClawIntegration(fake as never);
    const service = fake.services[0] as {
      start(context: { stateDir: string; logger: { warn(message: string): void } }): Promise<void>;
      stop(): Promise<void>;
    };
    await service.start({ stateDir, logger: { warn: vi.fn() } });

    await expect(service.stop()).rejects.toThrow(/shutdown failed/);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(service.stop()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("declares every registered tool in the static OpenClaw manifest", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "openclaw.plugin.json"), "utf8"),
    ) as { contracts?: { tools?: string[] } };
    const fake = api("full");
    registerOpenClawIntegration(fake as never);

    expect(manifest.contracts?.tools?.sort()).toEqual(
      fake.tools.map(({ options }) => options.name).sort(),
    );
  });

  test("loads against the installed OpenClaw plugin SDK", async () => {
    const pluginSdk = await import("openclaw/plugin-sdk/plugin-entry");
    const transcriptRuntime = await import("openclaw/plugin-sdk/session-transcript-runtime");
    expect(pluginSdk.definePluginEntry(OPENCLAW_PLUGIN_DEFINITION)).toMatchObject({
      id: "omnesis-integration",
      register: registerOpenClawIntegration,
    });
    expect(transcriptRuntime.readSessionTranscriptEvents).toEqual(expect.any(Function));
  });

  test("uses the installed 2026.7 tool-factory contract and trusted session context", () => {
    const fake = api("full");
    registerOpenClawIntegration(fake as never);
    const registration = fake.tools.find(
      ({ options }) => options.name === "omnesis_subscription_answer",
    )!;
    const ordinaryAnswer = fake.tools.find(({ options }) => options.name === "omnesis_answer")!;
    // A trusted session is the whole precondition for asking. A session with
    // no reply route — an isolated cron whose workflow messages nowhere, or
    // somewhere other than its origin — still gets the tool.
    expect(
      ordinaryAnswer.factory({ sessionKey: "agent:main:telegram:dm:fictional" }),
    ).toMatchObject({ name: "omnesis_answer" });
    expect(
      ordinaryAnswer.factory({
        sessionKey: "agent:main:cron:fictional-job:run:fictional-run",
      }),
    ).toMatchObject({ name: "omnesis_answer" });
    expect(ordinaryAnswer.factory({})).toBeNull();
    expect(
      ordinaryAnswer.factory({
        sessionKey: "agent:main:telegram:dm:fictional",
        deliveryContext: { channel: "telegram", to: "fictional-recipient" },
      } as never),
    ).toMatchObject({ name: "omnesis_answer" });
    expect(
      ordinaryAnswer.factory({
        sessionKey: "agent:main:telegram:dm:fictional",
        sessionId: "fictional-session-era",
        deliveryContext: {
          channel: "telegram",
          to: "fictional-recipient",
          accountId: "fictional-account",
          threadId: "fictional-thread",
        },
      } as never),
    ).toMatchObject({
      name: "omnesis_answer",
      parameters: { required: ["question"], additionalProperties: false },
    });
    expect(
      ordinaryAnswer.factory({
        sessionKey: "agent:main:telegram:dm:fictional",
        sessionId: "fictional-session-era",
        deliveryContext: {
          channel: "telegram",
          to: "fictional-recipient",
          accountId: "fictional-account",
          threadId: "fictional-thread",
        },
      } as never)?.description,
    ).toContain("calendar or meeting links");
    expect(registration.options).toEqual({ name: "omnesis_subscription_answer" });
    expect(registration.factory({ sessionKey: "agent:main:telegram:dm:fictional" })).toBeNull();
    expect(
      registration.factory({
        sessionKey: "agent:main:subagent:omnesis-wf_fictional_1",
      }),
    ).toMatchObject({
      name: "omnesis_subscription_answer",
      label: "Omnesis Subscription Answer",
      parameters: {
        type: "object",
        // The model names the firing and the question; it never invents the
        // idempotency key, which has to stay stable across its own retries.
        required: ["firingId", "question"],
        additionalProperties: false,
        properties: expect.not.objectContaining({ conversationId: expect.anything() }),
      },
      execute: expect.any(Function),
    });
    const management = fake.tools.find(({ options }) => options.name === "omnesis_subscriptions")!;
    expect(management.factory({})).toBeNull();
    // The paired OpenClaw installation is one principal. Every valid session
    // receives the same management tool, independent of the native owner hint.
    expect(
      management.factory({
        sessionKey: "agent:main:telegram:dm:fictional",
        senderIsOwner: false,
      } as never),
    ).toMatchObject({ name: "omnesis_subscriptions" });
    expect(management.factory({ sessionKey: "agent:main:main" })).toMatchObject({
      name: "omnesis_subscriptions",
    });
    expect(
      management.factory({
        sessionKey: "agent:main:telegram:dm:fictional",
        senderIsOwner: true,
      } as never),
    ).toMatchObject({
      name: "omnesis_subscriptions",
      parameters: {
        type: "object",
        required: ["action"],
        properties: {
          expectedRevision: {
            type: "integer",
            minimum: 1,
          },
        },
        allOf: [
          {
            then: {
              required: ["expectedRevision"],
              not: {
                anyOf: [
                  { required: ["status", "condition"] },
                  { required: ["status", "reaction"] },
                  { required: ["status", "expiresAt"] },
                ],
              },
            },
          },
        ],
        additionalProperties: false,
      },
    });
  });

  test("later asks in one scheduled run join the workflow it already minted", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "omnesis-openclaw-thread-"));
    tempDirs.push(stateDir);
    mkdirSync(join(stateDir, "omnesis"));
    writeFileSync(
      join(stateDir, "omnesis", "integration.json"),
      `${JSON.stringify({
        gatewayUrl: "http://127.0.0.1:1",
        deliveryToken: "omn_fictional_delivery",
        ingestionToken: "omn_fictional_ingestion",
        managementToken: "omn_fictional_management",
        oauth: {
          redirectUri: "http://127.0.0.1:48123/callback",
          clientInformation: { client_id: "client_fictional" },
          tokens: {
            access_token: "omn_fictional_agent",
            refresh_token: "refresh_fictional",
            token_type: "Bearer",
          },
        },
      })}\n`,
    );
    vi.spyOn(AgentIntegrationClient.prototype, "start").mockImplementation(() => {});
    vi.spyOn(DurableTranscriptIngestor.prototype, "start").mockImplementation(() => {});
    vi.spyOn(AgentIntegrationClient.prototype, "stop").mockResolvedValue();
    vi.spyOn(DurableTranscriptIngestor.prototype, "stop").mockResolvedValue();
    const postJson = vi.spyOn(NativeAnswerMcpClient.prototype, "postJson").mockResolvedValue({
      status: "released",
      answer: "A fictional answer.",
      workflowId: "wf_fictional",
      conversationId: "conv_fictional",
    });
    const fake = api("full");
    registerOpenClawIntegration(fake as never);
    const service = fake.services[0] as {
      start(context: { stateDir: string; logger: { warn(message: string): void } }): Promise<void>;
      stop(): Promise<void>;
    };
    await service.start({ stateDir, logger: { warn: vi.fn() } });
    const factory = fake.tools.find(({ options }) => options.name === "omnesis_answer")!.factory;
    const ask = async (sessionKey: string, question: string) => {
      const tool = factory({ sessionKey }) as {
        execute(id: string, input: Record<string, unknown>): Promise<unknown>;
      };
      await tool.execute("call", { question });
    };

    await ask("agent:main:cron:job:run:one", "First question?");
    await ask("agent:main:cron:job:run:one", "Second question?");
    await ask("agent:main:cron:job:run:two", "First question?");

    const bodies = postJson.mock.calls.map(
      (call) => call[1] as { workflowId?: string; conversationId?: string },
    );
    // Cumulative disclosure accumulates against a workflow, so a run's later
    // asks have to join the one its first ask minted.
    expect(bodies[0]?.workflowId).toBeUndefined();
    expect(bodies[1]?.workflowId).toBe("wf_fictional");
    // A different firing is a different job and starts clean.
    expect(bodies[2]?.workflowId).toBeUndefined();
    // A conversation admits one active task, so it is never carried.
    expect(bodies.every((body) => body.conversationId === undefined)).toBe(true);
    await service.stop();
  });

  test("a granted window reaches the request, and repeated waiting is bounded", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "omnesis-openclaw-grant-"));
    tempDirs.push(stateDir);
    mkdirSync(join(stateDir, "omnesis"));
    writeFileSync(
      join(stateDir, "omnesis", "integration.json"),
      `${JSON.stringify({
        gatewayUrl: "http://127.0.0.1:1",
        deliveryToken: "omn_fictional_delivery",
        ingestionToken: "omn_fictional_ingestion",
        managementToken: "omn_fictional_management",
        oauth: {
          redirectUri: "http://127.0.0.1:48123/callback",
          clientInformation: { client_id: "client_fictional" },
          tokens: {
            access_token: "omn_fictional_agent",
            refresh_token: "refresh_fictional",
            token_type: "Bearer",
          },
        },
      })}\n`,
    );
    vi.spyOn(AgentIntegrationClient.prototype, "start").mockImplementation(() => {});
    vi.spyOn(DurableTranscriptIngestor.prototype, "start").mockImplementation(() => {});
    vi.spyOn(AgentIntegrationClient.prototype, "stop").mockResolvedValue();
    vi.spyOn(DurableTranscriptIngestor.prototype, "stop").mockResolvedValue();
    const postJson = vi
      .spyOn(NativeAnswerMcpClient.prototype, "postJson")
      .mockResolvedValue({ status: "released", answer: "A fictional answer." });
    const fake = api("full");
    registerOpenClawIntegration(fake as never);
    const service = fake.services[0] as {
      start(context: { stateDir: string; logger: { warn(message: string): void } }): Promise<void>;
      stop(): Promise<void>;
    };
    await service.start({ stateDir, logger: { warn: vi.fn() } });
    const tool = fake.tools
      .find(({ options }) => options.name === "omnesis_answer")!
      .factory({ sessionKey: "agent:main:cron:job:run:one" }) as {
      execute(id: string, input: Record<string, unknown>): Promise<unknown>;
    };

    await tool.execute("call", { question: "How is today?", timeoutMs: 600_000 });

    // The grant has to survive the whole chain — schema, execute, budget — or
    // the wait silently reverts to the host's short default.
    expect(postJson.mock.calls[0]?.[3]).toEqual({
      timeoutMs: openClawAnswerBudget({ timeoutMs: 600_000 }).submitTimeoutMs,
    });
    expect(openClawAnswerBudget({ timeoutMs: 600_000 }).submitTimeoutMs).toBeGreaterThan(
      openClawAnswerBudget({}).submitTimeoutMs!,
    );
    await service.stop();
  });

  test("a scheduled run asks for a settled outcome and is a new ask on every firing", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "omnesis-openclaw-cron-answer-"));
    tempDirs.push(stateDir);
    mkdirSync(join(stateDir, "omnesis"));
    writeFileSync(
      join(stateDir, "omnesis", "integration.json"),
      `${JSON.stringify({
        gatewayUrl: "http://127.0.0.1:1",
        deliveryToken: "omn_fictional_delivery",
        ingestionToken: "omn_fictional_ingestion",
        managementToken: "omn_fictional_management",
        oauth: {
          redirectUri: "http://127.0.0.1:48123/callback",
          clientInformation: { client_id: "client_fictional" },
          tokens: {
            access_token: "omn_fictional_agent",
            refresh_token: "refresh_fictional",
            token_type: "Bearer",
          },
        },
      })}\n`,
    );
    vi.spyOn(AgentIntegrationClient.prototype, "start").mockImplementation(() => {});
    vi.spyOn(DurableTranscriptIngestor.prototype, "start").mockImplementation(() => {});
    vi.spyOn(AgentIntegrationClient.prototype, "stop").mockResolvedValue();
    vi.spyOn(DurableTranscriptIngestor.prototype, "stop").mockResolvedValue();
    const postJson = vi
      .spyOn(NativeAnswerMcpClient.prototype, "postJson")
      .mockResolvedValue({ status: "released", answer: "A fictional resting figure." });
    const fake = api("full");
    registerOpenClawIntegration(fake as never);
    const service = fake.services[0] as {
      start(context: { stateDir: string; logger: { warn(message: string): void } }): Promise<void>;
      stop(): Promise<void>;
    };
    await service.start({ stateDir, logger: { warn: vi.fn() } });
    const factory = fake.tools.find(({ options }) => options.name === "omnesis_answer")!.factory;
    const question = "How does today compare with the last week?";
    const runTool = async (runId: string) => {
      // An isolated cron run: no reply route at all, because the workflow may
      // send its output anywhere or nowhere.
      const tool = factory({
        sessionKey: `agent:main:cron:fictional-job:run:${runId}`,
      }) as { execute(id: string, input: Record<string, unknown>): Promise<unknown> };
      await tool.execute("tool-call", { question });
    };

    await runTool("run-monday");
    await runTool("run-monday");
    await runTool("run-tuesday");

    const bodies = postJson.mock.calls.map(
      (call) => call[1] as { clientRequestId: string; approval?: string },
    );
    // Nobody is present to approve, so the run asks for a settled outcome.
    expect(bodies.every((body) => body.approval === "never")).toBe(true);
    // Twice in one run is the same ask; the next firing is a different one.
    expect(bodies[0]?.clientRequestId).toBe(bodies[1]?.clientRequestId);
    expect(bodies[2]?.clientRequestId).not.toBe(bodies[0]?.clientRequestId);
    expect(postJson.mock.calls.every((call) => call[0] === "/mcp")).toBe(true);
    await service.stop();
  });

  test("asks for a settled outcome when no conversation could receive a held answer", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "omnesis-openclaw-routeless-approval-"));
    tempDirs.push(stateDir);
    mkdirSync(join(stateDir, "omnesis"));
    writeFileSync(
      join(stateDir, "omnesis", "integration.json"),
      `${JSON.stringify({
        gatewayUrl: "http://127.0.0.1:1",
        deliveryToken: "omn_fictional_delivery",
        ingestionToken: "omn_fictional_ingestion",
        managementToken: "omn_fictional_management",
        oauth: {
          redirectUri: "http://127.0.0.1:48123/callback",
          clientInformation: { client_id: "client_fictional" },
          tokens: {
            access_token: "omn_fictional_agent",
            refresh_token: "refresh_fictional",
            token_type: "Bearer",
          },
        },
      })}\n`,
    );
    vi.spyOn(AgentIntegrationClient.prototype, "start").mockImplementation(() => {});
    vi.spyOn(DurableTranscriptIngestor.prototype, "start").mockImplementation(() => {});
    vi.spyOn(AgentIntegrationClient.prototype, "stop").mockResolvedValue();
    vi.spyOn(DurableTranscriptIngestor.prototype, "stop").mockResolvedValue();
    const postJson = vi
      .spyOn(NativeAnswerMcpClient.prototype, "postJson")
      .mockResolvedValue({ status: "released", answer: "A fictional answer." });
    const fake = api("full");
    registerOpenClawIntegration(fake as never);
    const service = fake.services[0] as {
      start(context: { stateDir: string; logger: { warn(message: string): void } }): Promise<void>;
      stop(): Promise<void>;
    };
    await service.start({ stateDir, logger: { warn: vi.fn() } });
    // A main-agent session: a person is present, but no reply route exists, so
    // a held answer would be retried into nowhere.
    const tool = fake.tools
      .find(({ options }) => options.name === "omnesis_answer")!
      .factory({ sessionKey: "agent:main:main" }) as {
      execute(id: string, input: Record<string, unknown>): Promise<unknown>;
    };

    await tool.execute("tool-call", { question: "What happened yesterday?" });

    expect((postJson.mock.calls[0]?.[1] as { approval?: string }).approval).toBe("never");
    await service.stop();
  });

  test("keeps the completion route filed when the socket budget elapses", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "omnesis-openclaw-route-survives-"));
    tempDirs.push(stateDir);
    mkdirSync(join(stateDir, "omnesis"));
    writeFileSync(
      join(stateDir, "omnesis", "integration.json"),
      `${JSON.stringify({
        gatewayUrl: "http://127.0.0.1:1",
        deliveryToken: "omn_fictional_delivery",
        ingestionToken: "omn_fictional_ingestion",
        managementToken: "omn_fictional_management",
        oauth: {
          redirectUri: "http://127.0.0.1:48123/callback",
          clientInformation: { client_id: "client_fictional" },
          tokens: {
            access_token: "omn_fictional_agent",
            refresh_token: "refresh_fictional",
            token_type: "Bearer",
          },
        },
      })}\n`,
    );
    vi.spyOn(AgentIntegrationClient.prototype, "start").mockImplementation(() => {});
    vi.spyOn(DurableTranscriptIngestor.prototype, "start").mockImplementation(() => {});
    vi.spyOn(AgentIntegrationClient.prototype, "stop").mockResolvedValue();
    vi.spyOn(DurableTranscriptIngestor.prototype, "stop").mockResolvedValue();
    const routePut = vi.spyOn(OpenClawCompletionRoutes.prototype, "put");
    const routeDelete = vi.spyOn(OpenClawCompletionRoutes.prototype, "delete");
    vi.spyOn(NativeAnswerMcpClient.prototype, "postJson")
      .mockRejectedValueOnce(new GatewayRequestTimeoutError(180_000))
      .mockResolvedValueOnce({
        status: "approval_required",
        taskId: "task_fictional",
      });
    const fake = api("full");
    registerOpenClawIntegration(fake as never);
    const service = fake.services[0] as {
      start(context: { stateDir: string; logger: { warn(message: string): void } }): Promise<void>;
      stop(): Promise<void>;
    };
    await service.start({ stateDir, logger: { warn: vi.fn() } });
    const tool = fake.tools
      .find(({ options }) => options.name === "omnesis_answer")!
      .factory({
        sessionKey: "agent:main:telegram:dm:fictional",
        deliveryContext: { channel: "telegram", to: "fictional-recipient" },
      } as never) as { execute(id: string, input: Record<string, unknown>): Promise<unknown> };

    await tool.execute("tool-call", { question: "What happened yesterday?" });

    // The gateway kept working after the client's budget elapsed, so the route
    // must still be filed — an answer released later has nowhere else to go.
    expect(routeDelete).not.toHaveBeenCalled();
    const handle = (routePut.mock.calls[0]?.[0] as { nativeConversationId: string })
      .nativeConversationId;
    expect(
      routePut.mock.calls.every(
        (call) => (call[0] as { nativeConversationId: string }).nativeConversationId === handle,
      ),
    ).toBe(true);
    await service.stop();
  }, 30_000);

  test("drops the completion route when the ask fails outright", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "omnesis-openclaw-route-dropped-"));
    tempDirs.push(stateDir);
    mkdirSync(join(stateDir, "omnesis"));
    writeFileSync(
      join(stateDir, "omnesis", "integration.json"),
      `${JSON.stringify({
        gatewayUrl: "http://127.0.0.1:1",
        deliveryToken: "omn_fictional_delivery",
        ingestionToken: "omn_fictional_ingestion",
        managementToken: "omn_fictional_management",
        oauth: {
          redirectUri: "http://127.0.0.1:48123/callback",
          clientInformation: { client_id: "client_fictional" },
          tokens: {
            access_token: "omn_fictional_agent",
            refresh_token: "refresh_fictional",
            token_type: "Bearer",
          },
        },
      })}\n`,
    );
    vi.spyOn(AgentIntegrationClient.prototype, "start").mockImplementation(() => {});
    vi.spyOn(DurableTranscriptIngestor.prototype, "start").mockImplementation(() => {});
    vi.spyOn(AgentIntegrationClient.prototype, "stop").mockResolvedValue();
    vi.spyOn(DurableTranscriptIngestor.prototype, "stop").mockResolvedValue();
    const routeDelete = vi.spyOn(OpenClawCompletionRoutes.prototype, "delete");
    vi.spyOn(NativeAnswerMcpClient.prototype, "postJson").mockRejectedValue(
      new IntegrationHttpError(400, "bad request", undefined, "BAD_REQUEST"),
    );
    const fake = api("full");
    registerOpenClawIntegration(fake as never);
    const service = fake.services[0] as {
      start(context: { stateDir: string; logger: { warn(message: string): void } }): Promise<void>;
      stop(): Promise<void>;
    };
    await service.start({ stateDir, logger: { warn: vi.fn() } });
    const tool = fake.tools
      .find(({ options }) => options.name === "omnesis_answer")!
      .factory({
        sessionKey: "agent:main:telegram:dm:fictional",
        deliveryContext: { channel: "telegram", to: "fictional-recipient" },
      } as never) as { execute(id: string, input: Record<string, unknown>): Promise<unknown> };

    await expect(
      tool.execute("tool-call", { question: "What happened yesterday?" }),
    ).rejects.toThrow();
    // Nothing will ever complete this ask, so its route is unreachable.
    expect(routeDelete).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  test("keeps waiting on one ask when the socket budget elapses, without buying a second turn", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "omnesis-openclaw-answer-repost-"));
    tempDirs.push(stateDir);
    mkdirSync(join(stateDir, "omnesis"));
    writeFileSync(
      join(stateDir, "omnesis", "integration.json"),
      `${JSON.stringify({
        gatewayUrl: "http://127.0.0.1:1",
        deliveryToken: "omn_fictional_delivery",
        ingestionToken: "omn_fictional_ingestion",
        managementToken: "omn_fictional_management",
        oauth: {
          redirectUri: "http://127.0.0.1:48123/callback",
          clientInformation: { client_id: "client_fictional" },
          tokens: {
            access_token: "omn_fictional_agent",
            refresh_token: "refresh_fictional",
            token_type: "Bearer",
          },
        },
      })}\n`,
    );
    vi.spyOn(AgentIntegrationClient.prototype, "start").mockImplementation(() => {});
    vi.spyOn(DurableTranscriptIngestor.prototype, "start").mockImplementation(() => {});
    vi.spyOn(AgentIntegrationClient.prototype, "stop").mockResolvedValue();
    vi.spyOn(DurableTranscriptIngestor.prototype, "stop").mockResolvedValue();
    const postJson = vi
      .spyOn(NativeAnswerMcpClient.prototype, "postJson")
      // The answer outlives the first socket budget, then the gateway says the
      // turn for this exact ask is still running.
      .mockRejectedValueOnce(new GatewayRequestTimeoutError(180_000))
      .mockRejectedValueOnce(
        new IntegrationHttpError(409, "still running", undefined, "ANSWER_IN_PROGRESS"),
      )
      .mockResolvedValueOnce({ status: "released", answer: "A fictional answer." });
    const fake = api("full");
    registerOpenClawIntegration(fake as never);
    const service = fake.services[0] as {
      start(context: { stateDir: string; logger: { warn(message: string): void } }): Promise<void>;
      stop(): Promise<void>;
    };
    await service.start({ stateDir, logger: { warn: vi.fn() } });
    const tool = fake.tools
      .find(({ options }) => options.name === "omnesis_answer")!
      .factory({
        sessionKey: "agent:main:cron:fictional-job:run:fictional-run",
      }) as { execute(id: string, input: Record<string, unknown>): Promise<unknown> };

    await expect(
      tool.execute("tool-call", { question: "What happened yesterday?" }),
    ).resolves.toMatchObject({ details: { ok: true, response: { status: "released" } } });

    expect(postJson).toHaveBeenCalledTimes(3);
    const ids = postJson.mock.calls.map(
      (call) => (call[1] as { clientRequestId: string }).clientRequestId,
    );
    // Every repost is the same ask, so the gateway attaches instead of
    // starting another turn — repeating the request is how you poll.
    expect(new Set(ids).size).toBe(1);
    await service.stop();
  }, 30_000);

  test("a conversational pending retry reuses its identifier across different tool calls", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "omnesis-openclaw-conversation-pending-"));
    tempDirs.push(stateDir);
    mkdirSync(join(stateDir, "omnesis"));
    writeFileSync(
      join(stateDir, "omnesis", "integration.json"),
      JSON.stringify({
        gatewayUrl: "http://127.0.0.1:1",
        deliveryToken: "omn_fictional_delivery",
        ingestionToken: "omn_fictional_ingestion",
        managementToken: "omn_fictional_management",
        oauth: {
          redirectUri: "http://127.0.0.1:48123/callback",
          clientInformation: { client_id: "client_fictional" },
          tokens: { access_token: "access_fictional", refresh_token: "refresh_fictional" },
        },
      }),
    );
    vi.spyOn(AgentIntegrationClient.prototype, "start").mockImplementation(() => {});
    vi.spyOn(DurableTranscriptIngestor.prototype, "start").mockImplementation(() => {});
    vi.spyOn(AgentIntegrationClient.prototype, "stop").mockResolvedValue();
    vi.spyOn(DurableTranscriptIngestor.prototype, "stop").mockResolvedValue();
    const postJson = vi
      .spyOn(NativeAnswerMcpClient.prototype, "postJson")
      .mockRejectedValue(
        new IntegrationHttpError(409, "still running", undefined, "ANSWER_IN_PROGRESS"),
      );
    const fake = api("full");
    registerOpenClawIntegration(fake as never);
    const service = fake.services[0] as {
      start(context: { stateDir: string; logger: { warn(message: string): void } }): Promise<void>;
      stop(): Promise<void>;
    };
    await service.start({ stateDir, logger: { warn: vi.fn() } });
    const tool = fake.tools
      .find(({ options }) => options.name === "omnesis_answer")!
      .factory({ sessionKey: "agent:main:main", sessionId: "conversation-run" } as never) as {
      execute(id: string, input: Record<string, unknown>): Promise<unknown>;
    };

    await expect(
      tool.execute("first-tool-call", { question: "A fictional question?", timeoutMs: 20 }),
    ).resolves.toMatchObject({ details: { pending: true } });
    const firstRequestIds = postJson.mock.calls.map(
      (call) => (call[1] as { clientRequestId: string }).clientRequestId,
    );
    expect(new Set(firstRequestIds).size).toBe(1);
    postJson.mockResolvedValueOnce({ status: "released", answer: "A fictional answer." });
    await expect(
      tool.execute("second-tool-call", { question: "A fictional question?", timeoutMs: 20 }),
    ).resolves.toMatchObject({ details: { response: { status: "released" } } });
    const secondRequestId = (
      postJson.mock.calls.at(-1)?.[1] as { clientRequestId: string } | undefined
    )?.clientRequestId;
    expect(secondRequestId).toBe(firstRequestIds[0]);
    await service.stop();
  });

  test("posts a held ordinary answer to the captured trusted route without accepting model routing", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "omnesis-openclaw-ordinary-answer-"));
    tempDirs.push(stateDir);
    mkdirSync(join(stateDir, "omnesis"));
    writeFileSync(
      join(stateDir, "omnesis", "integration.json"),
      `${JSON.stringify({
        gatewayUrl: "http://127.0.0.1:1",
        deliveryToken: "omn_fictional_delivery",
        ingestionToken: "omn_fictional_ingestion",
        managementToken: "omn_fictional_management",
        oauth: {
          redirectUri: "http://127.0.0.1:48123/callback",
          clientInformation: { client_id: "client_fictional" },
          tokens: {
            access_token: "omn_fictional_agent",
            refresh_token: "refresh_fictional",
            token_type: "Bearer",
          },
        },
      })}\n`,
    );
    vi.spyOn(AgentIntegrationClient.prototype, "start").mockImplementation(() => {});
    vi.spyOn(DurableTranscriptIngestor.prototype, "start").mockImplementation(() => {});
    vi.spyOn(AgentIntegrationClient.prototype, "stop").mockResolvedValue();
    vi.spyOn(DurableTranscriptIngestor.prototype, "stop").mockResolvedValue();
    const postJson = vi
      .spyOn(NativeAnswerMcpClient.prototype, "postJson")
      .mockResolvedValueOnce({
        workflowId: "wf_fictional",
        conversationId: "conv_fictional",
        taskId: "task_fictional",
        status: "approval_required",
        approvalId: "approval_fictional",
        approvalExpiresAt: 1_900_000_000_000,
      })
      .mockResolvedValueOnce({ ok: true });
    const fake = api("full");
    registerOpenClawIntegration(fake as never);
    const service = fake.services[0] as {
      start(context: { stateDir: string; logger: { warn(message: string): void } }): Promise<void>;
      stop(): Promise<void>;
    };
    await service.start({ stateDir, logger: { warn: vi.fn() } });
    const tool = fake.tools
      .find(({ options }) => options.name === "omnesis_answer")!
      .factory({
        sessionKey: "agent:main:telegram:dm:fictional",
        deliveryContext: { channel: "telegram", to: "fictional-recipient", threadId: "thread-a" },
      } as never) as {
      execute(id: string, input: Record<string, unknown>): Promise<{ details: unknown }>;
    };

    await expect(
      tool.execute("tool-call", {
        question: "When is the fictional project review?",
        to: "attacker-controlled-recipient",
      }),
    ).resolves.toMatchObject({
      content: [
        {
          text: expect.stringContaining("you will reply in this conversation automatically"),
        },
      ],
      details: { ok: true },
    });
    expect(postJson).toHaveBeenNthCalledWith(
      1,
      "/mcp",
      expect.objectContaining({
        question: "When is the fictional project review?",
        clientRequestId: integrationAnswerRequestId({
          runGeneration: "agent:main:telegram:dm:fictional",
          askId: "tool-call",
          question: "When is the fictional project review?",
          workflowName: "OpenClaw conversation",
        }),
      }),
      undefined,
      { timeoutMs: openClawAnswerBudget({}).submitTimeoutMs },
    );
    // A conversation has someone present to decide, so it never forces a
    // settled outcome the way a scheduled run does.
    expect(postJson.mock.calls[0]?.[1]).not.toHaveProperty("approval");
    expect(postJson).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  /** A route store in a temp dir the suite's afterEach already drains. */
  function openRoutes(name: string): OpenClawCompletionRoutes {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-openclaw-routes-"));
    tempDirs.push(dir);
    const store = new OpenClawCompletionRoutes(join(dir, name));
    openedRouteStores.push(store);
    return store;
  }

  test("a session route resumes the run that asked, since a wake has no conversation", async () => {
    // The live failure: a firing answer was held for approval, the background
    // run that asked ended, the operator approved — and delivery threw,
    // because the completion looked for a channel to post into and a wake has
    // none. The only place the answer can go is a continuation of that run.
    const routes = openRoutes("routes.sqlite");
    routes.put({
      nativeConversationId: "native_fictional",
      taskId: "task_fictional",
      channel: SESSION_ROUTE_CHANNEL,
      to: "session-fictional",
    });
    const stored = routes.get("native_fictional");

    expect(stored, "the route was not filed").not.toBeNull();
    expect(isSessionRoute(stored!)).toBe(true);
    expect(stored!.to).toBe("session-fictional");
  });

  test("refuses to file a session route carrying channel addressing", async () => {
    // The two kinds share a column. Filing one under the other's name would
    // send an approved answer somewhere nobody asked from.
    const routes = openRoutes("routes-guard.sqlite");

    expect(() =>
      routes.put({
        nativeConversationId: "native_fictional",
        taskId: "task_fictional",
        channel: SESSION_ROUTE_CHANNEL,
        to: "session-fictional",
        threadId: "thread-a",
      }),
    ).toThrow(/carries no channel addressing/);
  });

  test("a conversation route is still not a session route", async () => {
    const routes = openRoutes("routes-conv.sqlite");
    routes.put({
      nativeConversationId: "native_conv",
      taskId: "task_fictional",
      channel: "telegram",
      to: "fictional-recipient",
    });

    expect(isSessionRoute(routes.get("native_conv")!)).toBe(false);
  });

  test("tells a resumed run that this is the answer it asked for", async () => {
    // The run has no memory of asking — it ended when the gateway said the
    // answer was held, and this is a fresh turn in the same session. Without
    // that framing the model reads an unexplained answer as a new instruction.
    const text = answerCompletionContinuation({
      workflowId: "wf_fictional",
      conversationId: "conv_fictional",
      taskId: "task_fictional",
      status: "released",
      releaseId: "release_fictional",
      answer: "The fictional shipment left on Tuesday.",
    } as never);

    expect(text).toContain("not a new request");
    expect(text).toContain("The fictional shipment left on Tuesday.");
  });

  test("delivers a terminal answer through the captured channel adapter without a model run", async () => {
    const fake = api("full");
    const sendText = vi.fn().mockResolvedValue({ messageId: "fictional-message" });
    fake.runtime.channel.outbound.loadAdapter.mockResolvedValue({ sendText });
    (fake as { config?: unknown }).config = { fictional: true };
    await sendAnswerCompletion(
      fake as never,
      {
        channel: "telegram",
        to: "fictional-recipient",
        accountId: "fictional-account",
        threadId: "thread-a",
      },
      {
        workflowId: "wf_fictional",
        conversationId: "conv_fictional",
        taskId: "task_fictional",
        status: "released",
        releaseId: "release_fictional",
        answer: "The fictional project review is at noon.",
      },
    );
    expect(sendText).toHaveBeenCalledWith({
      cfg: { fictional: true },
      to: "fictional-recipient",
      text: "The fictional project review is at noon.",
      accountId: "fictional-account",
      threadId: "thread-a",
    });
    expect(fake.runtime.subagent.run).not.toHaveBeenCalled();
  });
});

describe("OpenClaw transcript projection", () => {
  test("recognizes human conversations and excludes automation/background sessions", () => {
    expect(isConversationSession("agent:main:main", { sessionId: "local-era" })).toBe(true);
    for (const sessionKey of [
      "agent:main:direct:fictional-peer",
      "agent:main:telegram:direct:fictional-peer",
      "agent:main:telegram:account-a:direct:fictional-peer",
      "agent:main:telegram:dm:fictional-peer",
      "agent:main:discord:group:fictional-group",
      "agent:main:discord:channel:fictional-channel",
      "agent:main:discord:group:fictional-group:thread:fictional-thread",
    ]) {
      expect(isConversationSession(sessionKey, { sessionId: "channel-era" })).toBe(true);
    }
    expect(isConversationSession("agent:main:cron:fictional-job", {})).toBe(false);
    expect(isConversationSession("agent:main:subagent:omnesis-wf_fictional", {})).toBe(false);
    expect(isConversationSession("agent:main:run:fictional-background-run", {})).toBe(false);
    expect(
      isConversationSession("agent:main:telegram:direct:fictional-peer", {
        spawnedBy: "agent:main:main",
      }),
    ).toBe(false);
    expect(isConversationSession("agent:main:internal-task", { agentHarnessId: "codex" })).toBe(
      false,
    );
  });

  test("derives identities from every official peer session shape", () => {
    expect(identityFromSession("agent:main:main", {})).toEqual({
      channel: "local",
      chatId: "main",
    });
    expect(identityFromSession("agent:main:direct:Fictional-Peer", {})).toEqual({
      channel: "local",
      chatId: "fictional-peer",
    });
    expect(identityFromSession("agent:main:telegram:direct:Fictional-Peer", {})).toEqual({
      channel: "telegram",
      chatId: "fictional-peer",
    });
    expect(identityFromSession("agent:main:telegram:account-a:dm:Fictional-Peer", {})).toEqual({
      channel: "telegram",
      chatId: "fictional-peer",
    });
    expect(
      identityFromSession("agent:main:discord:group:Fictional-Group:thread:Fictional-Thread", {}),
    ).toEqual({
      channel: "discord",
      chatId: "fictional-group",
    });
    expect(
      identityFromSession("agent:main:discord:channel:Fictional-Channel", {
        lastChannel: "Slack",
        lastTo: "Runtime-Peer",
      }),
    ).toEqual({
      channel: "slack",
      chatId: "runtime-peer",
    });
  });

  test("uses the official identity reader and a durable event-prefix cursor", async () => {
    const events = [
      transcriptEvent(0, {
        content: "Please review the fictional launch plan.",
      }),
      transcriptEvent(1, {
        content: [{ type: "text", text: "I will review the fictional plan." }],
      }),
    ];
    const fake = api("full");
    fake.runtime.agent.session.listSessionEntries = () => [
      {
        sessionKey: "agent:main:telegram:direct:fictional-chat",
        entry: {
          sessionId: "fictional-era",
          // The identity-based runtime must not depend on this deprecated path.
          sessionFile: "/fictional/path/that/does/not/exist.jsonl",
          lastChannel: "telegram",
          lastTo: "fictional-chat",
        },
      },
      {
        sessionKey: "agent:main:subagent:omnesis-wf_fictional",
        entry: { sessionId: "background-era" },
      },
    ];
    const readTranscriptEvents = vi.fn(async () => events);
    const source = new OpenClawTranscriptSource(fake as never, readTranscriptEvents);

    const first = await source.readPage(null, new AbortController().signal);
    expect(first.messages).toEqual([
      expect.objectContaining({
        harness: "openclaw",
        channel: "telegram",
        chatId: "fictional-chat",
        role: "user",
        occurredAt: 1_800_000_000_000,
      }),
      expect.objectContaining({
        role: "assistant",
        occurredAt: 1_800_000_000_001,
      }),
    ]);
    expect(first.messages[0]?.id).toMatch(/^openclaw:[a-f0-9]{64}$/);
    expect(readTranscriptEvents).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:fictional-chat",
      sessionId: "fictional-era",
    });

    events.push(
      transcriptEvent(2, {
        content: "A second fictional update.",
        timestamp: 1_800_000_000_001,
      }),
    );
    const second = await source.readPage(first.nextCursor, new AbortController().signal);
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]).toMatchObject({
      text: "A second fictional update.",
      occurredAt: 1_800_000_000_001,
    });

    const third = await source.readPage(second.nextCursor, new AbortController().signal);
    expect(third.messages).toEqual([]);
  });

  test("treats a legacy or malformed cursor as empty instead of crashing", async () => {
    const fake = api("full");
    fake.runtime.agent.session.listSessionEntries = () => [
      {
        sessionKey: "agent:main:main",
        entry: { sessionId: "fictional-era" },
      },
    ];
    const source = new OpenClawTranscriptSource(fake as never, async () => [
      transcriptEvent(0, { content: "A fictional local conversation." }),
    ]);
    const page = await source.readPage(
      JSON.stringify({ "agent:main:main": { era: "fictional-era", seq: 42 } }),
      new AbortController().signal,
    );
    expect(page.messages).toHaveLength(1);
  });

  test("reads more than 1,000 events with no capped fallback", async () => {
    const events = Array.from({ length: 1_205 }, (_, index) => transcriptEvent(index));
    const fake = api("full");
    fake.runtime.agent.session.listSessionEntries = () => [
      {
        sessionKey: "agent:main:main",
        entry: { sessionId: "fictional-era" },
      },
    ];
    const readTranscriptEvents = vi.fn(async () => events);
    const source = new OpenClawTranscriptSource(fake as never, readTranscriptEvents);

    const first = await source.readPage(null, new AbortController().signal);
    expect(first.messages).toHaveLength(1_205);
    expect(first.messages.at(-1)?.text).toBe("Fictional transcript message 1204");
    expect(readTranscriptEvents).toHaveBeenCalledTimes(1);

    events.push(
      transcriptEvent(1_205, {
        content: "Fictional appended message",
      }),
    );
    const second = await source.readPage(first.nextCursor, new AbortController().signal);
    expect(second.messages).toMatchObject([
      { role: "assistant", text: "Fictional appended message" },
    ]);
  });

  test("replays safely when the runtime resets the same session identity", async () => {
    let events = Array.from({ length: 20 }, (_, index) =>
      transcriptEvent(index, {
        id: `pre-compaction-${index}`,
        content: `Pre-compaction message ${index}`,
      }),
    );
    const fake = api("full");
    fake.runtime.agent.session.listSessionEntries = () => [
      {
        sessionKey: "agent:main:main",
        entry: { sessionId: "fictional-era" },
      },
    ];
    const source = new OpenClawTranscriptSource(fake as never, async () => events);
    const first = await source.readPage(null, new AbortController().signal);
    expect(first.messages).toHaveLength(20);

    events = Array.from({ length: 40 }, (_, index) =>
      transcriptEvent(index, {
        id: `post-compaction-${index}`,
        timestamp: 1_700_000_000_000 + index,
        content: `Post-compaction replacement message ${index}`,
      }),
    );
    const replay = await source.readPage(first.nextCursor, new AbortController().signal);
    expect(replay.messages).toHaveLength(40);
    expect(replay.messages[0]?.text).toBe("Post-compaction replacement message 0");
    expect(await source.readPage(replay.nextCursor, new AbortController().signal)).toMatchObject({
      messages: [],
    });
  });

  test("isolates an unreadable session and retries it without losing its cursor", async () => {
    const sessionEvents = new Map<string, unknown[]>([
      ["agent:main:main", [transcriptEvent(0, { content: "Fictional local message" })]],
      [
        "agent:main:telegram:direct:fictional-chat",
        [transcriptEvent(1, { content: "Fictional channel message" })],
      ],
    ]);
    const fake = api("full");
    fake.runtime.agent.session.listSessionEntries = () => [
      {
        sessionKey: "agent:main:main",
        entry: { sessionId: "fictional-local-era" },
      },
      {
        sessionKey: "agent:main:telegram:direct:fictional-chat",
        entry: { sessionId: "fictional-channel-era" },
      },
    ];
    let broken = false;
    const source = new OpenClawTranscriptSource(fake as never, async ({ sessionKey }) => {
      if (broken && sessionKey.includes("telegram")) throw new Error("fictional read failure");
      return sessionEvents.get(sessionKey) ?? [];
    });
    const first = await source.readPage(null, new AbortController().signal);
    expect(first.messages).toHaveLength(2);

    broken = true;
    sessionEvents
      .get("agent:main:main")!
      .push(transcriptEvent(2, { content: "Fictional local follow-up" }));
    sessionEvents
      .get("agent:main:telegram:direct:fictional-chat")!
      .push(transcriptEvent(3, { content: "Fictional channel follow-up" }));
    const second = await source.readPage(first.nextCursor, new AbortController().signal);
    expect(second.messages).toMatchObject([{ text: "Fictional local follow-up" }]);
    expect(fake.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("fictional read failure"),
    );

    broken = false;
    const recovered = await source.readPage(second.nextCursor, new AbortController().signal);
    expect(recovered.messages).toMatchObject([{ text: "Fictional channel follow-up" }]);
  });

  test("counts non-message and malformed events in the durable runtime cursor", async () => {
    const events: unknown[] = [
      { type: "session", id: "fictional-session-header" },
      null,
      transcriptEvent(0),
    ];
    const fake = api("full");
    fake.runtime.agent.session.listSessionEntries = () => [
      { sessionKey: "agent:main:main", entry: { sessionId: "fictional-era" } },
    ];
    const source = new OpenClawTranscriptSource(fake as never, async () => events);
    const first = await source.readPage(null, new AbortController().signal);
    expect(first.messages).toHaveLength(1);
    expect(
      (JSON.parse(first.nextCursor) as Record<string, { eventCount: number }>)["agent:main:main"]
        ?.eventCount,
    ).toBe(3);
    expect(await source.readPage(first.nextCursor, new AbortController().signal)).toMatchObject({
      messages: [],
    });
  });
});

function wake(overrides: Partial<SubscriptionDelivery> = {}): SubscriptionDelivery {
  return {
    protocolVersion: AGENT_INTEGRATION_PROTOCOL_VERSION,
    deliveryId: "sdel_fictional",
    firingId: "sf_fictional",
    subscriptionId: "ssub_fictional",
    workflowHandle: "wf_fictional",
    reaction: { instruction: "Reply in the planning conversation." },
    answer: {
      token: "omn_fictional_firing",
      expiresAt: 1_900_000_000_000,
      endpoint: "/subscriptions/firings/sf_fictional/answer",
    },
    outcome: {
      token: "omn_fictional_outcome",
      expiresAt: 1_950_000_000_000,
      endpoint: "/subscriptions/firings/sf_fictional/outcome",
    },
    ...overrides,
  } as SubscriptionDelivery;
}

describe("what a woken run is told", () => {
  test("bindings arrive as the concrete referents the instruction names", () => {
    const prompt = backgroundPrompt(
      wake({
        reaction: {
          instruction: "Reply in the planning conversation and copy the coordinator.",
          bindings: {
            conversation: "channel-fictional-42",
            coordinator: "planning@example.org",
          },
        },
      }),
    );
    expect(prompt).toContain("- conversation: channel-fictional-42");
    expect(prompt).toContain("- coordinator: planning@example.org");
    expect(prompt).toContain("They are the real ones");
    // A wake without bindings gains no empty section to reason about.
    expect(backgroundPrompt(wake())).not.toContain("instruction above refers to these resources");
  });

  test("says plainly that closing text delivers nothing", () => {
    const prompt = backgroundPrompt(wake());
    expect(prompt).toContain("not delivered to anyone");
    expect(prompt).toContain("this run's account of what you did");
    expect(prompt).toContain("only if you make the tool call that causes it");
  });
});

/**
 * Boot the full-runtime service against a real inbox, and hand back the wake
 * starter the delivery client would have called.
 */
async function startedService(fake: ReturnType<typeof api>) {
  const stateDir = mkdtempSync(join(tmpdir(), "omnesis-openclaw-outcome-"));
  tempDirs.push(stateDir);
  mkdirSync(join(stateDir, "omnesis"));
  writeFileSync(
    join(stateDir, "omnesis", "integration.json"),
    `${JSON.stringify({
      gatewayUrl: "http://127.0.0.1:1",
      deliveryToken: "omn_fictional_delivery",
      ingestionToken: "omn_fictional_ingestion",
      managementToken: "omn_fictional_management",
      oauth: {
        redirectUri: "http://127.0.0.1:48123/callback",
        clientInformation: { client_id: "client_fictional" },
        tokens: {
          access_token: "omn_fictional_agent",
          refresh_token: "refresh_fictional",
          token_type: "Bearer",
        },
      },
    })}\n`,
  );
  let starter:
    | ((context: { delivery: SubscriptionDelivery; binding: null }) => Promise<unknown>)
    | null = null;
  vi.spyOn(AgentIntegrationClient.prototype, "start").mockImplementation(function (this: unknown) {
    // The starter is the delivery client's only way into the plugin, so a
    // test that drives a wake has to take the same entry point.
    starter = (
      this as {
        opts: {
          starter: (context: { delivery: SubscriptionDelivery; binding: null }) => Promise<unknown>;
        };
      }
    ).opts.starter;
  });
  vi.spyOn(DurableTranscriptIngestor.prototype, "start").mockImplementation(() => {});
  vi.spyOn(AgentIntegrationClient.prototype, "stop").mockResolvedValue();
  vi.spyOn(DurableTranscriptIngestor.prototype, "stop").mockResolvedValue();
  registerOpenClawIntegration(fake as never);
  const service = fake.services[0] as {
    start(context: { stateDir: string; logger: { warn(message: string): void } }): Promise<void>;
    stop(): Promise<void>;
  };
  await service.start({ stateDir, logger: fake.logger });
  return { service, starter: starter! };
}

describe("reporting what a woken run did", () => {
  test("a finished run posts its closing words as the workflow outcome", async () => {
    const postJson = vi.spyOn(PinnedGatewayHttpClient.prototype, "postJson").mockResolvedValue({});
    const fake = api("full");
    fake.runtime.subagent.getSessionMessages = vi.fn(async () => ({
      messages: [
        { role: "user", content: "Omnesis workflow wf_fictional received firing sf_fictional." },
        { role: "assistant", content: "Posted the update in the planning conversation." },
      ] as unknown[],
    }));
    const { service, starter } = await startedService(fake);

    await starter({ delivery: wake(), binding: null });
    await vi.waitFor(() => expect(postJson).toHaveBeenCalled());
    expect(postJson).toHaveBeenCalledWith("/subscriptions/firings/sf_fictional/outcome", {
      status: "completed",
      report: "Posted the update in the planning conversation.",
    });
    await service.stop();
  });

  test("a run the harness reports as broken is reported as failed", async () => {
    const postJson = vi.spyOn(PinnedGatewayHttpClient.prototype, "postJson").mockResolvedValue({});
    const fake = api("full");
    fake.runtime.subagent.waitForRun = vi.fn(async () => ({
      status: "error" as const,
      error: "the fictional mail tool was unavailable",
    }));
    const { service, starter } = await startedService(fake);

    await starter({ delivery: wake(), binding: null });
    await vi.waitFor(() => expect(postJson).toHaveBeenCalled());
    expect(postJson).toHaveBeenCalledWith("/subscriptions/firings/sf_fictional/outcome", {
      status: "failed",
      report: "the fictional mail tool was unavailable",
    });
    await service.stop();
  });

  test("a run that outlives the watch is not called finished", async () => {
    const postJson = vi.spyOn(PinnedGatewayHttpClient.prototype, "postJson").mockResolvedValue({});
    const fake = api("full");
    fake.runtime.subagent.waitForRun = vi.fn(async () => ({ status: "timeout" as const }));
    const { service, starter } = await startedService(fake);

    await starter({ delivery: wake(), binding: null });
    await vi.waitFor(() =>
      expect(fake.logger.warn).toHaveBeenCalledWith(expect.stringContaining("outlived")),
    );
    expect(postJson).not.toHaveBeenCalled();
    await service.stop();
  });

  test("a wake from a gateway that predates outcomes reports nothing", async () => {
    const postJson = vi.spyOn(PinnedGatewayHttpClient.prototype, "postJson").mockResolvedValue({});
    const fake = api("full");
    const { service, starter } = await startedService(fake);
    const { outcome: _outcome, ...legacy } = wake();

    await starter({
      delivery: {
        ...legacy,
        protocolVersion: AGENT_INTEGRATION_PROTOCOL_MIN_VERSION,
      } as SubscriptionDelivery,
      binding: null,
    });
    await vi.waitFor(() => expect(fake.runtime.subagent.waitForRun).toHaveBeenCalled());
    expect(postJson).not.toHaveBeenCalled();
    await service.stop();
  });

  test("a held answer leaves the run deferred rather than finished", async () => {
    const deferrals = vi.spyOn(DurableIntegrationInbox.prototype, "deferOutcome");
    vi.spyOn(DurableIntegrationInbox.prototype, "getFiringAuthority").mockReturnValue({
      deliveryId: "sdel_fictional",
      firingId: "sf_fictional",
      nativeSessionId: "agent:main:subagent:omnesis-wf_fictional",
      endpoint: "/subscriptions/firings/sf_fictional/answer",
      token: "omn_fictional_firing",
      expiresAt: 1_900_000_000_000,
    });
    const postJson = vi
      .spyOn(PinnedGatewayHttpClient.prototype, "postJson")
      .mockResolvedValue({ status: "approval_required", taskId: "task_fictional" });
    const fake = api("full");
    const { service } = await startedService(fake);
    const tool = fake.tools
      .find(({ options }) => options.name === "omnesis_subscription_answer")!
      .factory({ sessionKey: "agent:main:subagent:omnesis-wf_fictional" }) as {
      execute(id: string, input: Record<string, unknown>): Promise<unknown>;
    };

    const question = "What caused the fictional firing?";
    await tool.execute("call_fictional", { firingId: "sf_fictional", question });
    expect(postJson).toHaveBeenCalled();
    // Against the firing that asked, and against the answer that will end its
    // wait — never against the session, which every firing of this workflow
    // shares.
    expect(deferrals).toHaveBeenCalledWith(
      "sdel_fictional",
      firingAnswerConversationHandle({
        endpoint: "/subscriptions/firings/sf_fictional/answer",
        question,
      }),
    );
    await service.stop();
  });
});

describe("two firings of one workflow running at once", () => {
  /**
   * Hand-driven run ends, so two live firings can finish in a chosen order.
   *
   * The harness ends a run when it ends, not when the next one starts, and
   * every misattribution here comes from that overlap.
   */
  function scriptedRuns(fake: ReturnType<typeof api>) {
    type RunEnd = { status: "ok" | "error" | "timeout"; error?: string };
    const ends = new Map<string, (ended: RunEnd) => void>();
    let started = 0;
    fake.runtime.subagent.run = vi.fn(async () => ({ runId: `run-fictional-${(started += 1)}` }));
    fake.runtime.subagent.waitForRun = vi.fn(
      ({ runId }: { runId: string }) =>
        new Promise<RunEnd>((resolve) => {
          ends.set(runId, resolve);
        }),
    ) as never;
    return {
      async end(runId: string, ended: RunEnd) {
        await vi.waitFor(() => expect(ends.has(runId)).toBe(true));
        ends.get(runId)!(ended);
      },
    };
  }

  /** Two firings of one watch: same workflow, same session, different runs. */
  function firing(suffix: string): SubscriptionDelivery {
    return wake({
      deliveryId: `sdel_${suffix}`,
      firingId: `sf_${suffix}`,
      answer: {
        token: "omn_fictional_firing",
        expiresAt: 1_900_000_000_000,
        endpoint: `/subscriptions/firings/sf_${suffix}/answer`,
      },
      outcome: {
        token: "omn_fictional_outcome",
        expiresAt: 1_950_000_000_000,
        endpoint: `/subscriptions/firings/sf_${suffix}/outcome`,
      },
    });
  }

  test("each run reports against the firing that woke it", async () => {
    const postJson = vi.spyOn(PinnedGatewayHttpClient.prototype, "postJson").mockResolvedValue({});
    const fake = api("full");
    fake.runtime.subagent.getSessionMessages = vi.fn(async () => ({
      messages: [{ role: "assistant", content: "Filed the fictional summary." }] as unknown[],
    }));
    const runs = scriptedRuns(fake);
    const { service, starter } = await startedService(fake);

    await starter({ delivery: firing("first"), binding: null });
    await starter({ delivery: firing("second"), binding: null });
    // The first firing's run ends while its sibling is still working, which is
    // the ordinary case: a wake is not the end of the run before it.
    await runs.end("run-fictional-1", {
      status: "error",
      error: "the fictional mail tool was unavailable",
    });
    await vi.waitFor(() => expect(postJson).toHaveBeenCalledTimes(1));
    expect(postJson).toHaveBeenCalledWith("/subscriptions/firings/sf_first/outcome", {
      status: "failed",
      report: "the fictional mail tool was unavailable",
    });

    await runs.end("run-fictional-2", { status: "ok" });
    await vi.waitFor(() => expect(postJson).toHaveBeenCalledTimes(2));
    expect(postJson).toHaveBeenLastCalledWith("/subscriptions/firings/sf_second/outcome", {
      status: "completed",
      report: "Filed the fictional summary.",
    });
    await service.stop();
  });

  test("the run started first reports its own outcome when it ends last", async () => {
    const postJson = vi.spyOn(PinnedGatewayHttpClient.prototype, "postJson").mockResolvedValue({});
    const fake = api("full");
    const runs = scriptedRuns(fake);
    const { service, starter } = await startedService(fake);

    await starter({ delivery: firing("first"), binding: null });
    await starter({ delivery: firing("second"), binding: null });
    await runs.end("run-fictional-2", { status: "error", error: "second firing broke" });
    await vi.waitFor(() => expect(postJson).toHaveBeenCalledTimes(1));
    await runs.end("run-fictional-1", { status: "error", error: "first firing broke" });
    await vi.waitFor(() => expect(postJson).toHaveBeenCalledTimes(2));

    expect(postJson.mock.calls.map(([endpoint, body]) => [endpoint, body])).toEqual([
      [
        "/subscriptions/firings/sf_second/outcome",
        { status: "failed", report: "second firing broke" },
      ],
      [
        "/subscriptions/firings/sf_first/outcome",
        { status: "failed", report: "first firing broke" },
      ],
    ]);
    await service.stop();
  });

  test("one firing's held answer leaves its sibling's outcome settled", async () => {
    const postJson = vi
      .spyOn(PinnedGatewayHttpClient.prototype, "postJson")
      .mockImplementation(async (endpoint: string) =>
        endpoint.endsWith("/answer") ? { status: "approval_required", taskId: "task_held" } : {},
      );
    const fake = api("full");
    fake.runtime.subagent.getSessionMessages = vi.fn(async () => ({
      messages: [{ role: "assistant", content: "Filed the fictional summary." }] as unknown[],
    }));
    const runs = scriptedRuns(fake);
    const { service, starter } = await startedService(fake);
    await starter({ delivery: firing("waiting"), binding: null });
    await starter({ delivery: firing("working"), binding: null });

    // The first firing asks, and the gateway holds the answer for approval.
    // That run ends there; the sibling firing knows nothing about the wait.
    const tool = fake.tools
      .find(({ options }) => options.name === "omnesis_subscription_answer")!
      .factory({ sessionKey: "agent:main:subagent:omnesis-wf_fictional" }) as {
      execute(id: string, input: Record<string, unknown>): Promise<unknown>;
    };
    await tool.execute("call_waiting", {
      firingId: "sf_waiting",
      question: "What caused the fictional firing?",
    });
    await runs.end("run-fictional-1", { status: "ok" });
    await vi.waitFor(() =>
      expect(postJson).toHaveBeenCalledWith("/subscriptions/firings/sf_waiting/outcome", {
        status: "deferred",
        report: "Filed the fictional summary.",
      }),
    );

    await runs.end("run-fictional-2", { status: "ok" });
    await vi.waitFor(() =>
      expect(postJson).toHaveBeenCalledWith("/subscriptions/firings/sf_working/outcome", {
        status: "completed",
        report: "Filed the fictional summary.",
      }),
    );
    await service.stop();
  });
});

describe("an outcome the gateway did not take the first time", () => {
  test("is posted again, because a firing with no report reads as one that did nothing", async () => {
    const postJson = vi
      .spyOn(PinnedGatewayHttpClient.prototype, "postJson")
      .mockRejectedValueOnce(new Error("fictional connection reset"))
      .mockResolvedValue({});
    const fake = api("full");
    const { service, starter } = await startedService(fake);

    await starter({ delivery: wake(), binding: null });
    await vi.waitFor(() => expect(postJson).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    expect(postJson).toHaveBeenLastCalledWith("/subscriptions/firings/sf_fictional/outcome", {
      status: "completed",
    });
    await service.stop();
  });

  test("is not posted again when the gateway refused it", async () => {
    const postJson = vi
      .spyOn(PinnedGatewayHttpClient.prototype, "postJson")
      .mockRejectedValue(new IntegrationHttpError(404, "no such fictional firing"));
    const fake = api("full");
    const { service, starter } = await startedService(fake);

    await starter({ delivery: wake(), binding: null });
    await vi.waitFor(() =>
      expect(fake.logger.warn).toHaveBeenCalledWith(expect.stringContaining("went unreported")),
    );
    // A decision, not a blip: the same request produces the same refusal.
    expect(postJson).toHaveBeenCalledTimes(1);
    await service.stop();
  });
});

describe("shutting down while a run is still being watched", () => {
  test("stops waiting for a watch that could last half an hour, and silences it", async () => {
    const postJson = vi.spyOn(PinnedGatewayHttpClient.prototype, "postJson").mockResolvedValue({});
    const fake = api("full");
    let endRun: ((ended: { status: "ok" }) => void) | undefined;
    fake.runtime.subagent.waitForRun = vi.fn(
      () =>
        new Promise<{ status: "ok" }>((resolve) => {
          endRun = resolve;
        }),
    ) as never;
    const { service, starter } = await startedService(fake);
    await starter({ delivery: wake(), binding: null });
    await vi.waitFor(() => expect(fake.runtime.subagent.waitForRun).toHaveBeenCalled());

    vi.useFakeTimers();
    try {
      const stopping = service.stop();
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      await stopping;
    } finally {
      vi.useRealTimers();
    }

    // The harness wait cannot be cancelled, so the watcher wakes after the
    // service is gone. It touches nothing then: not the harness it would read
    // the run's closing words from, and not the gateway.
    endRun!({ status: "ok" });
    await new Promise((settle) => setTimeout(settle, 10));
    expect(fake.runtime.subagent.getSessionMessages).not.toHaveBeenCalled();
    expect(postJson).not.toHaveBeenCalled();
  });
});
