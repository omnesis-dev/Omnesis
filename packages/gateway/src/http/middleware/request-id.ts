// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";

const HEADER = "x-request-id";

export function requestIdMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const incoming = c.req.header(HEADER);
    const id = incoming && incoming.length > 0 ? incoming : randomUUID();
    c.set("requestId", id);
    c.header(HEADER, id);
    await next();
  };
}
