// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { scope } from "../http/scope.js";
import { validateJson } from "../http/validate.js";
import { callError, RealtimeAdmissionError, type RealtimeCallError } from "./call-error.js";
import type { Context } from "hono";
import type { AppEnv, RouteApp } from "../http/routes/types.js";
import type { LiveVoiceService } from "./live-service.js";

const offer = z
  .object({
    sdp: z
      .string()
      .min(1)
      .max(64 * 1024),
    clientSessionId: z.string().uuid(),
    conversationId: z.string().min(1).max(256).optional(),
    timeZone: z.string().min(1).max(128).optional(),
  })
  .strict();
const id = z.string().uuid();

function credentials(c: Context<AppEnv>) {
  const auth = c.get("auth");
  if (auth.authMethod !== "bearer" || !auth.tokenId)
    throw new RealtimeAdmissionError(callError("pairing_rejected"));
  return { owner: `token:${auth.tokenId}`, token: c.req.header("Authorization")?.slice(7) ?? "" };
}

function rejection(c: Context<AppEnv>, error: unknown) {
  const failure: RealtimeCallError =
    error instanceof RealtimeAdmissionError ? error.detail : callError("connection_error");
  const status =
    failure.code === "server_shutdown"
      ? 503
      : failure.code === "pairing_rejected"
        ? 403
        : failure.code === "session_not_found" || failure.code === "unavailable"
          ? 404
          : failure.code === "session_busy"
            ? 409
            : failure.code === "protocol_error"
              ? 400
              : 502;
  return c.json({ error: failure.message, failure }, status);
}

/** Native signaling only; the trusted service owns provider credentials and canonical agent work. */
export function mountLiveVoiceRoutes(app: RouteApp, service: LiveVoiceService): void {
  app.get("/agent/realtime/sessions/:id/events", scope.admin(), (c) => {
    try {
      const { owner, token } = credentials(c);
      const parsed = id.safeParse(c.req.param("id"));
      if (!parsed.success) throw new RealtimeAdmissionError(callError("session_not_found"));
      service.status(owner, token, parsed.data);
      let pending: ReturnType<LiveVoiceService["status"]> | undefined;
      let stopped = false;
      let wake = () => {};
      let heartbeat = false;
      const unsubscribe = service.subscribe(owner, token, parsed.data, (status) => {
        pending = status;
        wake();
      });
      return streamSSE(c, async (stream) => {
        const timer = setInterval(() => {
          heartbeat = true;
          wake();
        }, 15_000);
        timer.unref();
        stream.onAbort(() => {
          stopped = true;
          wake();
        });
        try {
          while (!stopped) {
            const status = pending;
            pending = undefined;
            if (status) {
              await stream.writeSSE({ event: "voice.status", data: JSON.stringify(status) });
              if (status.status === "ended" || status.status === "failed") break;
            } else if (heartbeat) {
              await stream.write(": keepalive\n\n");
            }
            heartbeat = false;
            if (!pending && !stopped)
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
          }
        } finally {
          stopped = true;
          clearInterval(timer);
          unsubscribe();
        }
      });
    } catch (error) {
      return rejection(c, error);
    }
  });
  app.post(
    "/agent/realtime/sessions",
    scope.admin(),
    bodyLimit({ maxSize: 128 * 1024 }),
    validateJson(offer),
    async (c) => {
      try {
        const { owner, token } = credentials(c);
        return c.json(
          await service.create(owner, token, c.req.valid("json"), c.req.raw.signal),
          201,
        );
      } catch (error) {
        return rejection(c, error);
      }
    },
  );
  app.get("/agent/realtime/sessions/:id", scope.admin(), (c) => {
    try {
      const { owner, token } = credentials(c);
      const parsed = id.safeParse(c.req.param("id"));
      if (!parsed.success) throw new RealtimeAdmissionError(callError("session_not_found"));
      return c.json(service.status(owner, token, parsed.data));
    } catch (error) {
      return rejection(c, error);
    }
  });
  app.post("/agent/realtime/sessions/:id/ready", scope.admin(), (c) => {
    try {
      const { owner, token } = credentials(c);
      const parsed = id.safeParse(c.req.param("id"));
      if (!parsed.success) throw new RealtimeAdmissionError(callError("session_not_found"));
      service.ready(owner, token, parsed.data);
      return c.body(null, 204);
    } catch (error) {
      return rejection(c, error);
    }
  });
  app.delete("/agent/realtime/sessions/:id", scope.admin(), async (c) => {
    try {
      const { owner, token } = credentials(c);
      const parsed = id.safeParse(c.req.param("id"));
      if (!parsed.success) throw new RealtimeAdmissionError(callError("session_not_found"));
      return c.json(await service.end(owner, token, parsed.data));
    } catch (error) {
      return rejection(c, error);
    }
  });
}
