// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `GET /portal/api/signals`: the portal's live line from the gateway, a
 * server-sent event stream of `PortalSignals` topics. Each frame names what
 * changed (`event: changed`, `data: {"topic":"devices"}`) and nothing more;
 * the portal re-reads that topic's list through its ordinary route. The first
 * frame is `event: ready`, after which the portal re-reads everything it
 * shows, so a reconnect never misses what changed while it was away.
 *
 * Admin scope, like every list a signal points at. One browser holds one
 * stream for all its tabs; the gateway caps how many it serves at once.
 */

import { scope } from "../scope.js";
import type { PortalSignals } from "../../portal-signals/hub.js";
import type { RouteApp } from "./types.js";

/** Keeps proxies from closing a quiet stream, and finds a dead socket within this long. */
const HEARTBEAT_MS = 25_000;

export function mountPortalSignalRoutes(
  app: RouteApp,
  signals: PortalSignals,
  { heartbeatMs = HEARTBEAT_MS }: { heartbeatMs?: number } = {},
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
    let unsubscribe: () => void = () => {};
    const signal = c.req.raw.signal;
    const stream = new ReadableStream({
      start(controller) {
        let closed = false;
        let timer: ReturnType<typeof setInterval> | undefined = undefined;
        // Once: from the client leaving, or a write to a socket that is gone.
        const teardown = (error?: unknown): void => {
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
            teardown(error);
          }
        };
        try {
          unsubscribe = signals.subscribe((topic) =>
            write(`event: changed\ndata: ${JSON.stringify({ topic })}\n\n`),
          );
        } catch (error) {
          teardown(error);
          return;
        }
        write(`event: ready\ndata: {}\n\n`);
        timer = setInterval(() => write(`: hb\n\n`), heartbeatMs);
        timer.unref?.();
        if (signal?.aborted) teardown();
        else signal?.addEventListener("abort", () => teardown());
      },
      cancel() {
        unsubscribe();
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
