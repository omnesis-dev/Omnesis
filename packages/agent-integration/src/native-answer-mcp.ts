// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import http from "node:http";
import https from "node:https";

import {
  Client,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  type AuthProvider,
  type CallToolResult,
  type FetchLike,
  type OAuthClientProvider,
  type Tool,
} from "@modelcontextprotocol/client";
import { z } from "zod";

import {
  DEFAULT_GATEWAY_TIMEOUT_MS,
  GatewayRequestTimeoutError,
  IntegrationHttpError,
  OAUTH_TOKEN_TIMEOUT_MS,
  type GatewayRequestOptions,
} from "./http.js";
import { mcpEndpointUrl, pinnedTlsOptions, type TlsTrust, validateGatewayUrl } from "./tls.js";
import { ANSWER_CITATIONS_META_KEY, answerCitationsSchema } from "./answer-citations.js";
import type { AnswerPoster } from "./answer-wait.js";

export const NATIVE_CONVERSATION_META_KEY = "dev.omnesis/nativeConversationId";
export const ANSWER_ERROR_META_KEY = "dev.omnesis/error";
/**
 * The largest `/mcp` response accepted. A Direct result may carry up to 1 MiB
 * of JSON, and the JSON-RPC envelope and event-stream framing around it add a
 * little more; the rest is headroom, so a result at the gateway's ceiling is
 * never cut off while a misbehaving gateway still cannot make the plugin
 * buffer without bound.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const answerBase = {
  workflowId: z.string(),
  conversationId: z.string(),
  taskId: z.string(),
};

const answerResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...answerBase,
      status: z.literal("released"),
      releaseId: z.string(),
      answer: z.string(),
      citations: answerCitationsSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...answerBase,
      status: z.literal("released_with_reductions"),
      releaseId: z.string(),
      answer: z.string(),
      reductions: z.array(z.string()),
      citations: answerCitationsSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...answerBase,
      status: z.literal("approval_required"),
      approvalId: z.string(),
      approvalExpiresAt: z.number(),
    })
    .strict(),
  z
    .object({
      ...answerBase,
      status: z.literal("denied"),
      reason: z.enum([
        "privacy_policy",
        "hard_stop",
        "user_denied",
        "expired",
        "canceled",
        "approval_not_available",
      ]),
    })
    .strict(),
]);

export type NativeAnswerResponse = z.infer<typeof answerResponseSchema>;

/** Fail closed before any gateway Answer response reaches an external harness. */
function parseNativeAnswerResponse(value: unknown): NativeAnswerResponse {
  return answerResponseSchema.parse(value);
}

/**
 * Official modern-MCP client adapted to the native integrations' pinned TLS
 * boundary. It carries the integration's Answer asks, and lists and forwards
 * the connection's other tools (see `forwarded-tools.ts`). The native route is
 * request metadata, never a tool argument the external model can choose.
 */
export class NativeAnswerMcpClient {
  private readonly endpoint: URL;
  private readonly fetch: FetchLike;
  private readonly authProvider: AuthProvider | OAuthClientProvider;
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private connecting: Promise<void> | null = null;
  private connectingTransport: StreamableHTTPClientTransport | null = null;
  private connectAbort: AbortController | null = null;
  private closed = false;
  private readonly nativeConversationByBody = new WeakMap<object, string>();

  constructor(
    gatewayUrl: string,
    authProvider: AuthProvider | OAuthClientProvider | string,
    private readonly trust?: TlsTrust,
    private readonly nativeConversationId?: string,
  ) {
    const base = validateGatewayUrl(gatewayUrl);
    this.authProvider =
      typeof authProvider === "string" ? { token: async () => authProvider } : authProvider;
    this.endpoint = mcpEndpointUrl(base);
    // The transport hands this fetch to the auth provider when a request is
    // refused, so it renews through it: it must reach the authorization server
    // the gateway advertises, which may sit on another origin than the MCP
    // endpoint, under the same OAuth-path rules as `integrationOAuthFetch`.
    const fetch = pinnedFetch(base, trust, true, OAUTH_HTTP_BUDGETS);
    this.fetch = hasTrackedFetch(this.authProvider) ? this.authProvider.trackFetch(fetch) : fetch;
  }

  async postJson<T = unknown>(
    path: string,
    value: unknown,
    signal?: AbortSignal,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    const nativeConversationId =
      value !== null && typeof value === "object"
        ? (this.nativeConversationByBody.get(value) ?? this.nativeConversationId)
        : this.nativeConversationId;
    return this.postJsonForConversation(path, value, nativeConversationId, signal, options);
  }

  /** A per-conversation view over the shared OAuth session and MCP transport. */
  forNativeConversation(nativeConversationId: string): AnswerPoster {
    return {
      postJson: <T = unknown>(
        path: string,
        value: unknown,
        signal?: AbortSignal,
        options?: GatewayRequestOptions,
      ) => {
        if (value !== null && typeof value === "object") {
          this.nativeConversationByBody.set(value, nativeConversationId);
        }
        return this.postJson<T>(path, value, signal, options);
      },
    };
  }

  private async postJsonForConversation<T = unknown>(
    path: string,
    value: unknown,
    nativeConversationId: string | undefined,
    signal?: AbortSignal,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    if (path !== "/mcp") {
      throw new Error("native Answer MCP client accepts only /mcp");
    }
    const body = integrationBodySchema.parse(value);
    const deadline = Date.now() + (options?.timeoutMs ?? 60_000);
    const result = await this.call(
      "ask_omnesis",
      {
        question: body.question,
        requestId: body.clientRequestId,
        ...(body.conversationId ? { conversationId: body.conversationId } : {}),
        ...(body.workflowId ? { workflowId: body.workflowId } : {}),
        ...(body.workflowName ? { workflowName: body.workflowName } : {}),
        ...(body.workflowPurpose ? { workflowPurpose: body.workflowPurpose } : {}),
        ...(body.approval ? { approval: body.approval } : {}),
      },
      signal,
      remainingBudget(deadline),
      nativeConversationId,
    );
    return result as T;
  }

  async getTask(
    taskId: string,
    signal?: AbortSignal,
    options?: GatewayRequestOptions,
  ): Promise<NativeAnswerResponse> {
    return this.call("get_answer_status", { taskId }, signal, options?.timeoutMs);
  }

  /** Every tool the gateway lists for this connection's credential. */
  async listTools(signal?: AbortSignal, timeoutMs = 60_000): Promise<Tool[]> {
    return this.request(timeoutMs, signal, async (client, remaining) => {
      const { tools } = await client.listTools(undefined, {
        signal,
        timeout: remaining,
        maxTotalTimeout: remaining,
        cacheMode: "bypass",
      });
      return tools;
    });
  }

  /** Call one gateway tool and return its result as the gateway sent it. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 60_000,
  ): Promise<CallToolResult> {
    return this.request(timeoutMs, signal, (client, remaining) =>
      client.callTool(
        { name, arguments: args },
        { signal, timeout: remaining, maxTotalTimeout: remaining },
      ),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connectAbort?.abort(new Error("Native Answer MCP client is closed"));
    const connectingTransport = this.connectingTransport;
    if (connectingTransport) await Promise.allSettled([connectingTransport.close()]);
    const connecting = this.connecting;
    if (connecting) await Promise.allSettled([connecting]);
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    await Promise.allSettled([client?.close(), transport?.close()]);
  }

  private async call(
    name: "ask_omnesis" | "get_answer_status",
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 60_000,
    nativeConversationId?: string,
  ): Promise<NativeAnswerResponse> {
    const result = await this.request(timeoutMs, signal, (client, remaining) =>
      client.callTool(
        {
          name,
          arguments: args,
          // Declares that this client parses released citations; the gateway
          // withholds them from a bound integration that does not.
          _meta: {
            [ANSWER_CITATIONS_META_KEY]: true,
            ...(nativeConversationId
              ? { [NATIVE_CONVERSATION_META_KEY]: nativeConversationId }
              : {}),
          },
        },
        { signal, timeout: remaining, maxTotalTimeout: remaining },
      ),
    );
    if (result.isError) throw toolError(result._meta);
    return parseNativeAnswerResponse(result.structuredContent);
  }

  /** Run one request on the connected client inside a single time budget. */
  private async request<T>(
    timeoutMs: number,
    signal: AbortSignal | undefined,
    send: (client: Client, remainingMs: number) => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    await this.connect(signal, remainingBudget(deadline));
    try {
      return await send(this.client!, remainingBudget(deadline));
    } catch (error) {
      if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
        throw new GatewayRequestTimeoutError(timeoutMs);
      }
      throw error;
    }
  }

  private async connect(signal?: AbortSignal, timeoutMs = 60_000): Promise<void> {
    if (this.closed) throw new Error("Native Answer MCP client is closed");
    if (this.client) return;
    if (!this.connecting) {
      const connectAbort = new AbortController();
      this.connectAbort = connectAbort;
      const connectSignal = signal
        ? AbortSignal.any([signal, connectAbort.signal])
        : connectAbort.signal;
      const transport = new StreamableHTTPClientTransport(this.endpoint, {
        authProvider: this.authProvider,
        onInsufficientScope: "throw",
        fetch: this.fetch,
      });
      this.connectingTransport = transport;
      this.connecting = (async () => {
        const client = new Client(
          { name: "omnesis-native-integration", version: "1.0.0" },
          { versionNegotiation: { mode: { pin: "2026-07-28" } }, defaultCacheTtlMs: 0 },
        );
        try {
          await client.connect(transport, {
            signal: connectSignal,
            timeout: Math.min(timeoutMs, 30_000),
            maxTotalTimeout: Math.min(timeoutMs, 30_000),
          });
          if (this.closed) {
            await Promise.allSettled([client.close(), transport.close()]);
            throw new Error("Native Answer MCP client is closed");
          }
          this.client = client;
          this.transport = transport;
        } catch (error) {
          await Promise.allSettled([client.close(), transport.close()]);
          throw error;
        }
      })().finally(() => {
        if (this.connectingTransport === transport) this.connectingTransport = null;
        if (this.connectAbort === connectAbort) this.connectAbort = null;
        this.connecting = null;
      });
    }
    await this.connecting;
  }
}

function hasTrackedFetch(
  provider: AuthProvider | OAuthClientProvider,
): provider is AuthProvider & { trackFetch(fetchFn: FetchLike): FetchLike } {
  return "trackFetch" in provider && typeof provider.trackFetch === "function";
}

function remainingBudget(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new GatewayRequestTimeoutError(0);
  return remaining;
}

const integrationBodySchema = z
  .object({
    question: z.string().min(1).max(10_000),
    clientRequestId: z.string().min(1).max(160),
    conversationId: z.string().optional(),
    workflowId: z.string().optional(),
    workflowName: z.string().optional(),
    workflowPurpose: z.string().optional(),
    approval: z.enum(["allow", "never"]).optional(),
  })
  .strict();

const answerErrorMetaSchema = z
  .object({
    status: z.union([
      z.literal(400),
      z.literal(401),
      z.literal(403),
      z.literal(404),
      z.literal(409),
      z.literal(429),
      z.literal(500),
      z.literal(502),
      z.literal(503),
      z.literal(504),
    ]),
    code: z
      .enum([
        "BAD_REQUEST",
        "UNAUTHORIZED",
        "FORBIDDEN",
        "NOT_FOUND",
        "CONFLICT",
        "CONTEXT_WINDOW_EXCEEDED",
        "ANSWER_IN_PROGRESS",
        "ANSWER_EGRESS_LIMIT",
        "INVALID_NATIVE_ANSWER_ROUTE",
        "BAD_GATEWAY",
        "SERVICE_UNAVAILABLE",
        "GATEWAY_TIMEOUT",
        "INTERNAL_ERROR",
      ])
      .optional(),
    taskId: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{1,160}$/)
      .optional(),
  })
  .strict();

function toolError(meta: unknown): IntegrationHttpError {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return new IntegrationHttpError(500, "Omnesis Answer MCP tool failed");
  }
  const parsed = answerErrorMetaSchema.safeParse(
    (meta as Record<string, unknown>)[ANSWER_ERROR_META_KEY],
  );
  if (!parsed.success) return new IntegrationHttpError(500, "Omnesis Answer MCP tool failed");
  return new IntegrationHttpError(
    parsed.data.status,
    "Omnesis Answer MCP tool rejected the request",
    undefined,
    parsed.data.code,
  );
}

/** Socket budgets for the OAuth protocol requests an integration makes. */
export interface OAuthHttpBudgets {
  /** Discovery, registration and the authorization pages: ordinary requests. */
  requestMs: number;
  /** The token endpoint, whose answer waits on the gateway's writer. */
  tokenMs: number;
}

const OAUTH_HTTP_BUDGETS: OAuthHttpBudgets = {
  requestMs: DEFAULT_GATEWAY_TIMEOUT_MS,
  tokenMs: OAUTH_TOKEN_TIMEOUT_MS,
};

export function integrationOAuthFetch(
  gatewayUrl: string,
  trust?: TlsTrust,
  budgets: OAuthHttpBudgets = OAUTH_HTTP_BUDGETS,
): FetchLike {
  return pinnedFetch(validateGatewayUrl(gatewayUrl), trust, true, budgets);
}

function pinnedFetch(
  base: URL,
  trust?: TlsTrust,
  allowDiscoveredAuthorizationServer = false,
  oauthBudgets?: OAuthHttpBudgets,
): FetchLike {
  if (base.protocol === "https:" && !trust) {
    throw new Error("HTTPS integration requires pinned TLS trust material");
  }
  const pinnedOptions = base.protocol === "https:" ? pinnedTlsOptions(base.hostname, trust!) : null;
  return async (input, init) => {
    const requestValue = new Request(input, init);
    const url = new URL(requestValue.url);
    const sameOrigin = url.origin === base.origin;
    const oauthPath = isOAuthProtocolPath(url.pathname);
    const mcpPath = `${base.pathname.replace(/\/+$/u, "")}/mcp`;
    const allowed = sameOrigin ? url.pathname === mcpPath || oauthPath : oauthPath;
    const trustedCrossOrigin =
      allowDiscoveredAuthorizationServer &&
      (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname)));
    if (!allowed || (!sameOrigin && !trustedCrossOrigin)) {
      throw new Error("native Answer MCP transport left its pinned gateway endpoint");
    }
    const body = requestValue.body ? Buffer.from(await requestValue.arrayBuffer()) : null;
    const request = url.protocol === "https:" ? https.request : http.request;
    return new Promise<Response>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const outgoing = request(
        url,
        {
          ...(sameOrigin ? (pinnedOptions ?? {}) : {}),
          method: requestValue.method,
          headers: Object.fromEntries(requestValue.headers.entries()),
          signal: requestValue.signal,
        },
        (incoming) => {
          let received = 0;
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => {
            received += chunk.byteLength;
            if (received > MAX_RESPONSE_BYTES) {
              outgoing.destroy(new Error("gateway response exceeded 4 MiB"));
              return;
            }
            chunks.push(chunk);
          });
          incoming.on("end", () => {
            if (timeout) clearTimeout(timeout);
            const headers = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (Array.isArray(value)) for (const item of value) headers.append(name, item);
              else if (value !== undefined) headers.set(name, String(value));
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: incoming.statusCode ?? 500,
                statusText: incoming.statusMessage,
                headers,
              }),
            );
          });
        },
      );
      outgoing.on("error", (error) => {
        if (timeout) clearTimeout(timeout);
        reject(error);
      });
      if (oauthPath && oauthBudgets !== undefined) {
        const budgetMs = isTokenEndpointPath(url.pathname)
          ? oauthBudgets.tokenMs
          : oauthBudgets.requestMs;
        timeout = setTimeout(() => {
          outgoing.destroy(new Error("Omnesis OAuth request timed out"));
        }, budgetMs);
      }
      outgoing.end(body ?? undefined);
    });
  };
}

function isTokenEndpointPath(pathname: string): boolean {
  return /(?:^|\/)oauth\/token$/u.test(pathname);
}

function isOAuthProtocolPath(pathname: string): boolean {
  return (
    /(?:^|\/)oauth\/(?:token|register|authorize|consent|authorize\/status|authorize\/complete)$/u.test(
      pathname,
    ) ||
    /^\/\.well-known\/oauth-protected-resource(?:\/.*)?$/u.test(pathname) ||
    /^\/\.well-known\/oauth-authorization-server(?:\/.*)?$/u.test(pathname)
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
