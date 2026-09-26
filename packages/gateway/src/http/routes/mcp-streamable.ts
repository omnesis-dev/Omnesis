// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createMcpHandler,
  McpServer,
  type AuthInfo,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { createLogger, readPackageVersion } from "@omnesis/core";
import { tryDeviceId, type DeviceId } from "@omnesis/types";
import { bodyLimit } from "hono/body-limit";

import { registerNotesMcpTool, NOTES_MCP_INSTRUCTIONS } from "../../mcp/notes-server.js";
import { notesRateLimiter } from "../../rate-limit.js";
import {
  boundDirectAuditValue,
  isDirectMcpToolName,
  stripDirectGroupingParams,
} from "../../agent/direct-mcp.js";
import {
  protectedResourceMetadataUrl,
  resolveMcpRequestResource,
  resolveOAuthUrls,
} from "../../access/oauth-urls.js";
import {
  createCorpusAuthorization,
  externalAnswerOwnerId,
  parseCorpusAuthorization,
  serializeCorpusAuthorization,
  type CorpusAuthorization,
} from "../../access/corpus-authorization.js";
import {
  AnswerMcpGatewayError,
  ANSWER_MCP_COMBINED_INSTRUCTIONS,
  ANSWER_MCP_INSTRUCTIONS,
  ANSWER_MCP_SUPPORTED_VERSIONS,
  registerAnswerMcpTools,
} from "../../mcp/answer-server.js";
import {
  DIRECT_MCP_SUPPORTED_VERSIONS,
  registerDirectMcpTools,
  renderDirectMcpInstructions,
  type DirectMcpServerManifest,
} from "../../mcp/direct-server.js";
import { getAnswerBoundary, submitAnswerBoundaryWithProfile } from "../answer-boundary.js";
import { ForbiddenError, HttpError } from "../errors.js";
import { scope } from "../scope.js";
import {
  DirectMcpBusyError,
  DirectMcpRateLimitError,
  type DirectMcpExecutionBoundary,
} from "../../mcp/direct-execution-boundary.js";
import { clientIp } from "./admin/internals.js";
import { mapAnswerError } from "./agent.js";
import type { AppendDirectAuditEventInput } from "../../privacy/store.js";
import type { OmnesisNotesRuntime } from "../../sources/omnesis-notes/index.js";
import type { AnswerService } from "../../privacy/answer-service.js";
import type {
  AccessCapability,
  McpInvocationAuditOutcome,
  McpToolInvocationAuditInput,
} from "../../access/types.js";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, AuthContext, RouteApp } from "./types.js";

const MCP_HTTP_BODY_LIMIT_BYTES = 64 * 1024;
const DIRECT_MANIFEST_CACHE_MS = 5_000;
const GATEWAY_VERSION = readPackageVersion(import.meta.url);
const log = createLogger("gateway:mcp-http");

export interface McpHttpRuntime {
  close(): Promise<void>;
}

export interface McpStreamableRoutesDeps {
  notesRuntime?: () => OmnesisNotesRuntime;
  directBoundary?: DirectMcpExecutionBoundary;
  /** Stable object whose Answer service is replaced during live model swaps. */
  answerDeps?: { answerService?: AnswerService; disabledReason?: string };
  isAgentIntegrationDevice?: (deviceId: DeviceId) => boolean;
  publicBaseUrl?: string;
  mcpResourceUrls?: readonly string[];
  /** Required final authorization and attribution fence for every corpus result. */
  recordMcpToolInvocation: (input: McpToolInvocationAuditInput) => Promise<void>;
  /**
   * Best-effort Direct transcript writer. Unlike the attribution fence, a
   * transcript outage must never fail the corpus read it describes — the
   * access ledger stays authoritative — so callers swallow its errors after
   * a warning. Absent in tests that do not wire the privacy store.
   */
  recordDirectAuditEvent?: (input: AppendDirectAuditEventInput) => Promise<void>;
}

export function mountMcpStreamableRoutes(
  app: RouteApp,
  deps: McpStreamableRoutesDeps,
): McpHttpRuntime {
  const handler = createUnifiedHandler(deps);
  const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
    try {
      await next();
    } finally {
      c.header("Cache-Control", "private, no-store");
      c.header("Pragma", "no-cache");
      c.header("Vary", "Authorization, Origin");
    }
  };
  const rejectBrowserOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (c.req.header("Origin") !== undefined) {
      return c.json({ error: "Browser-origin MCP requests are not accepted." }, 403);
    }
    return next();
  };
  const requireOAuthPrincipal: MiddlewareHandler<AppEnv> = async (c, next) => {
    const auth = c.get("auth") as AuthContext | undefined;
    if (auth?.authMethod !== "principal-oauth") {
      return oauthChallenge(
        c,
        deps.publicBaseUrl,
        deps.mcpResourceUrls,
        c.req.header("Authorization") !== undefined,
      );
    }
    return next();
  };
  const requireJson: MiddlewareHandler<AppEnv> = async (c, next) => {
    const mediaType = c.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      return c.json({ error: "MCP requests require application/json." }, 415);
    }
    return next();
  };
  const rejectSessionState: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (
      c.req.header("Mcp-Session-Id") !== undefined ||
      c.req.header("Last-Event-ID") !== undefined
    ) {
      return c.json({ error: "This stateless MCP endpoint accepts no session handles." }, 400);
    }
    return next();
  };
  const limitBody = bodyLimit({
    maxSize: MCP_HTTP_BODY_LIMIT_BYTES,
    onError: (c) => c.json({ error: "MCP request body is too large." }, 413),
  });

  for (const nearMiss of ["/mcp/", "/MCP", "/MCP/"]) {
    app.all(nearMiss, noStore, scope.public(), (c) =>
      c.redirect(new URL("/mcp", c.req.url).toString(), 308),
    );
  }
  for (const retired of ["/mcp/answer", "/mcp/direct"]) {
    app.all(retired, noStore, scope.public(), (c) =>
      c.json(
        {
          error:
            "This MCP endpoint was retired. Configure the single /mcp resource and authorize it with OAuth.",
          replacement: new URL("/mcp", c.req.url).toString(),
        },
        410,
      ),
    );
  }

  app.post(
    "/mcp",
    noStore,
    rejectBrowserOrigin,
    scope.public(),
    requireOAuthPrincipal,
    requireJson,
    rejectSessionState,
    limitBody,
    async (c) => {
      const response = await handler.fetch(c.req.raw, {
        authInfo: authInfo(c.get("auth"), clientIp(c), c.get("requestId")),
      });
      return privateResponse(response);
    },
  );
  for (const method of ["get", "delete"] as const) {
    app[method]("/mcp", noStore, rejectBrowserOrigin, scope.public(), requireOAuthPrincipal, (c) =>
      c.json({ error: "This stateless MCP endpoint accepts POST only." }, 405, {
        Allow: "POST",
      }),
    );
  }
  return { close: () => handler.close() };
}

function createUnifiedHandler(deps: McpStreamableRoutesDeps): McpHttpHandler {
  const captureLimiter = notesRateLimiter();
  const directManifests = new Map<
    string,
    { loadedAt: number; value: Promise<DirectMcpServerManifest> }
  >();
  const loadDirectManifest = (authorization: CorpusAuthorization) => {
    if (!deps.directBoundary) return null;
    const now = Date.now();
    for (const [digest, entry] of directManifests) {
      if (now - entry.loadedAt >= DIRECT_MANIFEST_CACHE_MS) directManifests.delete(digest);
    }
    const cached = directManifests.get(authorization.digest);
    if (cached && now - cached.loadedAt < DIRECT_MANIFEST_CACHE_MS) {
      return cached.value;
    }
    const value = Promise.all([
      Promise.resolve(deps.directBoundary.manifest(authorization)),
      deps.directBoundary.instructions(authorization),
    ])
      .then(([tools, instructions]) => ({ tools: [...tools], instructions }))
      .catch((error: unknown) => {
        directManifests.delete(authorization.digest);
        throw error;
      });
    directManifests.set(authorization.digest, { loadedAt: now, value });
    return value;
  };

  return createMcpHandler(
    async ({ authInfo: auth }) => {
      if (!auth) throw new ForbiddenError("A bearer credential is required.");
      const hasAnswer = boolExtra(auth, "answer");
      const hasDirect = boolExtra(auth, "direct");
      const hasNotes = boolExtra(auth, "notes");
      if (!hasAnswer && !hasDirect && !hasNotes) {
        throw new ForbiddenError("The Access Grant has no MCP capability.");
      }
      const answerAuthorization = hasAnswer
        ? authorizationExtra(auth, "answerAuthorization", "answer")
        : null;
      const directAuthorization = hasDirect
        ? authorizationExtra(auth, "directAuthorization", "direct")
        : null;

      const answerService = hasAnswer ? deps.answerDeps?.answerService : undefined;
      let manifest: DirectMcpServerManifest | null = null;
      let directUnavailable = false;
      if (hasDirect) {
        const manifestPromise = loadDirectManifest(directAuthorization!);
        if (!deps.directBoundary || !manifestPromise) {
          directUnavailable = true;
        } else {
          try {
            manifest = await manifestPromise;
          } catch (error) {
            directUnavailable = true;
            log.warn(
              `Direct MCP catalogue unavailable: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
      const answerAvailable = hasAnswer && answerService !== undefined;
      const directAvailable = hasDirect && !directUnavailable && manifest !== null;
      const notesAvailable = hasNotes && deps.notesRuntime !== undefined;
      const unavailable = [
        hasNotes && !notesAvailable ? "Notes" : null,
        hasAnswer && !answerAvailable ? "Answer" : null,
        hasDirect && !directAvailable ? "Direct" : null,
      ].filter((value): value is string => value !== null);
      const instructions = renderUnifiedInstructions({
        hasNotes: notesAvailable,
        hasAnswer: answerAvailable,
        hasDirect: directAvailable,
        directInstructions: manifest?.instructions,
        unavailable,
      });
      const server = new McpServer(
        { name: "omnesis", version: GATEWAY_VERSION },
        {
          capabilities: { tools: { listChanged: false } },
          instructions,
          supportedProtocolVersions: [
            ...new Set([...ANSWER_MCP_SUPPORTED_VERSIONS, ...DIRECT_MCP_SUPPORTED_VERSIONS]),
          ],
        },
      );

      const tokenIdentity = stringExtra(auth, "tokenIdentity");
      const ownerId = answerAuthorization
        ? externalAnswerOwnerId(answerAuthorization)
        : `principal:${stringExtra(auth, "principalId")}`;
      const executionDeviceId = tryDeviceId(optionalStringExtra(auth, "executionDeviceId") ?? "");
      const activeExecutionDeviceId =
        executionDeviceId && deps.isAgentIntegrationDevice?.(executionDeviceId)
          ? executionDeviceId
          : null;

      if (answerAvailable && answerService) {
        registerAnswerMcpTools(server, {
          async submit(input, options) {
            return auditedInvocation(
              deps,
              auth,
              "answer",
              "ask_omnesis",
              options?.signal,
              async (egressAudit) => {
                try {
                  if (input.nativeConversationId && !activeExecutionDeviceId) {
                    throw new ForbiddenError(
                      "Native Answer routes require a bound agent integration.",
                    );
                  }
                  const { egress, profile } = await submitAnswerBoundaryWithProfile(
                    answerService,
                    ownerId,
                    {
                      question: input.question,
                      clientRequestId: input.clientRequestId,
                      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
                      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
                      ...(input.workflowName ? { workflowName: input.workflowName } : {}),
                      ...(input.workflowPurpose ? { workflowPurpose: input.workflowPurpose } : {}),
                      approvalMode: input.approval ?? "never",
                      corpusAuthorization: answerAuthorization!,
                      ...(input.profiling ? { profiling: true as const } : {}),
                      ...(input.nativeConversationId && activeExecutionDeviceId
                        ? {
                            completionRoute: {
                              integrationDeviceId: activeExecutionDeviceId,
                              nativeConversationId: input.nativeConversationId,
                            },
                          }
                        : {}),
                    },
                    "/mcp",
                    options?.signal,
                    egressAudit,
                  );
                  return { response: egress.response, profile };
                } catch (error) {
                  throw asAnswerHttpError(error);
                }
              },
              undefined,
              true,
            );
          },
          async getTask(taskId, options) {
            return auditedInvocation(
              deps,
              auth,
              "answer",
              "get_answer_status",
              options?.signal,
              async (egressAudit) => {
                try {
                  const egress = await getAnswerBoundary(
                    answerService,
                    taskId,
                    ownerId,
                    "/mcp",
                    options?.signal,
                    egressAudit,
                  );
                  return egress.response;
                } catch (error) {
                  throw asAnswerHttpError(error);
                }
              },
              undefined,
              true,
            );
          },
        });
      }

      if (directAvailable && manifest && deps.directBoundary) {
        registerDirectMcpTools(
          server,
          {
            async callTool(name, args, options) {
              if (!isDirectMcpToolName(name)) throw new Error("Unexpected Omnesis Direct tool.");
              const signal = options?.signal ?? new AbortController().signal;
              const requestId = stringExtra(auth, "requestId");
              // Grouping keys ride along for the transcript only; the
              // service strips them before the canonical handles run.
              const { grouping, args: toolArgs } = stripDirectGroupingParams(args);
              const transcriptBase = {
                ownerId,
                tool: name,
                requestId,
                args: toolArgs,
                ...(grouping.conversationId ? { conversationId: grouping.conversationId } : {}),
                ...(grouping.workflowId ? { workflowId: grouping.workflowId } : {}),
              };
              try {
                const result = await auditedInvocation(
                  deps,
                  auth,
                  "direct",
                  name,
                  signal,
                  () =>
                    deps.directBoundary!.invoke(name, toolArgs, {
                      clientIp: stringExtra(auth, "clientIp"),
                      requestId,
                      tokenId: tokenIdentity,
                      deviceId: activeExecutionDeviceId,
                      admissionKey: stringExtra(auth, "credentialId"),
                      signal,
                      ...(options?.timeZone ? { timeZone: options.timeZone } : {}),
                      rateAlreadyCharged: false,
                      authorization: directAuthorization!,
                    }),
                  (result) => (result.kind === "error" ? "refused" : "ok"),
                );
                await recordDirectTranscript(deps, auth, {
                  ...transcriptBase,
                  outcome: result.kind === "error" ? "refused" : "ok",
                  result,
                });
                return result;
              } catch (error) {
                await recordDirectTranscript(deps, auth, {
                  ...transcriptBase,
                  outcome: invocationFailureOutcome(error, signal),
                });
                throw error;
              }
            },
          },
          manifest,
        );
      }
      if (notesAvailable) {
        registerNotesMcpTool(server, async (input, signal) => {
          return auditedInvocation(
            deps,
            auth,
            "notes",
            "add_note",
            signal,
            async (audit) => {
              signal.throwIfAborted();
              const credentialId = stringExtra(auth, "credentialId");
              if (captureLimiter.consume(credentialId)) throw new DirectMcpRateLimitError();
              const principalId = stringExtra(auth, "principalId");
              const entry = await deps.notesRuntime!().capture(
                {
                  ...input,
                  surface: "mcp",
                  ...(activeExecutionDeviceId ? { deviceId: activeExecutionDeviceId } : {}),
                  captureContext: {
                    principalId,
                    principalName: stringExtra(auth, "principalName"),
                    grantId: stringExtra(auth, "grantId"),
                    grantRevision: parsePositiveIntegerExtra(auth, "grantRevision"),
                    credentialId,
                    oauthClientId: stringExtra(auth, "oauthClientId"),
                    requestId: stringExtra(auth, "requestId"),
                  },
                },
                audit,
              );
              return {
                id: entry.id,
                captureId: input.id,
                day: entry.day,
                capturedAt: entry.capturedAt,
                receivedAt: entry.receivedAt,
              };
            },
            undefined,
            true,
          );
        });
      }
      return server;
    },
    {
      legacy: "stateless",
      // Always establish the SSE response promptly. Answer calls may remain in
      // progress for minutes while the privacy gate or a human decision runs;
      // an early streaming response prevents hosted clients from treating that
      // healthy silence as a dead HTTP request.
      responseMode: "sse",
      maxSubscriptions: 0,
      onerror: (error) => log.warn(`MCP HTTP protocol error (${error.name})`),
    },
  );
}

function authInfo(auth: AuthContext, clientIpValue: string, requestId: string): AuthInfo {
  if (auth.authMethod === "principal-oauth") {
    const identity = {
      principalId: auth.principalId,
      grantId: auth.grantId,
      grantRevision: auth.grantRevision,
      credentialId: auth.credentialId,
      accessTokenId: auth.accessTokenId,
    };
    const answerAuthorization = createCorpusAuthorization(identity, auth.capabilities, "answer");
    const directAuthorization = createCorpusAuthorization(identity, auth.capabilities, "direct");
    const hasNotes = auth.capabilities.some((rule) => rule.capability === "notes");
    return {
      token: auth.accessTokenId,
      clientId: auth.principalId,
      scopes: ["omnesis:access"],
      extra: {
        tokenIdentity: auth.accessTokenId,
        principalId: auth.principalId,
        principalName: auth.principalName,
        grantId: auth.grantId,
        grantRevision: String(auth.grantRevision),
        credentialId: auth.credentialId,
        oauthClientId: auth.oauthClientId,
        notes: String(hasNotes),
        answer: String(answerAuthorization !== null),
        direct: String(directAuthorization !== null),
        ...(answerAuthorization
          ? { answerAuthorization: serializeCorpusAuthorization(answerAuthorization) }
          : {}),
        ...(directAuthorization
          ? { directAuthorization: serializeCorpusAuthorization(directAuthorization) }
          : {}),
        ...(auth.executionDeviceId ? { executionDeviceId: auth.executionDeviceId } : {}),
        clientIp: clientIpValue,
        requestId,
      },
    };
  }
  throw new ForbiddenError("An OAuth principal credential is required.");
}

async function auditedInvocation<T>(
  deps: McpStreamableRoutesDeps,
  auth: AuthInfo,
  capability: AccessCapability,
  tool: string,
  signal: AbortSignal | undefined,
  invoke: (egressAudit?: McpToolInvocationAuditInput) => Promise<T>,
  classify: (result: T) => McpInvocationAuditOutcome = () => "ok",
  auditAtEgress = false,
): Promise<T> {
  const principalId = optionalStringExtra(auth, "principalId");
  if (!principalId) throw new ForbiddenError("Authenticated MCP principal identity is missing.");
  const auditBase = {
    accessTokenId: stringExtra(auth, "tokenIdentity"),
    principalId,
    grantId: stringExtra(auth, "grantId"),
    grantRevision: parsePositiveIntegerExtra(auth, "grantRevision"),
    credentialId: stringExtra(auth, "credentialId"),
    oauthClientId: stringExtra(auth, "oauthClientId"),
    capability,
    tool,
    requestId: stringExtra(auth, "requestId"),
    sourceMode:
      capability === "notes"
        ? ("all" as const)
        : (authorizationExtra(auth, `${capability}Authorization`, capability)
            .sourceMode as McpToolInvocationAuditInput["sourceMode"]),
  };
  let result: T;
  try {
    result = await invoke(
      auditAtEgress
        ? {
            ...auditBase,
            outcome: "ok",
            requireActiveAuthority: true,
          }
        : undefined,
    );
  } catch (error) {
    try {
      await deps.recordMcpToolInvocation({
        ...auditBase,
        outcome: invocationFailureOutcome(error, signal),
        requireActiveAuthority: false,
      });
    } catch (auditError) {
      // Refused/cancelled/failed calls release no corpus data, so an audit
      // outage must not replace the useful protocol error with a storage
      // failure. These diagnostic outcomes are explicitly best effort. A
      // successful corpus result below remains fail-closed until its audit is
      // durable, which is the security boundary this ledger guarantees.
      log.warn(
        `Failed to persist MCP refusal audit: ${auditError instanceof Error ? auditError.message : String(auditError)}`,
      );
    }
    throw error;
  }
  // A successful corpus read is not released until its durable attribution
  // row lands. Keep this outside the invocation catch so a writer outage does
  // not generate a misleading second "failed invocation" audit attempt.
  if (!auditAtEgress) {
    await deps.recordMcpToolInvocation({
      ...auditBase,
      outcome: signal?.aborted ? "cancelled" : classify(result),
      requireActiveAuthority: true,
    });
  }
  return result;
}

/**
 * Best-effort Direct transcript write. The access-ledger row written by
 * `auditedInvocation` stays the authoritative record; a transcript outage
 * warns and yields rather than failing the corpus read it describes.
 *
 * Cost: one awaited writer op per tool call, serialized behind the ledger
 * op above — the read pays a writer-queue wait (unlike Answer, which
 * batches one audit op per task). Kept awaited on purpose: a dropped
 * transcript write would silently hole the audit trail this exists to
 * keep. If Direct volume ever makes the wait visible, batch per request
 * rather than weakening to fire-and-forget.
 */
async function recordDirectTranscript(
  deps: McpStreamableRoutesDeps,
  auth: AuthInfo,
  input: {
    ownerId: string;
    tool: string;
    outcome: McpInvocationAuditOutcome;
    requestId: string;
    args: Record<string, unknown>;
    result?: unknown;
    conversationId?: string;
    workflowId?: string;
  },
): Promise<void> {
  if (!deps.recordDirectAuditEvent) return;
  const principalId = optionalStringExtra(auth, "principalId");
  if (!principalId) return;
  try {
    // Bound here, on the reader, so the single writer only serializes small
    // normalized values; the store re-applies the same bound as a backstop.
    // Bound inside the try so an unserializable value can never mask the
    // tool error this recorder is reporting on.
    const args = boundDirectAuditValue(input.args);
    const result = input.result === undefined ? undefined : boundDirectAuditValue(input.result);
    await deps.recordDirectAuditEvent({
      ownerId: input.ownerId,
      principalId,
      credentialId: stringExtra(auth, "credentialId"),
      grantId: stringExtra(auth, "grantId"),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      tool: input.tool,
      outcome: input.outcome,
      requestId: input.requestId,
      args,
      ...(result === undefined ? {} : { result }),
      now: Date.now(),
    });
  } catch (error) {
    log.warn(
      `Failed to persist Direct transcript event: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parsePositiveIntegerExtra(auth: AuthInfo, key: string): number {
  const value = Number.parseInt(stringExtra(auth, key), 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ForbiddenError("Authenticated MCP request context is incomplete.");
  }
  return value;
}

function invocationFailureOutcome(
  error: unknown,
  signal: AbortSignal | undefined,
): McpInvocationAuditOutcome {
  if (signal?.aborted) return "cancelled";
  if (error instanceof Error && error.name === "NoteCaptureAuthorizationError") return "refused";
  if (error instanceof DirectMcpRateLimitError || error instanceof DirectMcpBusyError) {
    return "refused";
  }
  if (error instanceof AnswerMcpGatewayError) {
    if (error.status === 504) return "timed_out";
    return error.status < 500 ? "refused" : "failed";
  }
  if (error instanceof HttpError && error.status === 504) return "timed_out";
  if (error instanceof HttpError && error.status < 500) return "refused";
  return "failed";
}

function renderUnifiedInstructions(input: {
  hasNotes?: boolean;
  hasAnswer: boolean;
  hasDirect: boolean;
  directInstructions?: string;
  unavailable?: string[];
}): string {
  const answerInstructions = input.hasAnswer
    ? input.hasDirect || input.hasNotes
      ? ANSWER_MCP_COMBINED_INSTRUCTIONS
      : ANSWER_MCP_INSTRUCTIONS
    : null;
  const directInstructions =
    input.hasDirect && input.directInstructions
      ? renderDirectMcpInstructions(input.directInstructions)
      : null;
  const unavailable = input.unavailable?.length
    ? `${input.unavailable.join(" and ")} access is granted but currently unavailable on this gateway.`
    : null;
  return [
    answerInstructions,
    directInstructions,
    input.hasNotes ? NOTES_MCP_INSTRUCTIONS : null,
    unavailable,
  ]
    .filter((value): value is string => value !== null)
    .join("\n\n");
}

function oauthChallenge(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  publicBaseUrl?: string,
  mcpResourceUrls?: readonly string[],
  rejectedToken = false,
) {
  const urls = resolveOAuthUrls(c.req.url, publicBaseUrl, mcpResourceUrls);
  if (!urls) {
    return c.json({ error: "OAuth requires gateway.publicBaseUrl for non-loopback access." }, 503);
  }
  const requestResource = resolveMcpRequestResource(c.req.url, urls.supportedResources);
  if (!requestResource) {
    return c.json({ error: "This MCP resource URL is not configured on the gateway." }, 404);
  }
  c.header(
    "WWW-Authenticate",
    `Bearer resource_metadata="${protectedResourceMetadataUrl(requestResource)}", scope="omnesis:access"${rejectedToken ? ', error="invalid_token"' : ""}`,
  );
  return c.json({ error: "OAuth authorization is required." }, 401);
}

function privateResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Pragma", "no-cache");
  headers.set("Vary", "Authorization, Origin");
  headers.delete("Mcp-Session-Id");
  headers.delete("ETag");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function stringExtra(auth: AuthInfo, key: string): string {
  const value = auth.extra?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ForbiddenError("Authenticated MCP request context is incomplete.");
  }
  return value;
}

function optionalStringExtra(auth: AuthInfo, key: string): string | null {
  const value = auth.extra?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function authorizationExtra(
  auth: AuthInfo,
  key: string,
  capability: Exclude<AccessCapability, "notes">,
): CorpusAuthorization {
  let authorization: CorpusAuthorization;
  try {
    authorization = parseCorpusAuthorization(stringExtra(auth, key));
  } catch {
    throw new ForbiddenError("Authenticated MCP request context is incomplete.");
  }
  if (authorization.capability !== capability) {
    throw new ForbiddenError("Authenticated MCP request context is incomplete.");
  }
  return authorization;
}

function boolExtra(auth: AuthInfo, key: string): boolean {
  return stringExtra(auth, key) === "true";
}

function asAnswerHttpError(error: unknown): AnswerMcpGatewayError {
  const normalized = mapAnswerError(error);
  const mapped =
    normalized instanceof HttpError
      ? normalized
      : new HttpError(500, "INTERNAL_ERROR", "Internal server error");
  const detail =
    mapped.detail && typeof mapped.detail === "object" && !Array.isArray(mapped.detail)
      ? (mapped.detail as Readonly<Record<string, unknown>>)
      : null;
  return new AnswerMcpGatewayError(mapped.status, mapped.code, detail);
}
