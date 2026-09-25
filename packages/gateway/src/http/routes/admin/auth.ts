// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { buildPage } from "@omnesis/types";
import { scope } from "../../scope.js";
import { validateJson } from "../../validate.js";
import {
  BadGatewayError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from "../../errors.js";
import { friendlyOauthError, renderOauthCallbackPage } from "../../oauth-callback.js";
import {
  authAnswerBody,
  authCodeBody,
  authStartBody,
  authWidgetResultBody,
} from "../../schemas/index.js";
import { isAwaitingCode } from "../../../auth-flows.js";
import { log, type AdminRoutesDeps } from "./internals.js";
import type { RouteApp } from "../types.js";

/**
 * Block 1.13 + 1.14 — auth flows + OAuth callback.
 *
 *   GET  /admin/auth-flows
 *   POST /admin/auth-flows
 *   GET  /admin/auth-flows/:id
 *   GET  /admin/auth-flows/:id/events
 *   POST /admin/auth-flows/:id/code
 *   POST /admin/auth-flows/:id/widget-result
 *   POST /admin/auth-flows/:id/cancel
 *   GET  /oauth/callback              (public)
 *
 * Path/param conventions:
 *   - primary-resource path param is always `:id` (the rule the
 *     pre-#387 `:flowId` naming violated)
 *   - per-call `deviceId` always rides in the JSON body for POSTs
 *     (the rule the pre-#387 query-string usage violated)
 *   - sub-resource action verbs are kebab-case
 *
 * Pre-#387 prefix `/admin/sources/auth/*` retired in the same change —
 * an auth flow is not a sub-resource of any single source.
 */
export function mountAuthRoutes(app: RouteApp, deps: AdminRoutesDeps): void {
  const { authFlows, wsServer, resolveCollectorDeviceIdForType, publicBaseUrl } = deps;

  app.get("/admin/auth-flows", scope.admin(), (c) => {
    const flows = authFlows?.list() ?? [];
    return c.json(buildPage(flows, { hasMore: false, limit: flows.length }));
  });

  // Pre-#387 path was `POST /admin/sources/auth/start` — the verb-suffix
  // `start` is implicit in `POST <collection>` so we drop it.
  app.post("/admin/auth-flows", scope.admin(), validateJson(authStartBody), async (c) => {
    const body = c.req.valid("json");
    // Filter by sourceType so the picker isn't asked to choose between
    // collectors that can't host this source.
    const deviceId = await resolveCollectorDeviceIdForType(body.deviceId, body.sourceType);
    if (typeof deviceId !== "string") return deviceId;
    if (!authFlows || !wsServer)
      throw new ServiceUnavailableError("auth orchestration unavailable");

    const flow = authFlows.start({
      sourceType: body.sourceType as Parameters<
        NonNullable<typeof authFlows>["start"]
      >[0]["sourceType"],
      deviceId,
      accountId: body.accountId as Parameters<
        NonNullable<typeof authFlows>["start"]
      >[0]["accountId"],
    });

    try {
      await wsServer.sendCommand(
        deviceId,
        "auth.begin",
        {
          flowId: flow.id,
          sourceType: body.sourceType,
          params: body.params,
          accountId: body.accountId,
          // Forwarded to the collector, never recorded on the `AuthFlow`:
          // `GET /admin/auth-flows` returns every flow to every admin caller
          // with no per-caller filter, so the flow record stays secret-free.
          credentials: body.credentials,
          publicBaseUrl,
          renders: body.renders,
        },
        30_000,
      );
      return c.json({ flowId: flow.id, deviceId, sourceType: body.sourceType });
    } catch (err) {
      authFlows.update(flow.id, {
        state: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw new BadGatewayError(err instanceof Error ? err.message : String(err));
    }
  });

  app.get("/admin/auth-flows/:id", scope.admin(), (c) => {
    const id = c.req.param("id");
    const flow = authFlows?.get(id);
    if (!flow) throw new NotFoundError("flow not found");
    return c.json(flow);
  });

  app.get("/admin/auth-flows/:id/events", scope.admin(), (c) => {
    const id = c.req.param("id");
    if (!authFlows) return c.text("auth orchestration unavailable", 500);
    const flow = authFlows.get(id);
    if (!flow) return c.text("flow not found", 404);

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const writeEvent = (eventName: string, data: unknown) => {
          try {
            controller.enqueue(
              encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`),
            );
          } catch (err) {
            // Client disconnected mid-stream — usual case, debug-level.
            log.debug(
              `SSE flow ${id} write failed (${eventName}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        };

        writeEvent("snapshot", flow);

        // The pending challenge first, ahead of the older shapes it
        // supersedes. A source on this build emits both — the legacy event is
        // sent for a gateway one version behind — and a client that suppresses
        // the duplicate does so once it has seen the challenge. Replaying them
        // the other way round hands a reconnecting client the same URL twice.
        //
        // Replayed at all because a client that reconnects, or a second one
        // opening the flow, would otherwise see an awaiting-user flow with
        // nothing to answer. The snapshot event carries it too, but neither
        // client listens to that one.
        if (flow.pendingChallenge) {
          writeEvent("auth", {
            type: "challenge",
            id: flow.pendingChallenge.id,
            challenge: flow.pendingChallenge.challenge,
            expectsAnswer: flow.pendingChallenge.expectsAnswer,
          });
        }
        if (flow.authUrl && flow.pendingChallenge?.challenge.kind !== "redirect") {
          writeEvent("auth", { type: "url", url: flow.authUrl });
        }
        if (flow.qrData && flow.pendingChallenge?.challenge.kind !== "qr") {
          writeEvent("auth", { type: "qr", data: flow.qrData });
        }
        if (flow.widget)
          writeEvent("auth", {
            type: "widget",
            kind: flow.widget.kind,
            payload: flow.widget.payload,
          });
        if (flow.state === "completed")
          writeEvent("auth", {
            type: "complete",
            ok: true,
            accountId: flow.resolvedAccountId,
            accountIds: flow.resolvedAccountIds,
            accountStates: flow.resolvedAccountStates,
            notices: flow.resolvedNotices,
          });
        if (flow.state === "error")
          writeEvent("auth", {
            type: "complete",
            ok: false,
            error: flow.errorMessage,
            ...flow.errorDetail,
          });

        const unsubscribe = authFlows!.subscribe(id, (event) => {
          writeEvent("auth", event);
          if (event.type === "complete") {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        });

        c.req.raw.signal?.addEventListener("abort", () => {
          unsubscribe();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  app.post("/admin/auth-flows/:id/code", scope.admin(), validateJson(authCodeBody), async (c) => {
    const id = c.req.param("id");
    const { code } = c.req.valid("json");
    if (!authFlows) throw new ServiceUnavailableError("auth orchestration unavailable");
    if (!wsServer) throw new ServiceUnavailableError("no WS");

    // Single-use latch: the flow flips to `completing` BEFORE the code is
    // forwarded, so a concurrent or repeated delivery observes the
    // non-awaiting state and is rejected instead of double-spending the code.
    const latch = authFlows.acceptCodeDelivery(id);
    if (!latch.ok) {
      if (latch.reason === "not-found") throw new NotFoundError("flow not found");
      if (latch.reason === "not-a-question") {
        throw new ConflictError(
          "the flow is showing something rather than asking; nothing is waiting for a code",
        );
      }
      throw new ConflictError(`flow is not awaiting an authorization code (state: ${latch.state})`);
    }

    try {
      await wsServer.sendCommand(latch.flow.deviceId, "auth.code", { flowId: id, code }, 30_000);
      return c.json({ ok: true });
    } catch (err) {
      authFlows.update(id, {
        state: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw new BadGatewayError(err instanceof Error ? err.message : String(err));
    }
  });

  app.post(
    "/admin/auth-flows/:id/widget-result",
    scope.admin(),
    validateJson(authWidgetResultBody),
    async (c) => {
      const id = c.req.param("id");
      const { token, metadata } = c.req.valid("json");
      if (!authFlows) throw new ServiceUnavailableError("auth orchestration unavailable");
      if (!wsServer) throw new ServiceUnavailableError("no WS");

      // Not a single-use latch (unlike the code POST): one hosted-widget
      // session can deliver several results — one per selected institution —
      // so the flow stays awaiting until the provider resolves. We only
      // require it to be in an awaiting state, leaving it there.
      const flow = authFlows.get(id);
      if (!flow) throw new NotFoundError("flow not found");
      if (!isAwaitingCode(flow.state)) {
        throw new ConflictError(`flow is not awaiting a widget result (state: ${flow.state})`);
      }

      try {
        await wsServer.sendCommand(
          flow.deviceId,
          "auth.widget-result",
          { flowId: id, token, metadata },
          30_000,
        );
        return c.json({ ok: true });
      } catch (err) {
        authFlows.update(id, {
          state: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        throw new BadGatewayError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  app.post(
    "/admin/auth-flows/:id/answer",
    scope.admin(),
    validateJson(authAnswerBody),
    async (c) => {
      const id = c.req.param("id");
      const { challengeId, answer } = c.req.valid("json");
      if (!authFlows) throw new ServiceUnavailableError("auth orchestration unavailable");
      if (!wsServer) throw new ServiceUnavailableError("no WS");

      const flow = authFlows.get(id);
      if (!flow) throw new NotFoundError("flow not found");
      // Answering a challenge the flow is no longer waiting on would resolve
      // the wrong wait, which is exactly the failure the id exists to prevent.
      if (flow.pendingChallenge?.id !== challengeId) {
        throw new ConflictError(
          flow.pendingChallenge
            ? `flow is waiting on a different question (${flow.pendingChallenge.id})`
            : "flow is not waiting on a question",
        );
      }

      const pending = flow.pendingChallenge;
      if (
        !isAwaitingCode(flow.state) ||
        !pending.expectsAnswer ||
        (pending.challenge.kind !== "fields" && pending.challenge.kind !== "code")
      ) {
        throw new ConflictError("flow is not waiting for an answer on this channel");
      }
      // Consume the question before awaiting transport so duplicate deliveries
      // cannot be queued behind a question the provider has already answered.
      authFlows.update(id, { pendingChallenge: undefined, state: "completing" });

      try {
        await wsServer.sendCommand(
          flow.deviceId,
          "auth.answer",
          { flowId: id, challengeId, answer },
          30_000,
        );
        return c.json({ ok: true });
      } catch (err) {
        authFlows.update(id, {
          state: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        throw new BadGatewayError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  app.post("/admin/auth-flows/:id/cancel", scope.admin(), async (c) => {
    const id = c.req.param("id");
    const flow = authFlows?.get(id);
    if (!flow) throw new NotFoundError("flow not found");
    if (!wsServer) throw new ServiceUnavailableError("no WS");
    if (flow.state === "completed" || flow.state === "error") return c.json({ ok: true });
    // Latch before awaiting the collector: late success/QR events cannot
    // change a cancellation into a completed connection.
    authFlows?.ingestEvent(id, {
      type: "complete",
      ok: false,
      error: "cancelled",
      code: "user-cancelled",
    });
    try {
      await wsServer.sendCommand(flow.deviceId, "auth.cancel", { flowId: id }, 5_000);
    } catch {
      /* collector may already be gone — registry cleanup still applies */
    }
    return c.json({ ok: true });
  });

  // ── /oauth/callback (public) ──

  app.get("/oauth/callback", scope.public(), async (c) => {
    const flowId = c.req.query("state") || c.req.query("flowId");
    const code = c.req.query("code");
    const error = c.req.query("error");
    if (!flowId) {
      return c.html(renderOauthCallbackPage("error", "Missing state/flowId in callback"), 400);
    }
    if (error) {
      // Never echo the user-supplied `error` query
      // string verbatim. Map known OAuth-provider error codes to
      // safe sentences; treat anything else as the generic
      // refusal message.
      //
      // Only flows still awaiting a code are acted on: a replayed or
      // crafted error callback must not flip a completing/completed
      // flow. For a live awaiting flow, also send `auth.cancel` so the
      // collector reaps the parked auth subprocess instead of leaving
      // it waiting out its inactivity watchdog.
      const safe = friendlyOauthError(error);
      const flow = authFlows?.get(flowId);
      if (flow && isAwaitingCode(flow.state)) {
        authFlows?.ingestEvent(flowId, {
          type: "complete",
          ok: false,
          error: safe,
          code: "denied",
        });
        if (wsServer) {
          try {
            // Say that someone refused rather than only that the flow is over.
            // The provider is waiting on this answer, so it sees a refusal it
            // can classify — and its own failure path runs, which is the only
            // chance one that has just created something upstream gets to
            // undo it. `safe` is a mapped sentence, never the platform's own
            // error string.
            await wsServer.sendCommand(
              flow.deviceId,
              "auth.cancel",
              { flowId, reason: "denied", detail: safe },
              5_000,
            );
          } catch {
            /* collector may already be gone — flow record update still applies */
          }
        }
      }
      return c.html(renderOauthCallbackPage("error", safe, flowId), 400);
    }
    if (!code) {
      return c.html(renderOauthCallbackPage("error", "Missing code", flowId), 400);
    }

    if (!authFlows || !wsServer) {
      return c.html(renderOauthCallbackPage("error", "Flow not found or expired", flowId), 404);
    }

    // Single-use latch (same contract as POST /admin/auth-flows/:id/code):
    // flip to `completing` before forwarding so a second redirect with the
    // same or another code is rejected instead of reaching the collector.
    const latch = authFlows.acceptCodeDelivery(flowId);
    if (!latch.ok) {
      if (latch.reason === "not-found") {
        return c.html(renderOauthCallbackPage("error", "Flow not found or expired", flowId), 404);
      }
      return c.html(
        renderOauthCallbackPage(
          "error",
          latch.reason === "not-a-question"
            ? "This sign-in is answered on the machine running the collector, not here."
            : "This authorization was already used or the flow is no longer awaiting a code.",
          flowId,
        ),
        409,
      );
    }

    try {
      await wsServer.sendCommand(latch.flow.deviceId, "auth.code", { flowId, code }, 30_000);
      return c.html(
        renderOauthCallbackPage(
          "success",
          "Authorization received. You can close this window.",
          flowId,
        ),
      );
    } catch (err) {
      // Don't echo the inner error — it can carry collector / WS
      // diagnostics that aren't safe to render in a public-ish
      // browser context. Log full detail server-side; show a
      // sanitized message + flowId to the user.
      const detail = err instanceof Error ? err.message : String(err);
      log.warn(`OAuth callback delivery failed for flow=${flowId}: ${detail}`);
      authFlows?.update(flowId, { state: "error", errorMessage: detail });
      return c.html(
        renderOauthCallbackPage("error", "Failed to deliver code to the collector", flowId),
        502,
      );
    }
  });
}
