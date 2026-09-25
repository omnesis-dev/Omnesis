// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { scope } from "../../scope.js";
import { computeSelfCandidate } from "../../../domain/SelfIdentity.js";
import type { AdminRoutesDeps } from "./internals.js";
import type { RouteApp } from "../types.js";

/**
 * Mount the operator-identity ("self") admin endpoints.
 *
 *   GET /admin/self/candidate
 *
 * Proposes who the operator is from their already-authenticated accounts when
 * no canonical self exists yet (the account email IS the source id), so a
 * Gmail-only install isn't left without one. It's a suggestion the operator
 * confirms — via the portal banner or `omnesis self set` — never an automatic
 * election. See `computeSelfCandidate` for the conservative rules.
 */
export function mountSelfRoutes(app: RouteApp, deps: AdminRoutesDeps): void {
  app.get("/admin/self/candidate", scope.admin(), (c) => {
    return c.json({ candidate: computeSelfCandidate(deps.db, deps.getConfig?.().self) });
  });
}
