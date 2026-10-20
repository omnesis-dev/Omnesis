// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { scope } from "../http/scope.js";
import type { RouteApp } from "../http/routes/types.js";
import type { NodeWebSocket } from "@hono/node-ws";
import type { RealtimeConnection, RealtimeService } from "./service.js";

const query = z.object({
  conversationId: z.string().min(1).max(256).optional(),
  timeZone: z.string().min(1).max(128).optional(),
});
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
                token: c.req.header("Authorization")?.slice(7) ?? "",
                version: Number(
                  protocolVersion.parse(c.req.header("X-Omnesis-Realtime-Version")),
                ) as 1 | 2,
              },
            );
          } catch {
            ws.send(
              JSON.stringify({
                type: "error",
                error: { message: "Realtime voice is unavailable or busy. Please try again." },
              }),
            );
            ws.close(1013, "Voice unavailable");
          }
        },
        onMessage(event) {
          if (typeof event.data !== "string") {
            connection?.close();
            return;
          }
          connection?.receive(event.data);
        },
        onClose() {
          connection?.close();
        },
        onError() {
          connection?.close();
        },
      };
    }),
  );
}
