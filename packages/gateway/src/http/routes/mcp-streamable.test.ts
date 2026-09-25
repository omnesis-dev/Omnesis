// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildBuiltinTools, UnsupportedSearchFilterError } from "@omnesis/agent";
import { DirectMcpService, DIRECT_MCP_TOOL_NAMES } from "../../agent/direct-mcp.js";
import { recordMcpToolInvocationAudit } from "../../access/store.js";
import { runSchemaSetup } from "../../data/schema.js";
import {
  ANSWER_MCP_COMBINED_INSTRUCTIONS,
  ANSWER_MCP_INSTRUCTIONS,
} from "../../mcp/answer-server.js";
import { errorResponse, GatewayTimeoutError, HttpError } from "../errors.js";
import { strictRoute } from "../scope.js";
import { DirectMcpExecutionBoundary } from "../../mcp/direct-execution-boundary.js";
import { mountMcpStreamableRoutes } from "./mcp-streamable.js";
import type { Db } from "../../data/types.js";
import type { AppEnv, PrincipalOAuthAuthContext } from "./types.js";
import type { DeviceId, Scope, TokenId } from "@omnesis/types";
import type {
  AccessCapability,
  AccessGrantCapability,
  McpToolInvocationAuditInput,
} from "../../access/types.js";
import type { AnswerService } from "../../privacy/answer-service.js";
import type { AppendDirectAuditEventInput } from "../../privacy/store.js";
import type { CorpusAuthorization } from "../../access/corpus-authorization.js";
import type { ToolHandle } from "@omnesis/agent";

import type { OmnesisNotesRuntime, CaptureNoteInput } from "../../sources/omnesis-notes/index.js";

const notesToken = "notes-token";
const answerToken = "answer-token";
const directToken = "direct-token";
const restrictedDirectToken = "restricted-direct-token";
const unreviewedAnswerToken = "unreviewed-answer-token";
const bothToken = "both-token";
const noCapabilityToken = "no-capability-token";
const agentAnswerToken = "agent-answer-token";
const completionToken = "completion-token";
const mixedCompletionToken = "mixed-completion-token";
const readToken = "read-token";
const DEVICE_IDS: Record<string, DeviceId> = {
  [agentAnswerToken]: "22222222-2222-4222-8222-222222222222" as DeviceId,
  [completionToken]: "33333333-3333-4333-8333-333333333333" as DeviceId,
  [mixedCompletionToken]: "55555555-5555-4555-8555-555555555555" as DeviceId,
  [readToken]: "44444444-4444-4444-8444-444444444444" as DeviceId,
};

function capability(capabilityValue: AccessCapability): AccessGrantCapability {
  return {
    capability: capabilityValue,
    sourceMode: "all",
    sourceIds: [],
    releaseMode: capabilityValue === "answer" ? "reviewed" : null,
    policyFamilyId: capabilityValue === "answer" ? "00000000-0000-4000-8000-000000000001" : null,
    policyRevision: capabilityValue === "answer" ? "default-revision" : null,
    privacyPolicy: capabilityValue === "answer" ? "default" : null,
  };
}

function principalAuth(
  token: string,
  capabilities: AccessGrantCapability[],
  executionDeviceId: DeviceId | null = null,
): PrincipalOAuthAuthContext {
  return {
    authMethod: "principal-oauth",
    deviceId: null,
    tokenId: null,
    scopes: ["omnesis:access" as Scope],
    accessTokenId: `${token}-access`,
    principalId: `${token}-principal`,
    principalName: `${token} principal`,
    grantId: `${token}-grant`,
    grantRevision: 1,
    credentialId: `${token}-credential`,
    oauthClientId: `${token}-client`,
    executionDeviceId,
    capabilities,
    expiresAt: Date.now() + 60_000,
  };
}

const PRINCIPAL_AUTH: Record<string, PrincipalOAuthAuthContext> = {
  [notesToken]: principalAuth(notesToken, [capability("notes")]),
  [answerToken]: principalAuth(answerToken, [capability("answer")]),
  [directToken]: principalAuth(directToken, [capability("direct")]),
  [restrictedDirectToken]: principalAuth(restrictedDirectToken, [
    {
      capability: "direct",
      sourceMode: "allowlist",
      sourceIds: ["fictional-mail:alpha"],
      releaseMode: null,
      policyFamilyId: null,
      policyRevision: null,
      privacyPolicy: null,
    },
  ]),
  [unreviewedAnswerToken]: principalAuth(unreviewedAnswerToken, [
    {
      capability: "answer",
      sourceMode: "allowlist",
      sourceIds: ["fictional-mail:alpha"],
      releaseMode: "unreviewed",
      policyFamilyId: null,
      policyRevision: null,
      privacyPolicy: null,
    },
  ]),
  [bothToken]: principalAuth(bothToken, [capability("answer"), capability("direct")]),
  [noCapabilityToken]: principalAuth(noCapabilityToken, []),
  [agentAnswerToken]: principalAuth(
    agentAnswerToken,
    [capability("answer")],
    DEVICE_IDS[agentAnswerToken],
  ),
};

function service(
  scopedHandles?: (authorization: CorpusAuthorization) => readonly ToolHandle[],
): DirectMcpService {
  return new DirectMcpService(
    DIRECT_MCP_TOOL_NAMES.map((name) => ({
      name,
      description: `Canonical ${name}`,
      schema:
        name === "fetch_many"
          ? z.object({ documents: z.array(z.object({ documentId: z.string() })) }).strict()
          : z.object({ value: z.string().optional() }).strict(),
      invoke: async () => ({ kind: "structured", resultType: "test.result", data: { ok: true } }),
    })),
    () => Promise.resolve({}),
    scopedHandles,
  );
}

function appFixture(
  direct = service(),
  options: {
    answer?: () => Promise<unknown>;
    answerProfile?: unknown;
    answerAvailable?: boolean;
    recordMcpToolInvocation?: (input: McpToolInvocationAuditInput) => Promise<void>;
    recordDirectAuditEvent?: (input: AppendDirectAuditEventInput) => Promise<void>;
    isAgentIntegrationDevice?: (deviceId: DeviceId) => boolean;
    mcpResourceUrls?: readonly string[];
  } = {},
) {
  const app = strictRoute(new Hono<AppEnv>());
  app.onError((error, c) => {
    if (error instanceof HttpError) return errorResponse(c, error);
    throw error;
  });
  app.use("*", async (c, next) => {
    c.set("requestId", "mcp-http-test");
    const header = c.req.header("Authorization");
    const token = header?.replace(/^Bearer /, "");
    const principal = token ? PRINCIPAL_AUTH[token] : undefined;
    const scopes: Scope[] | undefined =
      token === completionToken
        ? (["answer:completion"] as Scope[])
        : token === mixedCompletionToken
          ? (["answer:completion", "answer"] as Scope[])
          : token === readToken
            ? (["read"] as Scope[])
            : undefined;
    if (principal || scopes || c.req.header("Cookie") === "portal=valid") {
      if (principal) {
        c.set("auth", principal);
      } else if (scopes) {
        c.set("auth", {
          authMethod: "bearer",
          deviceId: DEVICE_IDS[token!]!,
          tokenId: `${token}-id` as TokenId,
          scopes,
        });
      } else {
        c.set("auth", {
          authMethod: "portal-session",
          deviceId: null,
          tokenId: "portal-id" as TokenId,
          scopes: ["admin"] as Scope[],
          csrfToken: "a".repeat(64),
        });
      }
    }
    return next();
  });
  const answerResponse = {
    status: "released",
    workflowId: "wf-test",
    conversationId: "conv-test",
    taskId: "task-test",
    releaseId: "rel-test",
    answer: "Fictional released answer.",
  } as const;
  const answer = vi.fn(options.answer ?? (async () => answerResponse));
  const getCompletion = vi.fn(async () => answerResponse);
  const recordMcpToolInvocation = vi.fn(
    options.recordMcpToolInvocation ?? (async (_input: McpToolInvocationAuditInput) => {}),
  );
  const recordDirectAuditEvent = vi.fn(
    options.recordDirectAuditEvent ?? (async (_input: AppendDirectAuditEventInput) => {}),
  );
  const recordEgress = vi.fn(
    async (
      _taskId: string,
      _ownerId: string,
      _endpoint: string,
      mcpInvocationAudit?: McpToolInvocationAuditInput,
    ) => {
      // The production Answer store persists this attribution and the privacy
      // egress event in one writer transaction. Keep the route fixture at the
      // same seam so stale-authority tests exercise the real release boundary.
      if (mcpInvocationAudit) await recordMcpToolInvocation(mcpInvocationAudit);
      return {
        response: answerResponse,
        responseJson: JSON.stringify(answerResponse),
      };
    },
  );
  // Mirror the production boundary: a profile is served only when the call
  // opts in with `profiling: true`.
  const answerWithProfile = vi.fn(async (request: unknown) => ({
    response: await answer(),
    profile:
      (request as { profiling?: boolean } | null)?.profiling === true
        ? (options.answerProfile ?? null)
        : null,
  }));
  const answerService = {
    answer,
    answerWithProfile,
    getResponse: vi.fn(async () => answerResponse),
    getCompletion,
    recordEgress,
  } as unknown as AnswerService;
  const directBoundary = new DirectMcpExecutionBoundary(direct);
  const capture = vi.fn(async (input: CaptureNoteInput, audit?: McpToolInvocationAuditInput) => {
    if (audit) await recordMcpToolInvocation(audit);
    return {
      ...input,
      id: input.id ?? "note-id",
      day: "2026-07-14",
      capturedAt: "2026-07-14T12:00:00.000Z",
      receivedAt: "2026-07-14T12:00:01.000Z",
    };
  });
  const runtime = mountMcpStreamableRoutes(app, {
    notesRuntime: () => ({ capture }) as unknown as OmnesisNotesRuntime,
    directBoundary,
    answerDeps:
      options.answerAvailable === false
        ? { disabledReason: "Injected runtime unavailable." }
        : { answerService },
    isAgentIntegrationDevice:
      options.isAgentIntegrationDevice ?? ((deviceId) => deviceId === DEVICE_IDS[agentAnswerToken]),
    publicBaseUrl: "https://omnesis.test",
    mcpResourceUrls: options.mcpResourceUrls,
    recordMcpToolInvocation,
    recordDirectAuditEvent,
  });
  return {
    app,
    runtime,
    answer,
    answerWithProfile,
    getCompletion,
    recordEgress,
    recordMcpToolInvocation,
    recordDirectAuditEvent,
    capture,
  };
}

async function connect(
  app: Hono<AppEnv>,
  token: string,
  protocolVersion: "2026-07-28" | "2025-11-25" = "2026-07-28",
) {
  const transport = new StreamableHTTPClientTransport(new URL("https://omnesis.test/mcp"), {
    authProvider: { token: async () => token },
    onInsufficientScope: "throw",
    fetch: (input, init) => app.fetch(new Request(input, init)),
  });
  const client =
    protocolVersion === "2026-07-28"
      ? new Client(
          { name: "http-route-test", version: "1.0.0" },
          { versionNegotiation: { mode: { pin: protocolVersion } }, defaultCacheTtlMs: 0 },
        )
      : new Client(
          { name: "http-route-test", version: "1.0.0" },
          {
            supportedProtocolVersions: [protocolVersion],
            versionNegotiation: { mode: "legacy" },
            defaultCacheTtlMs: 0,
          },
        );
  try {
    await client.connect(transport);
    return { client, transport };
  } catch (error) {
    await Promise.allSettled([client.close(), transport.close()]);
    throw error;
  }
}

describe("gateway-hosted Streamable HTTP MCP", () => {
  const closeables: Array<{ close(): Promise<void> }> = [];
  let previousExperimental: string | undefined;

  beforeEach(() => {
    previousExperimental = process.env.OMNESIS_EXPERIMENTAL;
    process.env.OMNESIS_EXPERIMENTAL = "0";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(closeables.splice(0).map((value) => value.close()));
    if (previousExperimental === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
    else process.env.OMNESIS_EXPERIMENTAL = previousExperimental;
  });

  it("serves Answer with experimental mode disabled and preserves the released result", async () => {
    const { app, runtime, recordEgress, recordMcpToolInvocation } = appFixture();
    closeables.push(runtime);
    const { client, transport } = await connect(app, answerToken);
    closeables.push(client, transport);
    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getInstructions()).toBe(ANSWER_MCP_INSTRUCTIONS);
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["ask_omnesis", "get_answer_status"]);
    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "ask_omnesis",
          annotations: expect.objectContaining({
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          }),
        }),
        expect.objectContaining({
          name: "get_answer_status",
          annotations: expect.objectContaining({
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          }),
        }),
      ]),
    );
    const result = await client.callTool({
      name: "ask_omnesis",
      arguments: { question: "What is the fictional answer?", requestId: "request-http-test" },
    });
    expect(result.structuredContent).toMatchObject({
      status: "released",
      answer: "Fictional released answer.",
    });
    expect(recordMcpToolInvocation).toHaveBeenCalledWith({
      accessTokenId: `${answerToken}-access`,
      principalId: `${answerToken}-principal`,
      grantId: `${answerToken}-grant`,
      grantRevision: 1,
      credentialId: `${answerToken}-credential`,
      oauthClientId: `${answerToken}-client`,
      capability: "answer",
      tool: "ask_omnesis",
      outcome: "ok",
      requestId: "mcp-http-test",
      sourceMode: "all",
      requireActiveAuthority: true,
    });
    expect(recordEgress).toHaveBeenCalledWith(
      "task-test",
      expect.any(String),
      "/mcp",
      expect.objectContaining({
        accessTokenId: `${answerToken}-access`,
        capability: "answer",
        tool: "ask_omnesis",
        requireActiveAuthority: true,
      }),
      // An MCP caller's authority is its grant; no device authority rides along.
      undefined,
    );
  });

  it("returns the timing profile in _meta only when ask_omnesis opts in", async () => {
    const profile = { version: 1, totalWallMs: 7, note: "fictional profile" };
    const { app, runtime, answerWithProfile } = appFixture(service(), {
      answerProfile: profile,
    });
    closeables.push(runtime);
    const { client, transport } = await connect(app, answerToken);
    closeables.push(client, transport);
    const profiled = await client.callTool({
      name: "ask_omnesis",
      arguments: {
        question: "What is the fictional answer?",
        requestId: "request-http-profiled",
        profiling: true,
      },
    });
    expect(profiled.structuredContent).toMatchObject({ status: "released" });
    expect(answerWithProfile).toHaveBeenCalledWith(expect.objectContaining({ profiling: true }));
    expect(
      (profiled._meta as Record<string, unknown> | undefined)?.["dev.omnesis/profile"],
    ).toEqual(profile);

    const plain = await client.callTool({
      name: "ask_omnesis",
      arguments: { question: "What is the fictional answer?", requestId: "request-http-plain" },
    });
    expect(plain.structuredContent).toMatchObject({ status: "released" });
    expect(
      (plain._meta as Record<string, unknown> | undefined)?.["dev.omnesis/profile"],
    ).toBeUndefined();
  });

  it.each([
    [
      "Answer",
      answerToken,
      "ask_omnesis",
      { question: "What is the fictional answer?", requestId: "stale-answer-authority" },
    ],
    ["Direct", directToken, "run_sql", { value: "SELECT 1" }],
  ] as const)(
    "fails closed when %s authority changes before egress",
    async (_lane, token, tool, args) => {
      const recordMcpToolInvocation = vi.fn(async (input: McpToolInvocationAuditInput) => {
        if (input.requireActiveAuthority) throw new Error("Fictional stale authority.");
      });
      const { app, runtime } = appFixture(service(), { recordMcpToolInvocation });
      closeables.push(runtime);
      const { client, transport } = await connect(app, token);
      closeables.push(client, transport);

      const result = await client.callTool({ name: tool, arguments: args });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("Fictional released answer.");
      expect(JSON.stringify(result)).not.toContain('"ok":true');
      expect(recordMcpToolInvocation).toHaveBeenCalledWith(
        expect.objectContaining({ requireActiveAuthority: true }),
      );
    },
  );

  it("records a Direct transcript with grouping keys stripped from tool args", async () => {
    const { app, runtime, recordDirectAuditEvent } = appFixture();
    closeables.push(runtime);
    const { client, transport } = await connect(app, directToken);
    closeables.push(client, transport);

    const result = await client.callTool({
      name: "run_sql",
      arguments: { value: "SELECT 1", conversationId: "conv_fictional" },
    });

    expect(result.isError).toBeFalsy();
    expect(recordDirectAuditEvent).toHaveBeenCalledOnce();
    expect(recordDirectAuditEvent).toHaveBeenCalledWith({
      ownerId: `principal:${directToken}-principal`,
      principalId: `${directToken}-principal`,
      credentialId: `${directToken}-credential`,
      grantId: `${directToken}-grant`,
      conversationId: "conv_fictional",
      tool: "run_sql",
      outcome: "ok",
      requestId: "mcp-http-test",
      args: { value: "SELECT 1" },
      result: { kind: "structured", resultType: "test.result", data: { ok: true } },
      now: expect.any(Number),
    });
  });

  it("records refused Direct outcomes without failing the protocol envelope", async () => {
    const refusing = new DirectMcpService(
      DIRECT_MCP_TOOL_NAMES.map((name) => ({
        name,
        description: `Canonical ${name}`,
        schema:
          name === "fetch_many"
            ? z.object({ documents: z.array(z.object({ documentId: z.string() })) }).strict()
            : z.object({ value: z.string().optional() }).strict(),
        invoke: async () => ({
          kind: "error",
          code: "fictional_refusal",
          message: "Fictional refusal.",
        }),
      })),
      () => Promise.resolve({}),
    );
    const { app, runtime, recordDirectAuditEvent } = appFixture(refusing);
    closeables.push(runtime);
    const { client, transport } = await connect(app, directToken);
    closeables.push(client, transport);

    const result = await client.callTool({ name: "run_sql", arguments: { value: "SELECT 1" } });

    expect(JSON.stringify(result)).toContain("tool_failed");
    expect(recordDirectAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "run_sql", outcome: "refused" }),
    );
  });

  it("keeps serving Direct reads when the transcript writer is down", async () => {
    const { app, runtime, recordDirectAuditEvent } = appFixture(service(), {
      recordDirectAuditEvent: async () => {
        throw new Error("Fictional transcript outage.");
      },
    });
    closeables.push(runtime);
    const { client, transport } = await connect(app, directToken);
    closeables.push(client, transport);

    const result = await client.callTool({ name: "run_sql", arguments: { value: "SELECT 1" } });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result)).toContain('"ok":true');
    expect(recordDirectAuditEvent).toHaveBeenCalledOnce();
  });

  it("binds private native metadata only for an authenticated agent integration", async () => {
    const auditDb = new Database(":memory:") as unknown as Db;
    auditDb.pragma("foreign_keys = ON");
    runSchemaSetup(auditDb);
    const { app, runtime, answerWithProfile, recordMcpToolInvocation } = appFixture(service(), {
      recordMcpToolInvocation: async (input) => {
        recordMcpToolInvocationAudit(auditDb, input);
      },
    });
    closeables.push(runtime);
    const ordinary = await connect(app, answerToken);
    closeables.push(ordinary.client, ordinary.transport);
    const refused = await ordinary.client.callTool({
      name: "ask_omnesis",
      arguments: { question: "What is the fictional answer?", requestId: "ordinary-route" },
      _meta: { "dev.omnesis/nativeConversationId": "native_fictional" },
    });
    expect(refused.isError).toBe(true);
    expect(answerWithProfile).not.toHaveBeenCalled();
    expect(recordMcpToolInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "answer", outcome: "refused" }),
    );
    const refusedAudit = auditDb
      .prepare("SELECT detail FROM access_audit_events WHERE event_type = 'mcp-tool-invoked'")
      .get() as { detail: string };
    expect(JSON.parse(refusedAudit.detail)).toMatchObject({
      capability: "answer",
      tool: "ask_omnesis",
      outcome: "refused",
    });

    const integration = await connect(app, agentAnswerToken);
    closeables.push(integration.client, integration.transport);
    const released = await integration.client.callTool({
      name: "ask_omnesis",
      arguments: { question: "What is the fictional answer?", requestId: "native-route" },
      _meta: { "dev.omnesis/nativeConversationId": "native_fictional" },
    });
    expect(released.isError).not.toBe(true);
    expect(answerWithProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        completionRoute: {
          integrationDeviceId: DEVICE_IDS[agentAnswerToken],
          nativeConversationId: "native_fictional",
        },
      }),
    );
    auditDb.close();
  });

  it("refuses native completion routing after the operational device is revoked", async () => {
    const { app, runtime, answerWithProfile } = appFixture(service(), {
      isAgentIntegrationDevice: () => false,
    });
    closeables.push(runtime);
    const integration = await connect(app, agentAnswerToken);
    closeables.push(integration.client, integration.transport);
    const refused = await integration.client.callTool({
      name: "ask_omnesis",
      arguments: { question: "What is the fictional answer?", requestId: "revoked-route" },
      _meta: { "dev.omnesis/nativeConversationId": "native_fictional" },
    });
    expect(refused.isError).toBe(true);
    expect(answerWithProfile).not.toHaveBeenCalled();
  });

  it("rejects a one-task operational completion bearer at the principal-only MCP boundary", async () => {
    const { app, runtime, getCompletion, recordMcpToolInvocation } = appFixture();
    closeables.push(runtime);
    await expect(connect(app, completionToken)).rejects.toThrow();
    expect(getCompletion).not.toHaveBeenCalled();
    expect(recordMcpToolInvocation).not.toHaveBeenCalled();
  });

  it("rejects a completion credential combined with broader authority", async () => {
    const { app, runtime } = appFixture();
    closeables.push(runtime);
    await expect(connect(app, mixedCompletionToken)).rejects.toThrow();
  });

  it("serves Direct with experimental mode disabled", async () => {
    const { app, runtime, recordMcpToolInvocation } = appFixture();
    closeables.push(runtime);
    const { client, transport } = await connect(app, directToken);
    closeables.push(client, transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
      DIRECT_MCP_TOOL_NAMES,
    );
    const result = await client.callTool({ name: "run_sql", arguments: { value: "SELECT 1" } });
    expect(result.structuredContent).toMatchObject({ kind: "structured", data: { ok: true } });
    expect(recordMcpToolInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        principalId: `${directToken}-principal`,
        capability: "direct",
        tool: "run_sql",
        outcome: "ok",
        sourceMode: "all",
      }),
    );
  });

  it("advertises only the pre-filterable tool subset to a restricted Direct grant", async () => {
    const { app, runtime } = appFixture();
    closeables.push(runtime);
    const { client, transport } = await connect(app, restrictedDirectToken);
    closeables.push(client, transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "search_many",
      "fetch_many",
      "lookup_document_by_url",
      "run_sql",
    ]);
    expect(client.getInstructions()).toContain("restricted to selected source instances");
    expect(client.getInstructions()).toContain("sql_not_permitted");
  });

  it("tells a restricted Direct grant which filter its search refused", async () => {
    const scoped = buildBuiltinTools({
      experimental: false,
      ports: {
        search: {
          search: async () => {
            throw new UnsupportedSearchFilterError(
              ["by:maya"],
              "This grant is restricted to selected sources, and the by:maya filter is not " +
                "available to it. Remove it and search by text, source, type or date.",
            );
          },
        },
        document: { fetch: async () => null },
        documentByUrl: { lookup: async (url) => ({ url, durationMs: 0 }) },
      },
    });
    const { app, runtime } = appFixture(service(() => scoped));
    closeables.push(runtime);
    const { client, transport } = await connect(app, restrictedDirectToken);
    closeables.push(client, transport);
    const result = await client.callTool({
      name: "search_many",
      arguments: { queries: [{ query: "budget by:maya" }] },
    });
    expect(result.structuredContent).toMatchObject({
      kind: "search.batch",
      items: [
        {
          kind: "error",
          code: "unsupported_filter",
          message: expect.stringContaining("the by:maya filter is not available"),
        },
      ],
    });
  });

  it("binds even unreviewed Answer generation and durable ownership to its source scope", async () => {
    const { app, runtime, answerWithProfile } = appFixture();
    closeables.push(runtime);
    const { client, transport } = await connect(app, unreviewedAnswerToken);
    closeables.push(client, transport);
    const result = await client.callTool({
      name: "ask_omnesis",
      arguments: { question: "What is the fictional answer?", requestId: "scoped-answer" },
    });
    expect(result.isError).not.toBe(true);
    expect(answerWithProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: expect.stringContaining(
          "grant:unreviewed-answer-token-grant:credential:unreviewed-answer-token-credential:answer-scope:",
        ),
        corpusAuthorization: expect.objectContaining({
          sourceMode: "allowlist",
          sourceIds: ["fictional-mail:alpha"],
          releaseMode: "unreviewed",
        }),
      }),
    );
  });

  it("combines Answer and Direct tools when the principal grant has both capabilities", async () => {
    const { app, runtime } = appFixture();
    closeables.push(runtime);
    const { client, transport } = await connect(app, bothToken);
    closeables.push(client, transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "ask_omnesis",
      "get_answer_status",
      ...DIRECT_MCP_TOOL_NAMES,
    ]);
    expect(client.getInstructions()).toContain(ANSWER_MCP_COMBINED_INSTRUCTIONS);
    expect(client.getInstructions()).not.toContain("This server exposes no direct corpus");
    const answerResult = await client.callTool({
      name: "ask_omnesis",
      arguments: { question: "What is the fictional answer?", requestId: "both-answer" },
    });
    expect(answerResult.structuredContent).toMatchObject({ status: "released" });
    const directResult = await client.callTool({
      name: "run_sql",
      arguments: { value: "SELECT 1" },
    });
    expect(directResult.structuredContent).toMatchObject({
      kind: "structured",
      data: { ok: true },
    });
  });

  it("keeps Direct usable when a combined grant's Answer runtime is unavailable", async () => {
    const { app, runtime } = appFixture(service(), { answerAvailable: false });
    closeables.push(runtime);
    const { client, transport } = await connect(app, bothToken);
    closeables.push(client, transport);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
      DIRECT_MCP_TOOL_NAMES,
    );
    expect(client.getInstructions()).toContain(
      "Answer access is granted but currently unavailable on this gateway.",
    );
    await expect(
      client.callTool({ name: "run_sql", arguments: { value: "SELECT 1" } }),
    ).resolves.toMatchObject({ structuredContent: { data: { ok: true } } });
  });

  it("keeps Answer usable when a combined grant's Direct catalogue is unavailable", async () => {
    const direct = service();
    vi.spyOn(direct, "instructions").mockRejectedValue(
      new Error("fictional Direct catalogue failure"),
    );
    const { app, runtime } = appFixture(direct);
    closeables.push(runtime);
    const { client, transport } = await connect(app, bothToken);
    closeables.push(client, transport);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "ask_omnesis",
      "get_answer_status",
    ]);
    expect(client.getInstructions()).toContain(
      "Direct access is granted but currently unavailable on this gateway.",
    );
    await expect(
      client.callTool({
        name: "ask_omnesis",
        arguments: { question: "What is the fictional answer?", requestId: "partial-answer" },
      }),
    ).resolves.toMatchObject({ structuredContent: { status: "released" } });
  });

  it("keeps the MCP protocol available with an actionable empty catalogue when a granted runtime is unavailable", async () => {
    const { app, runtime } = appFixture(service(), { answerAvailable: false });
    closeables.push(runtime);
    const { client, transport } = await connect(app, answerToken);
    closeables.push(client, transport);

    expect((await client.listTools()).tools).toEqual([]);
    expect(client.getInstructions()).toContain(
      "Answer access is granted but currently unavailable on this gateway.",
    );
  });

  it("captures notes with trusted principal attribution without enabling corpus reads", async () => {
    const { app, runtime, capture, recordMcpToolInvocation } = appFixture();
    closeables.push(runtime);
    const { client, transport } = await connect(app, notesToken);
    closeables.push(client, transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["add_note"]);
    const result = await client.callTool({
      name: "add_note",
      arguments: {
        id: "10000000-0000-4000-8000-000000000001",
        text: "Remember the fictional garden plan.",
        capturedAt: "2026-07-14T12:00:00Z",
        capturedTimeZoneId: "Europe/London",
        capturedUtcOffsetSeconds: 3600,
        latitude: 51,
        longitude: 0,
        placeName: "Example garden",
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      id: expect.any(String),
      day: "2026-07-14",
      capturedAt: "2026-07-14T12:00:00.000Z",
      receivedAt: "2026-07-14T12:00:01.000Z",
    });
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "mcp",
        text: "Remember the fictional garden plan.",
        latitude: 51,
        longitude: 0,
        capturedTimeZoneId: "Europe/London",
        capturedUtcOffsetSeconds: 3600,
        captureContext: {
          principalId: "notes-token-principal",
          principalName: "notes-token principal",
          grantId: "notes-token-grant",
          grantRevision: 1,
          credentialId: "notes-token-credential",
          oauthClientId: "notes-token-client",
          requestId: "mcp-http-test",
        },
      }),
      expect.objectContaining({ capability: "notes", requireActiveAuthority: true }),
    );
    expect(recordMcpToolInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "notes", tool: "add_note", outcome: "ok" }),
    );
  });

  it("does not allow Answer or Direct access to add notes without a Notes grant", async () => {
    const { app, runtime, capture } = appFixture();
    closeables.push(runtime);
    const { client, transport } = await connect(app, bothToken);
    closeables.push(client, transport);
    await expect(
      client.callTool({ name: "add_note", arguments: { text: "Fictional note" } }),
    ).rejects.toThrow("not found");
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([
    { text: " " },
    { text: "x".repeat(8193) },
    { text: "Note", principalName: "Forged" },
    { text: "Note", surface: "portal" },
    { text: "Note", deviceId: "forged" },
    { text: "Note", capturedTimeZoneId: "Europe/London" },
    { text: "Note", latitude: 10 },
    { text: "Note", placeName: "Unknown" },
    { text: "Note", id: "not-a-uuid" },
  ])("rejects invalid or forged capture metadata %j", async (args) => {
    const { app, runtime, capture } = appFixture();
    closeables.push(runtime);
    const { client, transport } = await connect(app, notesToken);
    closeables.push(client, transport);
    const result = await client.callTool({ name: "add_note", arguments: args });
    expect(result.isError).toBe(true);
    expect(capture).not.toHaveBeenCalled();
  });

  it("rejects an OAuth principal whose grant has no MCP capability", async () => {
    const { app, runtime } = appFixture();
    closeables.push(runtime);
    await expect(connect(app, noCapabilityToken)).rejects.toThrow();
  });

  it("challenges non-OAuth access and rejects browser-origin and stateful access", async () => {
    const { app, runtime } = appFixture();
    closeables.push(runtime);

    const missingBearer = await app.request("https://omnesis.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(missingBearer.status).toBe(401);
    expect(missingBearer.headers.get("cache-control")).toBe("private, no-store");
    expect(missingBearer.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://omnesis.test/.well-known/oauth-protected-resource/mcp", scope="omnesis:access"',
    );

    const legacyDeviceBearer = await app.request("https://omnesis.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${readToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(legacyDeviceBearer.status).toBe(401);
    expect(legacyDeviceBearer.headers.get("www-authenticate")).toContain('scope="omnesis:access"');
    expect(legacyDeviceBearer.headers.get("www-authenticate")).toContain('error="invalid_token"');

    const browser = await app.request("https://omnesis.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${answerToken}`,
        Origin: "https://example.org",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(browser.status).toBe(403);
    expect(browser.headers.get("cache-control")).toBe("private, no-store");

    const cookieOnly = await app.request("https://omnesis.test/mcp", {
      method: "POST",
      headers: { Cookie: "portal=valid", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(cookieOnly.status).toBe(401);

    const invalidBearerWithCookie = await app.request("https://omnesis.test/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer invalid-token",
        Cookie: "portal=valid",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(invalidBearerWithCookie.status).toBe(401);

    const stateful = await app.request("https://omnesis.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${answerToken}`,
        "Content-Type": "application/json",
        "Mcp-Session-Id": "session-not-accepted",
      },
      body: "{}",
    });
    expect(stateful.status).toBe(400);

    const oversized = await app.request("https://omnesis.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${answerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ padding: "x".repeat(65 * 1024) }),
    });
    expect(oversized.status).toBe(413);

    const get = await app.request("https://omnesis.test/mcp", {
      headers: { Authorization: `Bearer ${answerToken}` },
    });
    expect(get.status).toBe(405);
    expect(get.headers.get("mcp-session-id")).toBeNull();
  });

  it("redirects common MCP path typos and explains retired capability URLs", async () => {
    const { app, runtime } = appFixture();
    closeables.push(runtime);

    for (const path of ["/mcp/", "/MCP"]) {
      const response = await app.request(`https://omnesis.test${path}`, {
        method: "POST",
        redirect: "manual",
      });
      expect(response.status).toBe(308);
      expect(response.headers.get("location")).toBe("https://omnesis.test/mcp");
    }
    for (const path of ["/mcp/answer", "/mcp/direct"]) {
      const response = await app.request(`https://omnesis.test${path}`, { method: "POST" });
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({
        replacement: "https://omnesis.test/mcp",
      });
    }
  });

  it("challenges each configured transport with its exact protected-resource metadata", async () => {
    const privateResource = "https://private.example.net:7600/mcp";
    const { app, runtime } = appFixture(service(), { mcpResourceUrls: [privateResource] });
    closeables.push(runtime);

    const response = await app.request(privateResource, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://private.example.net:7600/.well-known/oauth-protected-resource/mcp", scope="omnesis:access"',
    );

    const unknown = await app.request("https://unknown.example.net/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(unknown.status).toBe(404);
  });

  it("serves the advertised 2025 Streamable HTTP transport path", async () => {
    const { app, runtime } = appFixture();
    closeables.push(runtime);
    const { client, transport } = await connect(app, answerToken, "2025-11-25");
    closeables.push(client, transport);
    expect(client.getProtocolEra()).toBe("legacy");
    expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "ask_omnesis",
      "get_answer_status",
    ]);
  });

  it.each([
    [new GatewayTimeoutError("Fictional timeout."), "timed_out"],
    [new Error("Fictional internal failure."), "failed"],
  ] as const)("classifies Answer boundary failures durably as %s", async (error, outcome) => {
    const auditDb = new Database(":memory:") as unknown as Db;
    auditDb.pragma("foreign_keys = ON");
    runSchemaSetup(auditDb);
    const { app, runtime } = appFixture(service(), {
      answer: async () => {
        throw error;
      },
      recordMcpToolInvocation: async (input) => {
        recordMcpToolInvocationAudit(auditDb, input);
      },
    });
    closeables.push(runtime);
    const { client, transport } = await connect(app, answerToken);
    closeables.push(client, transport);
    const result = await client.callTool({
      name: "ask_omnesis",
      arguments: { question: "What is the fictional answer?", requestId: `audit-${outcome}` },
    });
    expect(result.isError).toBe(true);
    const rows = auditDb
      .prepare("SELECT detail FROM access_audit_events WHERE event_type = 'mcp-tool-invoked'")
      .all() as Array<{ detail: string }>;
    expect(rows.map((row) => JSON.parse(row.detail))).toEqual([
      expect.objectContaining({ capability: "answer", tool: "ask_omnesis", outcome }),
    ]);
    auditDb.close();
  });

  it("durably classifies a disconnected Answer invocation as cancelled", async () => {
    const auditDb = new Database(":memory:") as unknown as Db;
    auditDb.pragma("foreign_keys = ON");
    runSchemaSetup(auditDb);
    const { app, runtime } = appFixture(service(), {
      answer: () =>
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("Fictional work stopped after disconnect.")), 25);
        }),
      recordMcpToolInvocation: async (input) => {
        recordMcpToolInvocationAudit(auditDb, input);
      },
    });
    closeables.push(runtime);
    const { client, transport } = await connect(app, answerToken);
    closeables.push(client, transport);
    const abort = new AbortController();
    const invocation = client.callTool(
      {
        name: "ask_omnesis",
        arguments: { question: "What is the fictional answer?", requestId: "audit-cancelled" },
      },
      { signal: abort.signal },
    );
    setTimeout(() => abort.abort(), 5);
    await expect(invocation).rejects.toBeDefined();

    const deadline = Date.now() + 1_000;
    let detail: Record<string, unknown> | null = null;
    while (!detail && Date.now() < deadline) {
      const row = auditDb
        .prepare("SELECT detail FROM access_audit_events WHERE event_type = 'mcp-tool-invoked'")
        .get() as { detail: string } | undefined;
      if (row) detail = JSON.parse(row.detail) as Record<string, unknown>;
      else await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(detail).toMatchObject({
      capability: "answer",
      tool: "ask_omnesis",
      outcome: "cancelled",
    });
    auditDb.close();
  });

  it("classifies a late successful settlement as cancelled after disconnect", async () => {
    const auditDb = new Database(":memory:") as unknown as Db;
    auditDb.pragma("foreign_keys = ON");
    runSchemaSetup(auditDb);
    const response = {
      status: "released",
      workflowId: "wf-late",
      conversationId: "conv-late",
      taskId: "task-late",
      releaseId: "rel-late",
      answer: "Fictional late answer.",
    } as const;
    const { app, runtime } = appFixture(service(), {
      answer: () => new Promise((resolve) => setTimeout(() => resolve(response), 25)),
      recordMcpToolInvocation: async (input) => {
        recordMcpToolInvocationAudit(auditDb, input);
      },
    });
    closeables.push(runtime);
    const { client, transport } = await connect(app, answerToken);
    closeables.push(client, transport);
    const abort = new AbortController();
    const invocation = client.callTool(
      {
        name: "ask_omnesis",
        arguments: { question: "What is the fictional answer?", requestId: "audit-late-cancel" },
      },
      { signal: abort.signal },
    );
    setTimeout(() => abort.abort(), 5);
    await expect(invocation).rejects.toBeDefined();

    const deadline = Date.now() + 1_000;
    let detail: Record<string, unknown> | null = null;
    while (!detail && Date.now() < deadline) {
      const row = auditDb
        .prepare("SELECT detail FROM access_audit_events WHERE event_type = 'mcp-tool-invoked'")
        .get() as { detail: string } | undefined;
      if (row) detail = JSON.parse(row.detail) as Record<string, unknown>;
      else await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(detail).toMatchObject({ outcome: "cancelled", tool: "ask_omnesis" });
    auditDb.close();
  });

  it("isolates Direct rate budgets by credential rather than shared proxy address", async () => {
    process.env.OMNESIS_EXPERIMENTAL = "1";
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { app, runtime } = appFixture();
    closeables.push(runtime);
    const { client, transport } = await connect(app, directToken);
    closeables.push(client, transport);
    for (let index = 0; index < 120; index += 1) {
      const result = await client.callTool({
        name: "run_sql",
        arguments: { value: `SELECT ${index}` },
      });
      expect(result.isError).not.toBe(true);
    }
    const exhausted = await client.callTool({
      name: "run_sql",
      arguments: { value: "SELECT 121" },
    });
    expect(exhausted.isError).toBe(true);
    const sibling = await connect(app, bothToken);
    closeables.push(sibling.client, sibling.transport);
    const independent = await sibling.client.callTool({
      name: "run_sql",
      arguments: { value: "SELECT 1" },
    });
    expect(independent.isError).not.toBe(true);
  });

  it("refreshes the bounded Direct instruction snapshot after its short TTL", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const direct = service();
    vi.spyOn(direct, "instructions")
      .mockResolvedValueOnce("First fictional catalogue.")
      .mockResolvedValueOnce("Second fictional catalogue.");
    const { app, runtime } = appFixture(direct);
    closeables.push(runtime);

    const first = await connect(app, directToken);
    expect(first.client.getInstructions()).toContain("First fictional catalogue.");
    await first.client.close();
    await first.transport.close();

    now += 5_001;
    const second = await connect(app, directToken);
    closeables.push(second.client, second.transport);
    expect(second.client.getInstructions()).toContain("Second fictional catalogue.");
  });

  it("retries Direct instruction loading after a transient catalogue failure", async () => {
    const direct = service();
    vi.spyOn(direct, "instructions")
      .mockRejectedValueOnce(new Error("fictional transient catalogue failure"))
      .mockResolvedValueOnce("Recovered fictional catalogue.");
    const { app, runtime } = appFixture(direct);
    closeables.push(runtime);

    const unavailable = await connect(app, directToken);
    expect((await unavailable.client.listTools()).tools.map((tool) => tool.name)).toEqual(
      DIRECT_MCP_TOOL_NAMES,
    );
    expect(unavailable.client.getInstructions()).toContain(
      "Direct access is granted but currently unavailable on this gateway.",
    );
    await unavailable.client.close();
    await unavailable.transport.close();
    const recovered = await connect(app, directToken);
    closeables.push(recovered.client, recovered.transport);
    expect(recovered.client.getInstructions()).toContain("Recovered fictional catalogue.");
  });
});
