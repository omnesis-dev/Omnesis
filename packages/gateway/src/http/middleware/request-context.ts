// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { RequestContext, type RequestAuth } from "../request-context.js";
import type { MiddlewareHandler } from "hono";

export function requestContextMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("auth") as RequestAuth | undefined;
    if (auth) {
      const requestId = (c.get("requestId") as string | undefined) ?? "";
      const ctx = new RequestContext(c, auth, requestId);
      c.set("ctx", ctx);
    }
    await next();
  };
}
