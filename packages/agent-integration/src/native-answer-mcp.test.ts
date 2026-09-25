// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod/v4";

import { integrationAnswerRequestId } from "./answer-wait.js";
import { IntegrationHttpError } from "./http.js";
import { IntegrationOAuthProvider, SerializedIntegrationAuthProvider } from "./oauth.js";
import {
  ANSWER_ERROR_META_KEY,
  integrationOAuthFetch,
  NATIVE_CONVERSATION_META_KEY,
  NativeAnswerMcpClient,
} from "./native-answer-mcp.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

async function gateway(
  capture: Array<{ name: string; args: unknown; meta: unknown }>,
  errorMeta?: unknown,
  completionOnly = false,
  beforeRequest?: () => Promise<void>,
): Promise<string> {
  const handler = createMcpHandler(
    async () => {
      const server = new McpServer(
        { name: "fictional-answer", version: "1.0.0" },
        { supportedProtocolVersions: ["2026-07-28"] },
      );
      if (!completionOnly)
        server.registerTool(
          "ask_omnesis",
          {
            inputSchema: z.object({ question: z.string(), requestId: z.string() }).passthrough(),
          },
          async (args, context) => {
            capture.push({ name: "ask_omnesis", args, meta: context.mcpReq._meta });
            if (errorMeta !== undefined) {
              return {
                isError: true,
                _meta: { [ANSWER_ERROR_META_KEY]: errorMeta },
                content: [
                  {
                    type: "text",
                    text: "Injected prose must-not-control-classification.",
                  },
                ],
              };
            }
            const response = {
              status: "released" as const,
              workflowId: "wf_fictional",
              conversationId: "conv_fictional",
              taskId: "task_fictional",
              releaseId: "release_fictional",
              answer: "A fictional answer.",
            };
            return {
              content: [{ type: "text", text: response.answer }],
              structuredContent: response,
            };
          },
        );
      server.registerTool(
        "get_answer_status",
        {
          inputSchema: z.object({ taskId: z.string() }).strict(),
        },
        async (args, context) => {
          capture.push({ name: "get_answer_status", args, meta: context.mcpReq._meta });
          const response = {
            status: "released" as const,
            workflowId: "wf_fictional",
            conversationId: "conv_fictional",
            taskId: args.taskId,
            releaseId: "release_fictional",
            answer: "A fictional approved answer.",
          };
          return {
            content: [{ type: "text", text: response.answer }],
            structuredContent: response,
          };
        },
      );
      return server;
    },
    { legacy: "reject", responseMode: "json", maxSubscriptions: 0 },
  );
  const server = createServer(async (request, response) => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fictional server not listening");
    await beforeRequest?.();
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const result = await handler.fetch(
      new Request(`http://127.0.0.1:${address.port}${request.url}`, {
        method: request.method,
        headers: request.headers as Record<string, string>,
        body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
      }),
    );
    response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fictional server did not listen");
  return `http://127.0.0.1:${address.port}`;
}

describe("native Answer MCP client", () => {
  test("closing during initial connection cannot publish a live transport afterward", async () => {
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let releaseResolve!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const gatewayUrl = await gateway([], undefined, true, async () => {
      enteredResolve();
      await release;
    });
    const client = new NativeAnswerMcpClient(gatewayUrl, "omn_fictional_completion");
    const invocation = client.getTask("task_fictional");
    await entered;
    const closing = client.close();
    await expect(
      Promise.race([
        closing.then(() => "closed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 500)),
      ]),
    ).resolves.toBe("closed");
    await expect(invocation).rejects.toThrow(/closed/);
    await expect(client.getTask("task_fictional")).rejects.toThrow(/closed/);
    releaseResolve();
  });

  test("coalesces delayed stale 401s through the official MCP transport", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omnesis-native-mcp-refresh-"));
    try {
      const credentialsPath = join(directory, "integration.json");
      writeFileSync(
        credentialsPath,
        JSON.stringify({
          gatewayUrl: "http://127.0.0.1:7600",
          deliveryToken: "omn_delivery_example",
          ingestionToken: "omn_ingestion_example",
          managementToken: "omn_management_example",
          oauth: {
            redirectUri: "http://127.0.0.1:48123/callback",
            clientInformation: { client_id: "client_fictional" },
            tokens: {
              access_token: "principal-access-old",
              refresh_token: "principal-refresh-old",
              token_type: "Bearer",
            },
          },
        }),
        { mode: 0o600 },
      );
      const handler = createMcpHandler(
        async () => {
          const server = new McpServer(
            { name: "fictional-refresh", version: "1.0.0" },
            { supportedProtocolVersions: ["2026-07-28"] },
          );
          server.registerTool(
            "get_answer_status",
            { inputSchema: z.object({ taskId: z.string() }).strict() },
            async ({ taskId }) => {
              const response = {
                status: "released" as const,
                workflowId: "wf_fictional",
                conversationId: "conv_fictional",
                taskId,
                releaseId: "release_fictional",
                answer: "A fictional approved answer.",
              };
              return {
                content: [{ type: "text", text: response.answer }],
                structuredContent: response,
              };
            },
          );
          return server;
        },
        { legacy: "reject", responseMode: "json", maxSubscriptions: 0 },
      );
      let staleCalls = 0;
      let bothStaleResolve!: () => void;
      const bothStale = new Promise<void>((resolve) => {
        bothStaleResolve = resolve;
      });
      let rotatedResolve!: () => void;
      const rotated = new Promise<void>((resolve) => {
        rotatedResolve = resolve;
      });
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const message = body.length > 0 ? (JSON.parse(body.toString("utf8")) as unknown) : null;
        const isToolCall =
          message !== null &&
          typeof message === "object" &&
          "method" in message &&
          message.method === "tools/call";
        const bearer = request.headers.authorization;
        if (isToolCall && bearer === ["Bearer", "principal-access-old"].join(" ")) {
          staleCalls += 1;
          const position = staleCalls;
          if (staleCalls === 2) bothStaleResolve();
          await bothStale;
          if (position === 2) await rotated;
          response.writeHead(401, {
            "www-authenticate": 'Bearer error="invalid_token"',
            "content-type": "application/json",
          });
          response.end('{"error":"invalid_token"}');
          return;
        }
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("refresh server not listening");
        const result = await handler.fetch(
          new Request(`http://127.0.0.1:${address.port}${request.url}`, {
            method: request.method,
            headers: request.headers as Record<string, string>,
            body: body.length > 0 ? body : undefined,
          }),
        );
        response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
        response.end(Buffer.from(await result.arrayBuffer()));
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("refresh server did not listen");
      const gatewayUrl = `http://127.0.0.1:${address.port}`;
      const provider = new IntegrationOAuthProvider(credentialsPath, "OpenClaw");
      let refreshCalls = 0;
      const serialized = new SerializedIntegrationAuthProvider(
        provider,
        gatewayUrl,
        async (current) => {
          refreshCalls += 1;
          current.saveTokens({
            access_token: "principal-access-rotated",
            refresh_token: "principal-refresh-rotated",
            token_type: "Bearer",
          });
          rotatedResolve();
          return "AUTHORIZED";
        },
      );
      const client = new NativeAnswerMcpClient(gatewayUrl, serialized);
      try {
        const results = await Promise.all([
          client.getTask("task_first"),
          client.getTask("task_second"),
        ]);
        expect(results.map((result) => result.taskId).sort()).toEqual([
          "task_first",
          "task_second",
        ]);
        expect(staleCalls).toBe(2);
        expect(refreshCalls).toBe(1);
      } finally {
        await client.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("pins the portal-code status and completion requests to the gateway", async () => {
    const seen: string[] = [];
    const server = createServer((request, response) => {
      seen.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"pending"}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fictional server did not listen");
    const gatewayUrl = `http://127.0.0.1:${address.port}`;
    const fetchFn = integrationOAuthFetch(gatewayUrl);

    await expect(
      fetchFn(new URL("/oauth/authorize/status?request=fictional", gatewayUrl)),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      fetchFn(new URL("/oauth/authorize/complete?request=fictional", gatewayUrl)),
    ).resolves.toMatchObject({ status: 200 });
    await expect(fetchFn(new URL("/admin/status", gatewayUrl))).rejects.toThrow(
      /left its pinned gateway endpoint/,
    );
    expect(seen).toEqual([
      "/oauth/authorize/status?request=fictional",
      "/oauth/authorize/complete?request=fictional",
    ]);
  });

  test("bounds an OAuth endpoint that accepts a request but never responds", async () => {
    const server = createServer(() => {});
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fictional server did not listen");
    const fetchFn = integrationOAuthFetch(`http://127.0.0.1:${address.port}`, undefined, 25);

    await expect(fetchFn(`http://127.0.0.1:${address.port}/oauth/token`)).rejects.toBeInstanceOf(
      Error,
    );
  });

  test("preserves a gateway path prefix for the MCP endpoint", async () => {
    const seen: string[] = [];
    const server = createServer((request, response) => {
      seen.push(request.url ?? "");
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":"unauthorized"}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fictional server did not listen");
    const client = new NativeAnswerMcpClient(
      `http://127.0.0.1:${address.port}/omnesis`,
      "omn_fictional",
    );
    try {
      await expect(client.getTask("task_fictional")).rejects.toThrow();
    } finally {
      await client.close();
    }
    expect(seen).toContain("/omnesis/mcp");
  });

  test("permits WebPKI OAuth requests without allowing arbitrary cross-origin paths", async () => {
    const seen: string[] = [];
    const authorizationServer = createServer((request, response) => {
      seen.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"issuer":"fictional"}');
    });
    servers.push(authorizationServer);
    await new Promise<void>((resolve) => authorizationServer.listen(0, "127.0.0.1", resolve));
    const address = authorizationServer.address();
    if (!address || typeof address === "string") {
      throw new Error("fictional authorization server did not listen");
    }
    const gatewayUrl = "http://127.0.0.1:17699";
    const authorizationOrigin = `http://127.0.0.1:${address.port}`;
    const fetchFn = integrationOAuthFetch(gatewayUrl);

    await expect(
      fetchFn(`${authorizationOrigin}/.well-known/oauth-authorization-server`),
    ).resolves.toMatchObject({ status: 200 });
    await expect(fetchFn(`${authorizationOrigin}/oauth/token`)).resolves.toMatchObject({
      status: 200,
    });
    await expect(fetchFn(`${authorizationOrigin}/admin/status`)).rejects.toThrow(
      /left its pinned gateway endpoint/,
    );
    expect(seen).toEqual(["/.well-known/oauth-authorization-server", "/oauth/token"]);
  });

  test("retrieves with a completion-only credential", async () => {
    const calls: Array<{ name: string; args: unknown; meta: unknown }> = [];
    const client = new NativeAnswerMcpClient(
      await gateway(calls, undefined, true),
      "omn_fictional_completion",
    );
    try {
      await expect(client.getTask("task_fictional")).resolves.toMatchObject({
        status: "released",
        taskId: "task_fictional",
      });
    } finally {
      await client.close();
    }
    expect(calls.map((call) => call.name)).toEqual(["get_answer_status"]);
  });

  test("does not follow a gateway redirect with its bearer credential", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(307, { location: "http://example.org/credential-capture" });
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fictional server did not listen");
    const client = new NativeAnswerMcpClient(`http://127.0.0.1:${address.port}`, "omn_fictional");
    try {
      await expect(
        client.postJson("/mcp", {
          question: "A fictional question?",
          clientRequestId: "request_redirect",
        }),
      ).rejects.toBeDefined();
    } finally {
      await client.close();
    }
  });

  test("calls the canonical tools and keeps the trusted route out of tool arguments", async () => {
    const calls: Array<{ name: string; args: unknown; meta: unknown }> = [];
    const gatewayUrl = await gateway(calls);
    const request = {
      runGeneration: "agent:main:fictional",
      askId: "tool-fictional",
      question: "What is the fictional answer?",
      workflowName: "OpenClaw conversation",
    };
    const client = new NativeAnswerMcpClient(
      gatewayUrl,
      "omn_fictional",
      undefined,
      "native_fictional",
    );
    try {
      await expect(
        client.postJson("/mcp", {
          question: request.question,
          clientRequestId: integrationAnswerRequestId(request),
          workflowName: request.workflowName,
        }),
      ).resolves.toMatchObject({ status: "released", answer: "A fictional answer." });
      await expect(client.getTask("task_fictional")).resolves.toMatchObject({
        status: "released",
        answer: "A fictional approved answer.",
      });
    } finally {
      await client.close();
    }

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      name: "ask_omnesis",
      args: { question: request.question, requestId: integrationAnswerRequestId(request) },
      meta: { [NATIVE_CONVERSATION_META_KEY]: "native_fictional" },
    });
    expect(JSON.stringify(calls[0]!.args)).not.toContain("native_fictional");
    expect(calls[1]).toMatchObject({
      name: "get_answer_status",
      args: { taskId: "task_fictional" },
    });
    expect(calls[1]!.meta ?? {}).not.toHaveProperty(NATIVE_CONVERSATION_META_KEY);
  });

  test("maps only the fixed in-progress tool error into the retry contract", async () => {
    const gatewayUrl = await gateway([], {
      status: 409,
      code: "ANSWER_IN_PROGRESS",
      taskId: "task_fictional",
    });
    const client = new NativeAnswerMcpClient(gatewayUrl, "omn_fictional");
    try {
      const error = await client
        .postJson("/mcp", {
          question: "A fictional question?",
          clientRequestId: "request_fictional",
        })
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(IntegrationHttpError);
      expect(error).toMatchObject({ status: 409, code: "ANSWER_IN_PROGRESS" });
    } finally {
      await client.close();
    }
  });

  test.each([
    [{ status: 401, code: "UNAUTHORIZED" }, 401],
    [{ status: 403, code: "FORBIDDEN" }, 403],
    [{ status: 409, code: "CONFLICT" }, 409],
    [{ status: 429, code: "ANSWER_EGRESS_LIMIT" }, 429],
  ] as const)(
    "classifies fixed credential metadata without reading tool prose",
    async (meta, status) => {
      const client = new NativeAnswerMcpClient(await gateway([], meta), "omn_fictional");
      try {
        const error = await client
          .postJson("/mcp", {
            question: "A fictional question?",
            clientRequestId: "request_fictional",
          })
          .catch((cause: unknown) => cause);
        expect(error).toMatchObject({ status, code: meta.code });
      } finally {
        await client.close();
      }
    },
  );

  test("fails closed on malformed error metadata and malicious prose", async () => {
    const client = new NativeAnswerMcpClient(
      await gateway([], {
        status: 409,
        code: "ANSWER_IN_PROGRESS",
        taskId: "../private",
        injected: "must-not-leave",
      }),
      "omn_fictional",
    );
    try {
      const error = await client
        .postJson("/mcp", {
          question: "A fictional question?",
          clientRequestId: "request_fictional",
        })
        .catch((cause: unknown) => cause);
      expect(error).toMatchObject({ status: 500, code: undefined });
      expect(JSON.stringify(error)).not.toContain("must-not-leave");
    } finally {
      await client.close();
    }
  });

  test("fails closed on a well-formed but unknown error code", async () => {
    const client = new NativeAnswerMcpClient(
      await gateway([], { status: 409, code: "DELETE_PRIVATE_DATA" }),
      "omn_fictional",
    );
    try {
      const error = await client
        .postJson("/mcp", {
          question: "A fictional question?",
          clientRequestId: "request_unknown_error",
        })
        .catch((cause: unknown) => cause);
      expect(error).toMatchObject({ status: 500, code: undefined });
    } finally {
      await client.close();
    }
  });

  test("shares one concurrent connection and preserves both calls", async () => {
    const calls: Array<{ name: string; args: unknown; meta: unknown }> = [];
    const client = new NativeAnswerMcpClient(await gateway(calls), "omn_fictional");
    try {
      await Promise.all([
        client.postJson("/mcp", {
          question: "First fictional question?",
          clientRequestId: "request_first",
        }),
        client.postJson("/mcp", {
          question: "Second fictional question?",
          clientRequestId: "request_second",
        }),
      ]);
      expect(calls.map((call) => (call.args as { requestId: string }).requestId).sort()).toEqual([
        "request_first",
        "request_second",
      ]);
    } finally {
      await client.close();
    }
  });

  test("honors cancellation before opening a request", async () => {
    const client = new NativeAnswerMcpClient(await gateway([]), "omn_fictional");
    const controller = new AbortController();
    controller.abort(new Error("fictional cancellation"));
    try {
      await expect(
        client.postJson(
          "/mcp",
          { question: "A fictional question?", clientRequestId: "request_cancelled" },
          controller.signal,
        ),
      ).rejects.toBeDefined();
    } finally {
      await client.close();
    }
  });
});
