// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { scope } from "../http/scope.js";
import { RealtimeAdmissionError, transportCallError } from "./call-error.js";
import type { RouteApp } from "../http/routes/types.js";
import type { NodeWebSocket } from "@hono/node-ws";
import type { RealtimeConnection, RealtimeService } from "./service.js";

const query = z.object({
  conversationId: z.string().min(1).max(256).optional(),
  timeZone: z.string().min(1).max(128).optional(),
});
const recoverableErrors = z.literal("1").optional();
const protocolVersion = z.enum(["1", "2"]).default("1");

/** Owner-only native transport; bearer headers keep credentials out of URLs. */
export function mountRealtimeRoutes(
  app: RouteApp,
  service: RealtimeService,
  upgrade: NodeWebSocket["upgradeWebSocket"],
): void {
  app.get("/agent/realtime", scope.admin(), (c) => c.json(service.capability()));
  app.get(
    "/agent/realtime/ws",
    scope.admin(),
    async (c, next) => {
      if (!service.capability().available)
        return c.json({ error: "Realtime voice is unavailable" }, 404);
      if (c.get("auth").authMethod !== "bearer" || !c.get("auth").tokenId)
        return c.json({ error: "A device bearer token is required" }, 403);
      if (!query.safeParse(c.req.query()).success)
        return c.json({ error: "Invalid voice session options" }, 400);
      if (!protocolVersion.safeParse(c.req.header("X-Omnesis-Realtime-Version")).success)
        return c.json({ error: "Unsupported realtime protocol version (supported: 1–2)" }, 400);
      if (
        !recoverableErrors.safeParse(c.req.header("X-Omnesis-Realtime-Recoverable-Errors")).success
      )
        return c.json({ error: "Unsupported recoverable voice error option" }, 400);
      return next();
    },
    upgrade((c) => {
      let connection: RealtimeConnection | undefined;
      return {
        onOpen(_event, ws) {
          try {
            connection = service.open(
              {
                send: (data) => ws.send(data),
                close: (code, reason) => ws.close(code, reason),
                get bufferedAmount() {
                  return ws.raw?.bufferedAmount ?? 0;
                },
              },
              `token:${c.get("auth").tokenId}`,
              {
                ...query.parse(c.req.query()),
                recoverableErrors: c.req.header("X-Omnesis-Realtime-Recoverable-Errors") === "1",
                token: c.req.header("Authorization")?.slice(7) ?? "",
                version: Number(
                  protocolVersion.parse(c.req.header("X-Omnesis-Realtime-Version")),
                ) as 1 | 2,
              },
            );
          } catch (error) {
            const detail =
              error instanceof RealtimeAdmissionError
                ? error.detail
                : transportCallError("session_open_failed", error);
            try {
              ws.send(JSON.stringify({ type: "error", error: detail }));
            } catch {
              // A disconnected peer may not accept the frame; retain its safe close fallback.
            } finally {
              ws.close(
                detail.code === "pairing_rejected" ? 1008 : 1013,
                `voice_error:${detail.code}`,
              );
            }
          }
        },
        onMessage(event) {
          if (typeof event.data !== "string") {
            connection?.fail("invalid_client_event");
            return;
          }
          connection?.receive(event.data);
        },
        onClose() {
          connection?.close();
        },
        onError() {
          connection?.fail("client_socket_error");
        },
      };
    }),
  );
}
