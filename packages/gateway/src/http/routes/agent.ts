// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP entry points for the agent harness. Portal-side commands go through
 * these routes; streaming events flow back over the existing
 * admin-broadcast WS channel (the portal subscribes and filters by
 * `sessionId`).
 *
 * - GET  /admin/agent/config        → { backend, enabled, disabledReason }
 * - POST /answer                    → privacy-reviewed four-state response
 * - POST /agent/sessions           → { sessionId, conversationId, model, backend }
 * - POST /agent/sessions/:id/messages  { text } → { messageId }
 * - POST /agent/sessions/:id/cancel → { ok: true }
 *
 * Interactive agent routes require admin scope because the agent can read the
 * whole corpus. `/answer` instead requires the narrow `answer` scope and can
 * return only the privacy gate's release contract. The
 * caller id (`token:<tokenId>`) buckets per-caller caps and routes SSE
 * events; conversations themselves are shared across admin callers so
 * the portal and iOS see the same chat history.
 */

import { randomUUID } from "node:crypto";

import {
  createLogger,
  MAX_TIME_ZONE_LENGTH,
  normalizeTimeZone,
  type ModelDisplay,
} from "@omnesis/core";
import { buildPage } from "@omnesis/types";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { UNATTRIBUTED_CALLER } from "@omnesis/agent";
import { scope } from "../scope.js";
import { validateJson } from "../validate.js";
import { answerBody } from "../schemas/index.js";
import {
  BadGatewayError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  HttpError,
  NotFoundError,
  ServiceUnavailableError,
} from "../errors.js";
import {
  AgentError,
  paginateVisibleConversationMessages,
  type AgentService,
} from "../../agent/service.js";
import { decodePageCursor, encodePageCursor } from "../pagination-cursor.js";
import {
  AnswerCandidateLimitError,
  AnswerCapacityError,
  AnswerTaskInProgressError,
} from "../../privacy/answer-service.js";
import { AnswerStoreError } from "../../privacy/store.js";
import { tokenAnswerOwnerId } from "../../privacy/token-answer-owner.js";
import {
  getAnswerBoundary,
  submitAnswerBoundary,
  type DeviceAnswerAuthority,
} from "../answer-boundary.js";
import {
  annotateUnread,
  type ConversationReadStatePort,
} from "../../agent/conversation-read-state-service.js";
import type { CorpusAuthorization } from "../../access/corpus-authorization.js";
import type { DeviceAnswerScope } from "../../access/device-answer-scope.js";
import type { ToolCaller } from "@omnesis/agent";
import type { ConversationReader } from "../../agent/conversation-reader.js";
import type { AnswerService } from "../../privacy/answer-service.js";
import type { PrivacyReviewer } from "../../privacy/reviewer.js";
import type { PrivacyAdminService } from "../../privacy/admin-service.js";
import type { AuthContext, RouteApp } from "./types.js";

// Heartbeat interval for the SSE stream. Just below most proxy idle timeouts
// (60s typical) so the connection stays warm. Hand-tuned to "infrequent but
// safe" — agent events arrive in bursts, not steady throughput, so the
// stream is otherwise quiet.
const SSE_HEARTBEAT_MS = 25_000;

const log = createLogger("gateway:http").child("routes:agent");

const messageBody = z.object({
  text: z.string().min(1).max(10_000),
  // Explicit, per-message opt-in to the Deep Research loop (#748). Off/absent =
  // an ordinary agent turn. There is no implicit auto-gating — the `/`→"Deep
  // Research" pill (a later client chunk) flips this for the next send only.
  deepResearch: z.boolean().optional(),
  // Slow-answer push budget in ms. When the turn is still running after this
  // delay, the gateway delivers the final assistant text
  // as a push notification when the turn completes; a turn that finishes
  // sooner sends nothing. Set by voice clients whose assistant can't wait.
  // Mutually exclusive with `deepResearch` — the Deep Research loop never
  // arms the slow-answer watcher, so the handler rejects the pair with 400
  // rather than silently dropping the promised push.
  notifyAfterMs: z.number().int().min(1000).max(600_000).optional(),
  // A bounded promise that this turn's answer is being presented while it is
  // produced (the Watch ask surface). Registered immediately after the turn
  // is accepted, before its asynchronous completion can persist read state.
  // If the answer outlives the window it becomes unread normally.
  viewingForMs: z.number().int().min(1000).max(600_000).optional(),
});

// Partial update of a stored conversation. Currently only the `pinned`
// flag is mutable; modelled as a PATCH so future per-conversation fields
// (e.g. a user-set title) can join the same body without a new route.
const conversationPatchBody = z
  .object({
    pinned: z.boolean(),
  })
  .strict();

// A surface reporting that it is showing a conversation to the operator.
// `viewing` says whether it is still on screen: true holds the conversation
// open so content arriving now is seen as it arrives, false says the operator
// has moved on and the next thing the agent writes is something new. A client
// that omits it is treated as still looking, which is what a bare "I opened
// this" means.
const conversationSeenBody = z
  .object({
    viewing: z.boolean().optional(),
  })
  .strict();

// `resumeFromId` continues an existing conversation; omitting it spins up a
// fresh session. The agent always reads the entire corpus — there is no
// access scoping. `profile` selects the prompt profile: "voice"
// (experimental) styles replies for text-to-speech while keeping the full
// interactive toolset; the read-only "answer" profile is reserved for the
// `/answer` surface and is deliberately not accepted here.
const sessionCreateBody = z
  .object({
    resumeFromId: z.string().min(1).optional(),
    profile: z.enum(["interactive", "voice"]).optional(),
    // IANA zone of the device the user is talking from. Every wall-clock time
    // the agent utters is rendered in it, so a phone opened abroad gets its
    // owner's local evening rather than the gateway machine's. Two layers, with
    // different jobs: the schema rejects a malformed *shape* (empty, or longer
    // than any real zone name), while a well-formed name this runtime cannot
    // resolve is dropped by `normalizeTimeZone` and falls back to the host's
    // zone — an unknown zone is no reason to refuse someone a conversation.
    timeZone: z.string().min(1).max(MAX_TIME_ZONE_LENGTH).optional(),
  })
  .strict();

// 64 KiB is generous for a user message (10k-char cap on the text field —
// the JSON envelope around it is small). Anything larger is either a
// misconfigured client or a probe; rejecting at the body layer keeps the
// later zod parse fast and the writer queue safe.
const AGENT_BODY_LIMIT_BYTES = 64 * 1024;

const agentBodyLimit = bodyLimit({
  maxSize: AGENT_BODY_LIMIT_BYTES,
  onError: (c) => {
    return c.json(
      {
        error: `Request body too large (max ${AGENT_BODY_LIMIT_BYTES} bytes)`,
        code: "PAYLOAD_TOO_LARGE",
      },
      413,
    );
  },
});

export interface AgentRoutesDeps {
  /** Undefined when the agent harness isn't enabled; inference and mutation routes 503. */
  agentService?: AgentService;
  /**
   * What a device may be answered from over `/answer`: its access level's
   * Answer rule, or every source under the default policy. Read per request so
   * a level change applies to the next question. Absent in minimal test
   * wirings, where every caller answers under the default.
   */
  deviceAnswerScope?: (deviceId: string, tokenId: string) => DeviceAnswerScope;
  /** Durable conversation reads remain available when inference is unavailable. */
  conversationReader?: ConversationReader;
  /**
   * Per-conversation read state, so the list can say which conversations hold
   * something the operator has not seen and any surface can say it has been
   * seen. Absent ⇒ no conversation is ever unread.
   */
  conversationReadState?: ConversationReadStatePort;
  /** Privacy-reviewed external answer service, swapped with the agent model. */
  answerService?: AnswerService;
  /** Shared reviewer used by both Answer and policy-driven Watch activation. */
  privacyReviewer?: PrivacyReviewer;
  /** Trusted operator facade for policy, approval, and release-audit routes. */
  privacyAdminService?: PrivacyAdminService;
  /**
   * Optional reason the harness is disabled. When `agentService` is
   * undefined and this is set, the 503 carries this text so the portal
   * can show an actionable error (e.g. "configure your Anthropic key
   * under Settings → Models").
   */
  disabledReason?: string;
  /** Current agent config snapshot for the /admin/agent/config status endpoint. */
  agentConfig?: AgentConfigSnapshot;
  /**
   * Live resolver for the model that would answer right now — the
   * current `agent` capability assignment projected to a `ModelDisplay`
   * (provider id + label + friendly model name). Re-resolved on each
   * call so a config change is reflected without a restart. Backs
   * `GET /agent/model`, which the portal and iOS chat surfaces render as
   * a "provider · model" header. Absent only in minimal test wirings.
   */
  agentModelDisplay?: () => ModelDisplay;
  /**
   * The agent integration a paired device is, or null when the device is not
   * one — a phone, the operator's own machine, an unpaired caller.
   *
   * The same question the subscription routes ask before compiling a watch,
   * asked here for a different reason: it decides which audience a session
   * speaks for, and therefore what its tools may show it of other
   * integrations' work. Every real gateway supplies one — see
   * {@link withCallerResolver}. Absent, the routes cannot tell the two
   * audiences apart and answer for nobody rather than guessing.
   */
  harnessOf?: (deviceId: string) => string | null;
  /**
   * Interval between `/agent/events` SSE keep-alive heartbeats, in ms.
   * Defaults to {@link SSE_HEARTBEAT_MS}. A failed heartbeat enqueue is the
   * liveness probe that detects a dead socket when no event is in flight;
   * tests inject a short interval to exercise that teardown path.
   */
  heartbeatMs?: number;
}

/** Agent harness config as seen by the HTTP layer — a static snapshot taken at startup. */
export interface AgentConfigSnapshot {
  backend: string;
  enabled: boolean;
  disabledReason?: string;
}

/**
 * Route deps with the caller resolver guaranteed present.
 *
 * The resolver reads this gateway's device table, so only the server can build
 * one — but the rest of these deps are assembled by the agent lifecycle, which
 * has no database. Composing them anywhere other than here invites exactly the
 * failure this exists to prevent: a gateway that supplies its own deps loses
 * the resolver, `toolCallerOf` finds nothing, and every caller — including an
 * off-host integration — resolves as the operator and reads every watch on the
 * install.
 *
 * The lifecycle mutates this object when an unavailable model recovers or its
 * assignment changes, so preserve its identity. A copy would leave the mounted
 * routes pinned to their boot-time service and disabled reason. A caller that
 * already brought a resolver keeps it; tests rely on that.
 */
export function withCallerResolver(
  deps: AgentRoutesDeps,
  harnessOf: (deviceId: string) => string | null,
): AgentRoutesDeps {
  deps.harnessOf ??= harnessOf;
  return deps;
}

/**
 * Who owns a `/answer` request, what it may be answered from, and the device
 * authority its release is checked against.
 *
 * An integration on an access level is answered under that level's Answer rule —
 * its sources, release mode and privacy policy — and owns its answers under
 * that scope (see `tokenAnswerOwnerId`). A portal session asks with the
 * credential of the device it was opened with, and is governed by that
 * device's level the same way. The operator's own devices get no
 * authorization: every source, reviewed against the default privacy policy,
 * owned by their token alone. An integration on no level, or on one that can
 * no longer answer, is refused rather than answered under the default.
 *
 * Every device request carries its device authority to the release, which
 * reads the level again there: an answer leaves only while its owner still
 * stands. A device request on a gateway without the resolver is refused — it
 * cannot know the device's level, and answering it from every source is the
 * one wrong guess.
 */
function answerCaller(
  deps: AgentRoutesDeps,
  auth: AuthContext,
): {
  ownerId: string;
  corpusAuthorization?: CorpusAuthorization;
  deviceAnswerAuthority?: DeviceAnswerAuthority;
} {
  const tokenId = auth.tokenId;
  if (!tokenId) throw new BadRequestError("missing token id");
  const deviceId = auth.authMethod === "portal-session" ? auth.credentialDeviceId : auth.deviceId;
  if (!deviceId) return { ownerId: tokenAnswerOwnerId(tokenId) };
  if (!deps.deviceAnswerScope) {
    throw new ServiceUnavailableError("device answer access is not configured on this gateway");
  }
  const scope = deps.deviceAnswerScope(deviceId, tokenId);
  if (scope.kind === "unassigned") {
    throw new HttpError(
      403,
      "ACCESS_LEVEL_REQUIRED",
      "This integration has no access level yet. Choose one on the portal's Devices page.",
    );
  }
  if (scope.kind === "unavailable") {
    throw new HttpError(
      403,
      "ACCESS_LEVEL_UNAVAILABLE",
      "This device's access level can no longer answer questions.",
    );
  }
  const deviceAnswerAuthority = { deviceId, tokenId };
  return scope.kind === "level"
    ? {
        ownerId: tokenAnswerOwnerId(tokenId, scope.authorization),
        corpusAuthorization: scope.authorization,
        deviceAnswerAuthority,
      }
    : { ownerId: tokenAnswerOwnerId(tokenId), deviceAnswerAuthority };
}

export function mountAgentRoutes(app: RouteApp, deps: AgentRoutesDeps): void {
  const requireService = (): AgentService => {
    if (!deps.agentService) {
      const reason = deps.disabledReason ?? "Agent harness not enabled on this gateway.";
      throw new ServiceUnavailableError(reason);
    }
    return deps.agentService;
  };

  const requireConversationReader = (): ConversationReader => {
    if (deps.agentService) return deps.agentService;
    if (deps.conversationReader) return deps.conversationReader;
    return requireService();
  };

  const requireConversationListReader = (): ConversationReader =>
    deps.conversationReader ?? requireConversationReader();

  const requireAnswerService = (): AnswerService => {
    if (!deps.answerService) {
      const reason = deps.disabledReason ?? "Agent harness not enabled on this gateway.";
      throw new ServiceUnavailableError(reason);
    }
    return deps.answerService;
  };
  const answerNoStore = async (
    c: { header: (name: string, value: string) => void },
    next: () => Promise<void>,
  ) => {
    c.header("Cache-Control", "no-store");
    await next();
  };

  // Caller identity — the token id, scoped under `token:` so it never
  // collides with WS-side `device:` callers in the same session map.
  const callerOf = (c: { get: (k: "auth") => { tokenId: string | null } }): string => {
    const auth = c.get("auth");
    if (!auth.tokenId) throw new BadRequestError("missing token id");
    return `token:${auth.tokenId}`;
  };

  /**
   * Which audience a session speaks for.
   *
   * A request arriving on a device that declares itself an agent integration is
   * that integration; everything else — a portal cookie, a phone, an admin
   * token minted for the operator's own use — is the operator. The declaration
   * is the device's own capability rather than anything the request asserts, so
   * a caller cannot name itself into a different audience.
   *
   * Without a resolver there is no such declaration to read, and answering
   * "operator" then is the shape of a bug that already shipped once: a gateway
   * that assembled its own deps lost the resolver, every off-host integration
   * resolved as the operator, and the visibility rule the resolver exists to
   * enforce was unreachable in production. So a missing resolver is not a quiet
   * fallback to the widest audience — it fails closed to nobody and says so.
   */
  const toolCallerOf = (c: { get: (k: "auth") => { deviceId: string | null } }): ToolCaller => {
    if (!deps.harnessOf) {
      log.error(
        "agent routes mounted without a caller resolver — every caller speaks for nobody until the gateway supplies one (see withCallerResolver)",
      );
      return UNATTRIBUTED_CALLER;
    }
    const deviceId = c.get("auth").deviceId;
    const harness = deviceId ? (deps.harnessOf(deviceId) ?? null) : null;
    return harness ? { kind: "integration", slug: harness } : { kind: "operator" };
  };

  // Always responds 200, even when the agent harness is disabled, so
  // consumers can display actionable configuration guidance.
  app.get("/admin/agent/config", scope.admin(), (c) => {
    const cfg = deps.agentConfig ?? { backend: "off" as const, enabled: false };
    return c.json({
      backend: cfg.backend,
      enabled: cfg.enabled,
      disabledReason: cfg.disabledReason ?? null,
    });
  });

  // The model that would respond to the next message — the live `agent`
  // assignment, regardless of what model produced older turns. Always
  // 200 so the chat header renders even when the harness is disabled
  // (then `configured: false`).
  app.get("/agent/model", scope.admin(), (c) => {
    const display: ModelDisplay = deps.agentModelDisplay?.() ?? {
      providerId: "none",
      providerLabel: "Not configured",
      modelName: "",
      available: false,
      configured: false,
    };
    return c.json(display);
  });

  app.post(
    "/answer",
    answerNoStore,
    scope.answer(),
    agentBodyLimit,
    validateJson(answerBody),
    async (c) => {
      const service = requireAnswerService();
      const body = c.req.valid("json");
      try {
        const { ownerId, corpusAuthorization, deviceAnswerAuthority } = answerCaller(
          deps,
          c.get("auth"),
        );
        const egress = await submitAnswerBoundary(
          service,
          ownerId,
          {
            question: body.question,
            clientRequestId: body.clientRequestId ?? `request_${randomUUID()}`,
            workflowId: body.workflowId,
            conversationId: body.conversationId,
            workflowName: body.workflowName,
            workflowPurpose: body.workflowPurpose,
            approvalMode: body.approval ?? "never",
            ...(corpusAuthorization ? { corpusAuthorization } : {}),
            // `/answer` creates a durable, idempotent task. Clients recover a
            // slow or disconnected request by re-posting the same request id or
            // polling its task, so binding generation to this HTTP connection
            // would discard work that remains safe to finish and collect.
          },
          "/answer",
          c.req.raw.signal,
          undefined,
          deviceAnswerAuthority,
        );
        return exactJsonResponse(egress.responseJson);
      } catch (err) {
        throw mapAnswerError(err);
      }
    },
  );

  app.get("/answer/tasks/:id", answerNoStore, scope.answer(), async (c) => {
    const taskId = c.req.param("id");
    if (!taskId) throw new BadRequestError("task id required");
    try {
      const service = requireAnswerService();
      // A poll reads a stored outcome and reviews nothing, but it reads under
      // the scope the device answers under now: an answer made under another
      // scope is not this caller's to collect.
      const { ownerId, deviceAnswerAuthority } = answerCaller(deps, c.get("auth"));
      const egress = await getAnswerBoundary(
        service,
        taskId,
        ownerId,
        "/answer/tasks/:id",
        c.req.raw.signal,
        undefined,
        deviceAnswerAuthority,
      );
      return exactJsonResponse(egress.responseJson);
    } catch (err) {
      throw mapAnswerError(err);
    }
  });
  app.post("/agent/sessions", scope.admin(), agentBodyLimit, async (c) => {
    const service = requireService();
    const body = await parseSessionCreateBody(c);
    // Validate every query input before createSession can mint or resume
    // anything. A malformed pagination request must be side-effect free.
    const transcriptLimit = parseTranscriptLimit(c.req.query("transcriptLimit"), 0);
    try {
      const result = await service.createSession(callerOf(c), {
        resumeFromId: body.resumeFromId,
        profile: body.profile,
        timeZone: normalizeTimeZone(body.timeZone),
        caller: toolCallerOf(c),
      });
      log.info(
        `agent session ${result.sessionId} ${body.resumeFromId ? "resumed" : "created"} (${result.backend}/${result.model})`,
      );
      if (transcriptLimit !== undefined) {
        const page = paginateVisibleConversationMessages(
          result.messages,
          result.origin,
          transcriptLimit,
        );
        const nextCursor =
          page.hasMore && page.nextBefore !== null
            ? encodePageCursor("agent-conversation-messages", {
                conversationId: result.sessionId,
                before: page.nextBefore,
              })
            : undefined;
        return c.json({
          ...result,
          conversationId: result.sessionId,
          messages: page.messages,
          messageCount: page.messageCount,
          messagesAreVisible: true,
          messagePageInfo: buildPage([], {
            hasMore: page.hasMore,
            limit: transcriptLimit,
            nextCursor,
          }).pageInfo,
        });
      }
      // The session id doubles as the durable conversation id; surface it
      // under both names so clients that hold the conversation for a later
      // resume (or a push deep-link) read the field the contract names.
      return c.json({ ...result, conversationId: result.sessionId });
    } catch (err) {
      throw mapAgentError(err);
    }
  });

  app.get("/agent/conversations", scope.admin(), async (c) => {
    const service = requireConversationListReader();
    // Ensure the caller really is admin-scope and has a token id —
    // callerOf throws BadRequest if not — but the listing is global.
    callerOf(c);
    try {
      const page = await service.listConversationPage({
        limit: parseConversationLimit(c.req.query("limit")),
        cursor: c.req.query("cursor"),
      });
      return c.json(annotateUnread(page, deps.conversationReadState));
    } catch (err) {
      throw mapAgentError(err);
    }
  });

  app.get("/agent/conversations/:id", scope.admin(), async (c) => {
    const service = requireConversationReader();
    callerOf(c);
    const id = c.req.param("id");
    if (!id) throw new BadRequestError("conversation id required");
    const rec = await service.loadConversation(id);
    if (!rec) throw new NotFoundError(`no conversation ${id}`);
    return c.json(rec);
  });

  app.get("/agent/conversations/:id/messages", scope.admin(), async (c) => {
    const service = requireConversationReader();
    callerOf(c);
    const id = c.req.param("id");
    if (!id) throw new BadRequestError("conversation id required");
    const limit = parseTranscriptLimit(c.req.query("limit"), 1) ?? 50;
    const before = decodePageCursor(
      c.req.query("cursor"),
      "agent-conversation-messages",
      (payload) => {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
        const value = payload as Record<string, unknown>;
        if (
          value.conversationId !== id ||
          typeof value.before !== "number" ||
          !Number.isSafeInteger(value.before) ||
          value.before < 0
        ) {
          return null;
        }
        return value.before;
      },
    );
    const page = await service.listConversationMessages(id, {
      limit,
      ...(before !== null ? { before } : {}),
    });
    if (!page) throw new NotFoundError(`no conversation ${id}`);
    const nextCursor =
      page.hasMore && page.nextBefore !== null
        ? encodePageCursor("agent-conversation-messages", {
            conversationId: id,
            before: page.nextBefore,
          })
        : undefined;
    return c.json({
      messages: page.messages,
      messagePageInfo: buildPage([], {
        hasMore: page.hasMore,
        limit,
        nextCursor,
      }).pageInfo,
      messageCount: page.messageCount,
      messagesAreVisible: true,
      model: page.model,
      backend: page.backend,
      ...(page.origin ? { origin: page.origin } : {}),
      ...(page.terminalFailure ? { terminalFailure: page.terminalFailure } : {}),
      ...(page.lastTurnFailure ? { lastTurnFailure: page.lastTurnFailure } : {}),
    });
  });

  app.patch(
    "/agent/conversations/:id",
    scope.admin(),
    validateJson(conversationPatchBody),
    async (c) => {
      const service = requireService();
      callerOf(c);
      const id = c.req.param("id");
      if (!id) throw new BadRequestError("conversation id required");
      const body = c.req.valid("json") as z.infer<typeof conversationPatchBody>;
      const ok = await service.setConversationPinned(id, body.pinned);
      if (!ok) throw new NotFoundError(`no conversation ${id}`);
      return c.json({ ok: true });
    },
  );

  // "The operator has this conversation on screen." Distinct from any GET:
  // fetching a transcript is what a background sync does, and syncing is not
  // reading. Only a surface that actually rendered the conversation may say
  // this, and saying it clears the unread marker for every other surface too.
  //
  // The id is not resolved first. Marking is idempotent and deletes rather
  // than inserts, so a mark naming a conversation that does not exist writes
  // nothing — and the route is called on a timer by every surface showing a
  // conversation, which is not worth a transcript read each time. A gateway
  // with no read state answers the same shape and simply keeps none.
  app.post(
    "/agent/conversations/:id/seen",
    scope.admin(),
    validateJson(conversationSeenBody),
    async (c) => {
      callerOf(c);
      const id = c.req.param("id");
      if (!id) throw new BadRequestError("conversation id required");
      const body = c.req.valid("json") as z.infer<typeof conversationSeenBody>;
      await deps.conversationReadState?.markSeen(id, { viewing: body.viewing ?? true });
      return c.json({ ok: true });
    },
  );

  app.delete("/agent/conversations/:id", scope.admin(), async (c) => {
    const service = requireService();
    callerOf(c);
    const id = c.req.param("id");
    if (!id) throw new BadRequestError("conversation id required");
    try {
      const ok = await service.deleteConversation(id);
      if (!ok) throw new NotFoundError(`no conversation ${id}`);
      return c.json({ ok: true });
    } catch (err) {
      throw mapAnswerError(err);
    }
  });

  app.post(
    "/agent/sessions/:id/messages",
    scope.admin(),
    agentBodyLimit,
    validateJson(messageBody),
    (c) => {
      const service = requireService();
      const sessionId = c.req.param("id");
      if (!sessionId) throw new BadRequestError("session id required");
      const body = c.req.valid("json") as z.infer<typeof messageBody>;
      // A Deep Research turn never arms the slow-answer watcher, so accepting
      // both flags would silently break the notifyAfterMs promise. Refuse the
      // combination outright.
      if (body.deepResearch === true && body.notifyAfterMs !== undefined) {
        throw new BadRequestError(
          "deepResearch and notifyAfterMs are mutually exclusive — a Deep Research turn does not deliver a slow-answer push.",
        );
      }
      if (body.deepResearch === true && body.viewingForMs !== undefined) {
        throw new BadRequestError(
          "deepResearch and viewingForMs are mutually exclusive — a bounded voice surface cannot present a Deep Research turn.",
        );
      }
      try {
        const result = service.sendMessage(callerOf(c), sessionId, body.text, {
          deepResearch: body.deepResearch === true,
          notifyAfterMs: body.notifyAfterMs,
        });
        // `sendMessage` accepts/starts the turn synchronously; its completion
        // is asynchronous. Establish the bounded presentation lease after
        // acceptance (so a rejected send cannot suppress somebody else's
        // answer) and before the event loop can run turn completion.
        if (body.viewingForMs !== undefined) {
          deps.conversationReadState?.expectContentViewed(
            sessionId,
            result.messageId,
            body.viewingForMs,
          );
        }
        return c.json(result);
      } catch (err) {
        throw mapAgentError(err);
      }
    },
  );

  app.post("/agent/sessions/:id/cancel", scope.admin(), agentBodyLimit, (c) => {
    const service = requireService();
    const sessionId = c.req.param("id");
    if (!sessionId) throw new BadRequestError("session id required");
    try {
      const result = service.cancelSession(callerOf(c), sessionId);
      return c.json(result);
    } catch (err) {
      throw mapAgentError(err);
    }
  });

  // SSE event stream. The portal opens one EventSource here per agent view
  // and demultiplexes events by sessionId client-side. Auth: standard admin
  // scope via cookie or bearer — same as the command routes.
  app.get("/agent/events", scope.admin(), (c) => {
    const service = requireService();
    const callerId = callerOf(c);
    const encoder = new TextEncoder();
    // Resume point: the standard SSE `Last-Event-ID` header on auto-reconnect,
    // with a `?since=` query fallback for clients that can't set the header.
    // Parsed to a finite number or left undefined (fresh attach, no replay).
    const sinceSeq = parseLastEventId(c.req.header("Last-Event-ID") ?? c.req.query("since"));

    const stream = new ReadableStream({
      start(controller) {
        let closed = false;
        let hbTimer: ReturnType<typeof setInterval> | undefined;
        let unsubscribe: () => void = () => {};
        const signal = c.req.raw.signal;

        // Tear down once: stop the heartbeat, drop the subscriber, and end the
        // stream. Idempotent — reachable from the client-abort signal, a
        // failed `enqueue` (a half-dead socket the abort signal never fires
        // for), or both. Passing `err` errors the stream rather than closing
        // it cleanly, so the client's EventSource sees `onerror` and runs its
        // reconnect/backoff instead of freezing on a live-but-dead stream.
        const teardown = (err?: unknown): void => {
          if (closed) return;
          closed = true;
          if (hbTimer) {
            clearInterval(hbTimer);
            hbTimer = undefined;
          }
          unsubscribe();
          try {
            if (err !== undefined) controller.error(err);
            else controller.close();
          } catch {
            /* already closed */
          }
        };

        // `seq` is the event's monotonic id; emitted as the SSE `id:` field
        // so the client's next reconnect can resume past it via
        // `Last-Event-ID`. A `seq` of 0 (control events like `agent.resync`)
        // carries no resumable position, so its `id:` line is omitted.
        const send = (seq: number, data: unknown): void => {
          if (closed) return;
          const frame =
            seq > 0
              ? `id: ${seq}\ndata: ${JSON.stringify(data)}\n\n`
              : `data: ${JSON.stringify(data)}\n\n`;
          try {
            controller.enqueue(encoder.encode(frame));
          } catch (err) {
            // The socket is gone. The abort signal may never fire for a
            // half-dead connection, so tear down here — otherwise the
            // subscriber and heartbeat timer leak (eventually exhausting the
            // per-caller listener cap) and the live stream wedges forever.
            teardown(err);
          }
        };
        const heartbeat = (): void => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`: hb\n\n`));
          } catch (err) {
            // A failed heartbeat is the liveness probe: it detects a dead
            // socket within SSE_HEARTBEAT_MS even when no event is in flight.
            teardown(err);
          }
        };
        // Send an initial comment so the browser flushes headers and treats
        // the stream as open before the first event arrives.
        heartbeat();
        // `subscribe` replays any buffered events past `sinceSeq` through
        // `send` synchronously before attaching the live listener, so a
        // reconnect with `Last-Event-ID` loses nothing.
        unsubscribe = service.subscribe(callerId, send, sinceSeq);
        hbTimer = setInterval(heartbeat, deps.heartbeatMs ?? SSE_HEARTBEAT_MS);

        // Race: a client can disconnect before the ReadableStream's
        // `start()` callback runs. If the signal is already aborted, fire
        // cleanup synchronously — otherwise the heartbeat timer and the
        // subscriber registration leak until the gateway exits.
        if (signal?.aborted) {
          teardown();
        } else {
          signal?.addEventListener("abort", () => teardown());
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });
}

/**
 * Parse a `Last-Event-ID` header / `?since=` value into a finite,
 * non-negative sequence number. Anything malformed (absent, non-numeric,
 * negative) yields `undefined` — treated as a fresh attach with no replay.
 */
function parseLastEventId(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

function parseConversationLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    throw new BadRequestError("conversation list limit must be a positive integer");
  }
  return Math.floor(n);
}

/**
 * `minimum` is what separates the two endpoints that take a transcript
 * limit. On session create, zero is meaningful: it asks for the
 * transcript's shape (its length, and a cursor into it) without any of
 * its messages — see {@link paginateVisibleConversationMessages}.
 * Omitting the parameter entirely is what means "no cap" there.
 *
 * The transcript-paging endpoint keeps a minimum of one, because a page
 * of nothing is not a page: it would hand back a cursor equal to the one
 * it was given, and a client looping on `hasMore` would never advance.
 */
function parseTranscriptLimit(raw: string | undefined, minimum: 0 | 1): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < minimum || n > 500) {
    throw new BadRequestError(`transcript limit must be an integer from ${minimum} to 500`);
  }
  return n;
}

function mapAgentError(err: unknown): Error {
  if (err instanceof AgentError) {
    if (err.code === "session_not_found") return new NotFoundError(err.message);
    if (err.code === "forbidden") return new ForbiddenError(err.message);
    if (err.code === "context_window_exceeded") {
      return new HttpError(409, "CONTEXT_WINDOW_EXCEEDED", err.message);
    }
    return new BadRequestError(err.message);
  }
  return err instanceof Error ? err : new Error(String(err));
}

export function mapAnswerError(err: unknown): Error {
  if (err instanceof AnswerCapacityError) {
    // Its own code, distinct from a gateway that is simply unavailable.
    // "The turn limit is full, ask again shortly" and "this gateway is not
    // serving" are both 503s and want opposite responses from a caller: the
    // first is worth waiting out, the second is not. Without a code to tell
    // them apart a client has to guess, and guessing wrong either abandons
    // work that was about to be done or waits out a gateway that is down.
    return new HttpError(503, "ANSWER_CAPACITY", err.message);
  }
  if (err instanceof AnswerCandidateLimitError) return new BadGatewayError(err.message);
  // Distinct from a plain 409 so a caller can tell "the turn you asked for is
  // still running, ask again" apart from a conflict it can never resolve by
  // waiting. Re-posting the same request id attaches to this task rather than
  // starting a second agent turn, so polling on this code costs nothing.
  if (err instanceof AnswerTaskInProgressError) {
    return new HttpError(409, "ANSWER_IN_PROGRESS", err.message, { taskId: err.taskId });
  }
  if (err instanceof AnswerStoreError) {
    if (err.code === "egress_limit") {
      return new HttpError(429, "ANSWER_EGRESS_LIMIT", err.message);
    }
    if (err.code === "authority_changed") {
      return new HttpError(403, "ANSWER_ACCESS_CHANGED", err.message);
    }
    if (
      err.code === "workflow_not_found" ||
      err.code === "conversation_not_found" ||
      err.code === "conversation_deleted" ||
      err.code === "task_not_found" ||
      err.code === "owner_mismatch"
    ) {
      return new NotFoundError(err.message);
    }
    return new ConflictError(err.message);
  }
  if (err instanceof AgentError) {
    if (err.code === "session_not_found") return new NotFoundError(err.message);
    if (err.code === "session_busy") return new ConflictError(err.message);
    if (err.code.startsWith("answer_")) return new BadGatewayError(err.message);
  }
  return mapAgentError(err);
}

export function exactJsonResponse(json: string): Response {
  return new Response(json, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Body is optional for /agent/sessions (a fresh session has none); when
 * present it must match `sessionCreateBody` exactly. Reject malformed
 * JSON and unknown fields with a 400 so client bugs surface loudly
 * rather than silently being treated as "no body".
 */
async function parseSessionCreateBody(c: {
  req: { header(name: string): string | undefined; text(): Promise<string> };
}): Promise<z.infer<typeof sessionCreateBody>> {
  const contentType = c.req.header("content-type") ?? "";
  let raw: string;
  try {
    raw = await c.req.text();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new BadRequestError("could not read request body");
  }
  if (raw.length === 0) return {};
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new BadRequestError("expected application/json body");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestError("malformed JSON in request body");
  }
  const result = sessionCreateBody.safeParse(parsed);
  if (!result.success) {
    throw new BadRequestError(
      `invalid request body: ${result.error.issues[0]?.message ?? "validation failed"}`,
    );
  }
  return result.data;
}
