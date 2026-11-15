// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `GET /portal/api/signals`: the portal's live line from the gateway, a
 * server-sent event stream of `PortalSignals` topics. Each frame names what
 * changed (`event: changed`, `data: {"topic":"devices"}`) and nothing more;
 * the portal re-reads that topic's list through its ordinary route. The first
 * frame is `event: ready`, after which the portal re-reads everything it
 * shows, so a reconnect never misses what changed while it was away. An
 * `event: beat` every few seconds tells the portal the stream is alive.
 *
 * Admin scope, like every list a signal points at, and only for as long as
 * the credential that opened it: each beat checks it again and ends the
 * stream once the session or token is gone. One browser holds one stream for
 * all its tabs; the gateway caps how many it serves at once.
 */

import { scope } from "../scope.js";
import type { PortalSignals } from "../../portal-signals/hub.js";
import type { Context } from "hono";
import type { AppEnv, RouteApp } from "./types.js";

/** Keeps proxies from closing a quiet stream, and finds a dead socket within this long. */
const HEARTBEAT_MS = 25_000;

export interface PortalSignalRouteOptions {
  heartbeatMs?: number;
  /** Whether the credential that opened this stream is still valid; checked on every beat. */
  stillAuthorized?: (c: Context<AppEnv>) => boolean;
}

export function mountPortalSignalRoutes(
  app: RouteApp,
  signals: PortalSignals,
  { heartbeatMs = HEARTBEAT_MS, stillAuthorized = () => true }: PortalSignalRouteOptions = {},
): void {
  app.get("/portal/api/signals", scope.admin(), (c) => {
    // Say so with a status while one still can; a stream that loses the race
    // for the last slot below simply ends, and the portal retries.
    if (!signals.hasRoom()) {
      return c.json(
        { code: "too-many-streams", error: "Too many portals are listening to this gateway." },
        503,
        { "Retry-After": "30" },
      );
    }
    const encoder = new TextEncoder();
    const signal = c.req.raw.signal;
    // Ends the stream once, whoever notices first: the client leaving, a write
    // to a socket that is gone, a credential that lapsed, or the stream's reader.
    let stop: (error?: unknown) => void = () => {};
    const stream = new ReadableStream({
      start(controller) {
        let closed = false;
        let unsubscribe: () => void = () => {};
        let timer: ReturnType<typeof setInterval> | undefined = undefined;
        stop = (error?: unknown): void => {
          if (closed) return;
          closed = true;
          if (timer) clearInterval(timer);
          unsubscribe();
          try {
            if (error !== undefined) controller.error(error);
            else controller.close();
          } catch {
            // Already closed.
          }
        };
        const write = (frame: string): void => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(frame));
          } catch (error) {
            stop(error);
          }
        };
        try {
          unsubscribe = signals.subscribe((topic) =>
            write(`event: changed\ndata: ${JSON.stringify({ topic })}\n\n`),
          );
        } catch (error) {
          stop(error);
          return;
        }
        write(`event: ready\ndata: {}\n\n`);
        timer = setInterval(() => {
          if (!stillAuthorized(c)) stop();
          else write(`event: beat\ndata: {}\n\n`);
        }, heartbeatMs);
        timer.unref?.();
        if (signal?.aborted) stop();
        else signal?.addEventListener("abort", () => stop());
      },
      cancel() {
        stop();
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
