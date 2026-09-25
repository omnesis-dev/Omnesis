// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { enforceBroadWriteScope, scope } from "../../scope.js";
import { validateJson } from "../../validate.js";
import { sourcePriorDefaultsBody } from "../../schemas/admin.js";
import { getSourcePriorDefaults, setSourcePriorDefaults } from "../../../source-prior-defaults.js";
import { log as adminLog } from "./internals.js";
import type { RouteApp } from "../types.js";

const log = adminLog.child("source-prior-defaults");

/**
 * Mount the source-prior-defaults admin endpoints.
 *
 * The collector POSTs the full list of per-source-type score priors at
 * startup, derived from each loaded source's `defaultSourcePrior` field
 * on `defineSource`. Re-posting fully replaces the collector-declared
 * layer; gateway built-in priors (`web` — the unified Web Pages source) are
 * preserved.
 *
 * No source-specific logic lives here — the gateway treats entries as
 * opaque `{ prefix, weight }` pairs. Per-source prior knowledge lives
 * in each source package on `defineSource(...)`.
 */
export function mountSourcePriorDefaultsRoutes(app: RouteApp): void {
  // Process-wide collector metadata; requires a broad write token so a
  // source-specific push client cannot rewrite ranking priors globally.
  app.post(
    "/admin/source-prior-defaults",
    scope.writeAny(),
    validateJson(sourcePriorDefaultsBody),
    (c) => {
      enforceBroadWriteScope(c.get("auth").scopes);
      const { entries } = c.req.valid("json");
      setSourcePriorDefaults(entries);
      log.info(`registered ${entries.length} collector-declared source prior(s)`);
      return c.json({ ok: true, count: entries.length });
    },
  );

  app.get("/admin/source-prior-defaults", scope.read(), (c) => {
    // Returns the merged view (built-in ∪ collector-declared) — useful
    // for debugging "why is this source down-weighted?".
    const merged = getSourcePriorDefaults();
    const entries = Object.entries(merged).map(([sourceIdPrefix, weight]) => ({
      sourceIdPrefix,
      weight,
    }));
    return c.json({ entries });
  });
}
