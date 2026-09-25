// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { strictRoute } from "../scope.js";
import { mountPortalRoutes } from "./portal.js";
import type { AppEnv } from "./types.js";
import type { PortalRoutesDeps } from "./portal.js";

/**
 * `/portal` (no trailing slash) redirects to `/portal/`, where the SPA is
 * served. The query string travels with it: a one-time login token arrives
 * that way, and dropping it lands the operator on the login form holding a
 * link that should have signed them in.
 */
function portalApp(): Hono<AppEnv> {
  const app = strictRoute(new Hono<AppEnv>());
  // The redirect handler reads only the request URL; the rest of the block's
  // dependencies belong to handlers this test never reaches. The static root
  // is the real one — mounting resolves it to guard against traversal.
  mountPortalRoutes(app, {
    db: {} as PortalRoutesDeps["db"],
    portalRoot: join(import.meta.dirname, "..", "..", "..", "portal"),
    authService: {} as PortalRoutesDeps["authService"],
    sourceService: {} as PortalRoutesDeps["sourceService"],
  });
  return app;
}

describe("the /portal redirect", () => {
  test("carries the query string to /portal/", async () => {
    const res = await portalApp().request("/portal?token=omn_examplevalue&view=people");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/portal/?token=omn_examplevalue&view=people");
  });

  test("redirects with no query when none was given", async () => {
    const res = await portalApp().request("/portal");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/portal/");
  });
});
