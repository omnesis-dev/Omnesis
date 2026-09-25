// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { parseWebSocketAuthProtocolHeader } from "@omnesis/core";
import { scope } from "./http/scope.js";
import { clientAddress } from "./http/client-ip.js";
import type { DeviceWsServer } from "./ws.js";
import type { AppEnv, RouteApp } from "./http/routes/types.js";
import type { Context } from "hono";
import type { NodeWebSocket } from "@hono/node-ws";

function websocketClientIp(c: Context<AppEnv>): string {
  return clientAddress((name) => c.req.header(name), c.env);
}

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

export function mountDeviceWsRoute(
  app: RouteApp,
  wsServer: DeviceWsServer,
  upgradeWebSocket: NodeWebSocket["upgradeWebSocket"],
): void {
  app.get(
    "/device/ws",
    scope.deviceWs(),
    async (c, next) => {
      const clientIp = websocketClientIp(c);
      const token =
        parseWebSocketAuthProtocolHeader(c.req.header("sec-websocket-protocol")) ??
        bearerToken(c.req.header("Authorization"));
      if (!token) {
        return c.json({ error: "websocket_token_required" }, 401);
      }
      const auth = wsServer.authenticateUpgradeToken(clientIp, token);
      if (!auth.ok) {
        return c.json({ error: auth.code, message: auth.message }, auth.status);
      }
      c.set("wsAuth", auth.auth);
      c.set("wsClientIp", clientIp);
      return next();
    },
    upgradeWebSocket((c) => {
      const clientIp = c.get("wsClientIp");
      const auth = c.get("wsAuth");
      return {
        onOpen(_evt, ws) {
          // `raw` is the underlying `ws` socket, so the gateway can probe the
          // connection with real ping frames instead of trusting that an OPEN
          // socket still has a peer behind it. Pongs are produced by the
          // client's WebSocket implementation, not by its application code.
          const raw = ws.raw;
          wsServer.onOpen(
            ws,
            clientIp,
            auth,
            raw
              ? {
                  // The no-op callback matters: without one, `ws` reports a
                  // ping issued on an already-closing socket by emitting an
                  // `error` event on it rather than by calling back.
                  ping: () => raw.ping(undefined, undefined, () => {}),
                  terminate: () => raw.terminate(),
                }
              : null,
          );
          raw?.on("pong", () => wsServer.onPong(ws));
        },
        onMessage(evt, ws) {
          const data = evt.data;
          const str = typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString();
          wsServer.onMessage(ws, str);
        },
        onClose(_evt, ws) {
          wsServer.onClose(ws);
        },
      };
    }),
  );
}
