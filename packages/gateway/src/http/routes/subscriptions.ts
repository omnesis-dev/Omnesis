// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { createLogger, experimentalVisible } from "@omnesis/core";
import { refusalSentence } from "@omnesis/watch";
import { bodyLimit } from "hono/body-limit";
import {
  SubscriptionServiceError,
  type SubscriptionCaller,
  type SubscriptionService,
} from "../../subscriptions/service.js";
import { DEFAULT_SUBSCRIPTION_EVALUATION_LIMIT } from "../../subscriptions/store-queries.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  HttpError,
  NotFoundError,
  ServiceUnavailableError,
} from "../errors.js";
import {
  createSubscriptionSchema,
  subscriptionApprovalDecisionSchema,
  subscriptionFiringAnswerSchema,
  subscriptionFiringOutcomeSchema,
  updateSubscriptionSchema,
} from "../schemas/subscriptions.js";
import { scope } from "../scope.js";
import { validateJson } from "../validate.js";
import { exactJsonResponse, mapAnswerError } from "./agent.js";
import type { CompilesInFlight } from "../../watch/in-flight-requests.js";
import type { z } from "zod";
import type { Context } from "hono";
import type { AuthorWatchRequest, AuthorWatchResult } from "../../watch/authoring.js";
import type { AnswerService } from "../../privacy/answer-service.js";
import type { AppEnv, RouteApp } from "./types.js";

const log = createLogger("gateway:http").child("routes:subscriptions");

/**
 * Identity of one firing answer: the firing, the question, and the conversation
 * it continues. Not the caller's `clientRequestId` — that field stays accepted
 * for wire compatibility but never decides identity here.
 *
 * A firing answer costs a full agent turn — corpus search plus several model
 * round-trips — and runs long enough that callers give up on the socket while
 * the gateway is still working, then ask again. Whether that repeat costs a
 * second turn cannot be left to the caller's choice of key: an agent inventing
 * one per attempt buys a fresh turn every time and strands the answer the first
 * turn produced, and an agent reusing one across a reworded question earns an
 * idempotency conflict instead of an answer. Both failures disappear once the
 * ask itself is the key.
 *
 * Collapsing repeats is what the caller wants of a repeat: an agent asking the
 * identical question about the identical firing is waiting on the turn already
 * running, not requesting a second opinion. Because this key is derived from
 * the same inputs the store fingerprints, a key reused with different inputs is
 * unreachable rather than an error. A caller that genuinely wants the corpus
 * re-read asks a different question, which is a different key.
 */
function firingAnswerRequestId(
  firingId: string,
  question: string,
  conversationId: string | undefined,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([firingId, question, conversationId ?? null]), "utf8")
    .digest("hex");
  return `subscription_${digest.slice(0, 48)}`;
}

export interface SubscriptionRoutesDeps {
  service?: SubscriptionService;
  /**
   * Whether the gateway is still willing to start a compile.
   *
   * The same object the authoring layer coalesces on, read rather than owned,
   * so "open" here and "will actually run" there cannot disagree.
   */
  compiles?: Pick<CompilesInFlight, "open">;
  /** Getter because model reconfiguration hot-swaps the live AnswerService. */
  getAnswerService?: () => AnswerService | undefined;
  /**
   * Turn an integration's request into a Watch V2 watch that wakes it back.
   *
   * The creation path once the first engine is retired. The record it produces
   * is the same shape as any other subscription — same approval, same grant,
   * same ledger, same listings — and the only thing that changed is which
   * engine decides when it fires. Absent on a gateway with no Watch V2 runtime,
   * which is the one case where creation genuinely has nowhere to go.
   */
  authorWatch?: (input: AuthorWatchRequest) => Promise<AuthorWatchResult>;
  /**
   * The harness a paired agent device holds, or null when it holds none.
   *
   * The watch records the harness rather than the device id, so it keeps
   * waking the same agent after a re-pair. A caller with no harness cannot be
   * the target of a wake, and asking is how that is discovered before a watch
   * is compiled rather than after.
   */
  harnessOf?: (deviceId: string) => string | null;
  /**
   * Remove the Watch V2 watch a revoked record was the front of, if it was one
   * an integration asked for. Without it the definition keeps evaluating after
   * its record is gone — waking nobody, since a revoked anchor refuses a
   * firing, but spending judge budget on a watch its owner believes they
   * deleted.
   */
  retireAuthoredWatch?: (subscriptionId: string, revision: number) => Promise<void>;
}

function caller(auth: { deviceId: string | null; tokenId: string | null }): SubscriptionCaller {
  if (!auth.deviceId) throw new HttpError(403, "DEVICE_REQUIRED", "A paired device is required.");
  return { deviceId: auth.deviceId, tokenId: auth.tokenId };
}

function mapError(err: unknown): never {
  if (err instanceof SubscriptionServiceError) {
    if (err.code === "semantic_unavailable" || err.code === "watch_unavailable") {
      throw new ServiceUnavailableError(err.message);
    }
    if (err.code === "not_found") throw new NotFoundError(err.message);
    if (
      err.code === "answer_authority_unavailable" ||
      err.code === "outcome_authority_unavailable"
    ) {
      throw new ForbiddenError(err.message);
    }
    if (
      err.code === "idempotency_conflict" ||
      err.code === "terminal" ||
      err.code === "not_terminal" ||
      err.code === "grant_unavailable" ||
      err.code === "approval_resolved" ||
      err.code === "stale_revision" ||
      err.code === "policy_changed"
    ) {
      throw new ConflictError(err.message);
    }
    if (
      err.code === "workflow_unavailable" ||
      err.code === "invalid_update" ||
      err.code === "invalid_cursor"
    ) {
      throw new BadRequestError(err.message);
    }
    if (err.code === "approval_expired") {
      throw new HttpError(410, "SUBSCRIPTION_APPROVAL_EXPIRED", err.message);
    }
  }
  throw err;
}

/**
 * Create the watch an integration asked for, on the Watch V2 runtime.
 *
 * The request is the same one the first engine took, and so is the record that
 * comes back — the compile happens against a different engine, and the caller
 * is not told which, because which engine evaluates a condition is not
 * something an agent can act on.
 *
 * Whom it wakes is the **authenticated caller**, never a value from the body.
 * An agent that could name the device to wake could ask to be woken as another
 * one, and a wake is what carries a firing's evidence.
 */
async function createOnWatchV2(
  c: Context<AppEnv>,
  deps: SubscriptionRoutesDeps,
  request: z.infer<typeof createSubscriptionSchema>,
): Promise<Response> {
  const author = deps.authorWatch;
  if (!author) {
    throw new ServiceUnavailableError("This gateway cannot create watches right now.");
  }
  const service = deps.service;
  if (!service) throw new ServiceUnavailableError("Watches are unavailable.");
  if (deps.compiles && !deps.compiles.open) {
    // Before anything else, because everything else here is expensive. A
    // compile runs for minutes and a deploy takes seconds, so a restart landing
    // mid-compile is ordinary — and one accepted now reaches its caller as a
    // dropped connection, which an agent reads as a broken feature and answers
    // by asking again in different words. That is a different idempotency key
    // by design, so the duplicate guard never fires and one intent becomes
    // several watches.
    throw new ServiceUnavailableError(
      "This gateway is restarting and did not start compiling. Ask again in a moment.",
    );
  }
  const { deviceId } = caller(c.get("auth"));
  // Before compiling, not after. A compile costs tens of seconds and a model
  // call, and the definition is installed before the record exists — so a
  // transport retry that got as far as compiling would leave a watch behind
  // whether or not the record deduplicated.
  const replayed = service.replayedRequest({ deviceId, tokenId: null }, request);
  if (replayed) return c.json({ subscription: replayed }, 201);
  const harness = deps.harnessOf?.(deviceId) ?? null;
  if (harness === null) {
    // Checked before compiling, not after: a watch that cannot wake its author
    // is not worth tens of seconds and a model call to write.
    throw new HttpError(
      403,
      "DEVICE_REQUIRED",
      "Only a paired agent integration can ask for a watch that wakes it.",
    );
  }
  if (request.reaction.kind !== "agent-workflow") {
    // Unreachable through the HTTP schema, which pins the reaction. Stated
    // anyway because the alternative is an iOS push aimed at an agent.
    throw new HttpError(400, "REACTION_UNSUPPORTED", "A watch wakes an agent workflow.");
  }
  const result = await author({
    request: request.condition.description,
    delivery: {
      kind: "agent-wake",
      wake: { kind: "device", deviceId, harness },
      instruction: request.reaction.instruction,
      // Absent rather than empty when the caller bound nothing: bindings join
      // the anchor's identity, so an empty map would make a watch asking for
      // no referents look different from one authored before they existed.
      ...(request.reaction.bindings && Object.keys(request.reaction.bindings).length > 0
        ? { bindings: request.reaction.bindings }
        : {}),
      idempotencyKey: request.idempotencyKey,
    },
    authoredBy: "integration",
    // The whole call is idempotent on this, not only the record at the end of
    // it: a retry that already compiled and installed finds its own watch and
    // finishes arming it, rather than writing a second one beside the first.
    //
    // Namespaced to the caller, because the key is a name the *client* chose
    // and two integrations can choose the same one. Looked up across every
    // watch on the install, a colliding key would hand the second caller the
    // first's watch — retiring its anchor, minting a replacement on the
    // second's device, and waking it with the first's instruction. The same
    // scoping `replayedRequest` applies to the record itself.
    requestKey: `${deviceId}\u0000${request.idempotencyKey}`,
  });
  if (result.status === "timed-out") {
    // 503, not the 422 a refusal gets: nothing was decided about the request,
    // and an agent told its condition was unsupported would stop asking.
    throw new ServiceUnavailableError(
      "The model did not finish compiling this watch in time. Try again.",
    );
  }
  if (result.status === "no-compiler") {
    throw new ServiceUnavailableError("This gateway has no model assigned for compiling watches.");
  }
  if (result.status === "refused") {
    // Deliberately the same code an unsupported condition has always returned.
    //
    // What crosses is the closed vocabulary and nothing else. The compiler
    // reads the corpus while it works, so its own words about a refusal can
    // quote what it read — and this response leaves the machine, seen by no
    // reviewer and recorded in no egress ledger. The same shape as the
    // grounding rejection above: the facts stay in the gateway log, and the
    // caller gets an answer built from fixed sentences that are true about
    // their request.
    log.warn(
      `Refused an integration's watch (${result.codes.join(", ")}): ${result.reasons.join("; ")}`,
    );
    throw new HttpError(
      422,
      "SUBSCRIPTION_CONDITION_UNSUPPORTED",
      "That condition could not be compiled into a watch.",
      // `reason` singular as well as `codes`: it is the field this endpoint's
      // 422 has always carried and the one the shipped integration client
      // reads, and a refusal the client cannot classify is a refusal it reports
      // as an unexplained failure. The primary code is the first the compiler
      // gave.
      {
        reason: result.codes[0],
        codes: [...result.codes],
        reasons: result.codes.map(refusalSentence),
      },
    );
  }
  if (result.status === "unarmed") {
    // The watch exists and is held, so nothing is evaluating into a wake
    // nobody receives. A retry of this request converges on it.
    throw new ServiceUnavailableError(
      "The watch was created but could not be wired to wake you, so it is held. Ask again, or ask the operator to check that this agent is paired.",
    );
  }
  if (result.status === "conflict") {
    // The caller's own idempotency key already names a watch, and this request
    // asks for a different one. Retrying it unchanged cannot settle, so the
    // answer says what collided rather than reporting a fault.
    throw new ConflictError(result.because);
  }
  if (result.anchorSubscriptionId === null) {
    // The watch is installed and evaluating; nothing will hear it fire. That is
    // a broken create, not a partial success, and saying so is what lets the
    // caller ask again rather than wait forever on a wake nobody will send.
    throw new ServiceUnavailableError(
      "The watch was created but could not be wired to wake you. Ask the operator to check that this agent is paired.",
    );
  }
  return c.json(
    { subscription: service.get({ deviceId, tokenId: null }, result.anchorSubscriptionId) },
    201,
  );
}

export function mountSubscriptionRoutes(app: RouteApp, deps: SubscriptionRoutesDeps): void {
  const requireFeature = async (_c: unknown, next: () => Promise<void>): Promise<void> => {
    if (!experimentalVisible()) throw new NotFoundError("Not found");
    await next();
  };
  const requireService = (): SubscriptionService => {
    if (!deps.service) {
      throw new ServiceUnavailableError("Subscriptions are not available on this gateway.");
    }
    return deps.service;
  };
  const noStore = async (
    c: { header: (name: string, value: string) => void },
    next: () => Promise<void>,
  ) => {
    c.header("Cache-Control", "no-store");
    await next();
  };
  const answerBodyLimit = bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) =>
      c.json(
        {
          error: "Request body too large (max 65536 bytes)",
          code: "PAYLOAD_TOO_LARGE",
        },
        413,
      ),
  });
  // A report is prose about work, not a document: a smaller ceiling than the
  // Answer body, and comfortably above anything a run has to say.
  const outcomeBodyLimit = bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) =>
      c.json(
        {
          error: "Request body too large (max 16384 bytes)",
          code: "PAYLOAD_TOO_LARGE",
        },
        413,
      ),
  });
  const limit = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
      throw new BadRequestError("Invalid limit.");
    }
    return parsed;
  };

  app.post(
    "/subscriptions",
    requireFeature,
    noStore,
    scope.subscriptionsManage(),
    validateJson(createSubscriptionSchema),
    async (c) => {
      try {
        // One engine compiles every request. The record it produces is the
        // same shape any subscription has — same approval, same grant, same
        // ledger, same listings — so nothing downstream needs to know which
        // path a watch arrived by, because there is only one.
        return await createOnWatchV2(c, deps, c.req.valid("json"));
      } catch (err) {
        return mapError(err);
      }
    },
  );
  app.get("/subscriptions", requireFeature, noStore, scope.subscriptionsManage(), (c) => {
    return c.json({ subscriptions: requireService().list(caller(c.get("auth"))) });
  });
  app.get("/subscriptions/:id", requireFeature, noStore, scope.subscriptionsManage(), (c) => {
    try {
      return c.json({
        subscription: requireService().get(caller(c.get("auth")), c.req.param("id")),
      });
    } catch (err) {
      return mapError(err);
    }
  });
  app.patch(
    "/subscriptions/:id",
    requireFeature,
    noStore,
    scope.subscriptionsManage(),
    validateJson(updateSubscriptionSchema),
    async (c) => {
      try {
        return c.json({
          subscription: await requireService().update(
            caller(c.get("auth")),
            c.req.param("id"),
            c.req.valid("json"),
          ),
        });
      } catch (err) {
        return mapError(err);
      }
    },
  );
  app.delete(
    "/subscriptions/:id",
    requireFeature,
    noStore,
    scope.subscriptionsManage(),
    async (c) => {
      try {
        const subscription = await requireService().revoke(
          caller(c.get("auth")),
          c.req.param("id"),
        );
        // After the revoke, not before: a revoke that failed must leave the
        // watch running, and the record is the authority on whether it did.
        await deps.retireAuthoredWatch?.(subscription.id, subscription.revision);
        return c.json({ subscription });
      } catch (err) {
        return mapError(err);
      }
    },
  );

  app.post(
    "/subscriptions/firings/:id/answer",
    requireFeature,
    noStore,
    scope.subscriptionsAnswer(),
    answerBodyLimit,
    validateJson(subscriptionFiringAnswerSchema),
    async (c) => {
      const answerService = deps.getAnswerService?.();
      if (!answerService) {
        throw new ServiceUnavailableError("Agent harness not enabled on this gateway.");
      }
      const authCaller = caller(c.get("auth"));
      const firingId = c.req.param("id");
      const body = c.req.valid("json");
      try {
        const authority = await requireService().authorizeFiringAnswer(authCaller, firingId);
        const result = await answerService.answer({
          ownerId: authority.ownerId,
          workflowId: authority.workflowId,
          ...(authority.firingEvidence.kind === "documents"
            ? { evidenceDocumentIds: authority.evidenceDocumentIds }
            : { firingEvidence: authority.firingEvidence }),
          subscriptionFiringId: firingId,
          question: body.question,
          clientRequestId: firingAnswerRequestId(firingId, body.question, body.conversationId),
          conversationId: body.conversationId,
          // Where an approved answer goes when it could not be released to
          // this request. The device is the **authenticated** one, never a
          // value from the body: the handle says which conversation to resume,
          // and the identity of who may be resumed is not the caller's to
          // assert. Omitted entirely when no handle was supplied, because the
          // store creates a completion delivery only for a complete route.
          ...(body.nativeConversationId === undefined
            ? {}
            : {
                completionRoute: {
                  integrationDeviceId: authCaller.deviceId,
                  nativeConversationId: body.nativeConversationId,
                },
              }),
          // Deliberately not `c.req.raw.signal`. A firing answer runs a full
          // agent turn, and the caller polls: it re-POSTs the same ask, whose
          // identity is derived from (firing, question, conversation), so a
          // repeat attaches to this task rather than starting a second turn.
          // Binding the turn to one HTTP request's lifetime would destroy work
          // the very next poll is coming back to collect — and the turn is
          // paid for the moment it starts, so cancelling saves nothing while
          // losing an answer that may already be through the reviewer.
        });
        // Revalidation + exact task/firing binding + egress ledger commit are
        // one writer transaction, closing revocation races.
        const egress = await requireService().finalizeFiringAnswerEgress(authCaller, {
          firingId,
          taskId: result.taskId,
          ownerId: authority.ownerId,
        });
        return exactJsonResponse(egress.responseJson);
      } catch (err) {
        try {
          return mapError(err);
        } catch (mapped) {
          throw mapAnswerError(mapped);
        }
      }
    },
  );

  /**
   * What the woken run did.
   *
   * The counterpart to the wake, and the only thing that makes a firing's
   * silence legible: without it the gateway's knowledge ends at "the harness
   * accepted the delivery", and a run that did nothing is indistinguishable
   * from one that did everything. Nothing leaves the sandbox here, so unlike
   * its Answer sibling it consults no policy and holds no egress ledger — it
   * records an account of work already done.
   */
  app.post(
    "/subscriptions/firings/:id/outcome",
    requireFeature,
    noStore,
    scope.subscriptionsOutcome(),
    outcomeBodyLimit,
    validateJson(subscriptionFiringOutcomeSchema),
    async (c) => {
      const authCaller = caller(c.get("auth"));
      const body = c.req.valid("json");
      try {
        const recorded = await requireService().recordFiringOutcome(authCaller, {
          firingId: c.req.param("id"),
          status: body.status,
          ...(body.report === undefined ? {} : { report: body.report }),
        });
        return c.json({ status: "recorded", runs: recorded.runs });
      } catch (err) {
        return mapError(err);
      }
    },
  );

  app.get("/admin/privacy/subscription-approvals", requireFeature, noStore, scope.admin(), (c) => {
    const rawStatus = c.req.query("status");
    const status =
      rawStatus === "pending" ||
      rawStatus === "approved" ||
      rawStatus === "denied" ||
      rawStatus === "expired"
        ? rawStatus
        : undefined;
    if (rawStatus && !status) throw new BadRequestError("Invalid approval status.");
    try {
      return c.json(
        requireService().listApprovalPage(
          status,
          limit(c.req.query("limit"), 100),
          c.req.query("cursor") || undefined,
        ),
      );
    } catch (err) {
      return mapError(err);
    }
  });
  app.get(
    "/admin/privacy/subscription-approvals/:id",
    requireFeature,
    noStore,
    scope.admin(),
    (c) => {
      try {
        return c.json({ approval: requireService().getDecidableApproval(c.req.param("id")) });
      } catch (err) {
        return mapError(err);
      }
    },
  );
  app.post(
    "/admin/privacy/subscription-approvals/:id/resolve",
    requireFeature,
    noStore,
    scope.admin(),
    validateJson(subscriptionApprovalDecisionSchema),
    async (c) => {
      try {
        return c.json({
          approval: await requireService().resolveApproval(
            c.get("auth"),
            c.req.param("id"),
            c.req.valid("json").decision,
          ),
        });
      } catch (err) {
        return mapError(err);
      }
    },
  );
  for (const decision of ["approve", "deny"] as const) {
    app.post(
      `/admin/privacy/subscription-approvals/:id/${decision}`,
      requireFeature,
      noStore,
      scope.admin(),
      async (c) => {
        try {
          return c.json({
            approval: await requireService().resolveApproval(
              c.get("auth"),
              c.req.param("id"),
              decision,
            ),
          });
        } catch (err) {
          return mapError(err);
        }
      },
    );
  }
  app.get("/admin/privacy/subscriptions", requireFeature, noStore, scope.admin(), (c) => {
    try {
      return c.json(
        requireService().listAll(
          c.req.query("status"),
          limit(c.req.query("limit"), 50),
          c.req.query("cursor"),
        ),
      );
    } catch (err) {
      return mapError(err);
    }
  });
  app.get(
    "/admin/privacy/subscriptions/:id/firings",
    requireFeature,
    noStore,
    scope.admin(),
    (c) => {
      try {
        return c.json(
          requireService().listFirings(
            c.req.param("id"),
            limit(c.req.query("limit"), 50),
            c.req.query("cursor"),
          ),
        );
      } catch (err) {
        return mapError(err);
      }
    },
  );
  // Single-firing read behind the firing history row. Admin-only: it carries
  // the nominated document, the precision verdict and rationale, the
  // delivery's local run identity, and the firing-bound Answer tasks — none of
  // which the subscriber's existence-only surface may ever see. Scoped by the
  // owning subscription id, so a firing id from another subscription 404s.
  app.get(
    "/admin/privacy/subscriptions/:id/firings/:firingId",
    requireFeature,
    noStore,
    scope.admin(),
    (c) => {
      try {
        return c.json({
          firing: requireService().getFiring(c.req.param("id"), c.req.param("firingId")),
        });
      } catch (err) {
        return mapError(err);
      }
    },
  );
  app.get("/admin/privacy/subscriptions/:id", requireFeature, noStore, scope.admin(), (c) => {
    try {
      return c.json({
        subscription: requireService().getTrusted(
          c.req.param("id"),
          limit(c.req.query("limit"), DEFAULT_SUBSCRIPTION_EVALUATION_LIMIT),
        ),
      });
    } catch (err) {
      return mapError(err);
    }
  });
  app.post(
    "/admin/privacy/subscriptions/:id/revoke",
    requireFeature,
    noStore,
    scope.admin(),
    async (c) => {
      try {
        return c.json({
          subscription: await requireService().revokeTrusted(c.req.param("id")),
        });
      } catch (err) {
        return mapError(err);
      }
    },
  );
  // Hard delete. Only a terminal (revoked or expired) watch qualifies — any
  // other status answers 409 and must go through revocation or expiry first,
  // so no single call can make a live watch vanish.
  app.delete(
    "/admin/privacy/subscriptions/:id",
    requireFeature,
    noStore,
    scope.admin(),
    async (c) => {
      try {
        return c.json({
          purged: await requireService().purgeTrusted(c.req.param("id")),
        });
      } catch (err) {
        return mapError(err);
      }
    },
  );
}
