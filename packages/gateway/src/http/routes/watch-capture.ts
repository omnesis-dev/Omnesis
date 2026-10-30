// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import { scope } from "../scope.js";
import { notesRateLimiter } from "../../rate-limit.js";
import { BadRequestError, ValidationError } from "../errors.js";
import { clientIp } from "./admin/internals.js";
import type { WatchRoutingService } from "../../dictation/watch-routing.js";
import type { RouteApp } from "./types.js";

const capture = z.object({ text: z.string().trim().min(1).max(16_000) }).strict();

export function mountWatchCaptureRoutes(app: RouteApp, service: WatchRoutingService): void {
  const limiter = notesRateLimiter();
  app.post("/watch/capture/route", scope.admin(), bodyLimit({ maxSize: 128 * 1024 }), async (c) => {
    if (limiter.consume(clientIp(c)))
      return c.json({ error: "Too many captures" }, 429, { "Retry-After": "60" });
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new BadRequestError("Expected a JSON capture");
    }
    const parsed = capture.safeParse(body);
    if (!parsed.success) throw new ValidationError("Invalid watch capture", parsed.error.issues);
    return c.json({ route: await service.route(parsed.data.text, c.req.raw.signal) });
  });
}
