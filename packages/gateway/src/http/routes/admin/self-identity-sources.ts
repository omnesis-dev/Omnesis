// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { enforceBroadWriteScope, scope } from "../../scope.js";
import { validateJson } from "../../validate.js";
import { selfIdentitySourcesBody } from "../../schemas/admin.js";
import {
  listSelfIdentitySources,
  mergeSelfIdentitySources,
} from "../../../self-identity-sources.js";
import { log as adminLog } from "./internals.js";
import type { AdminRoutesDeps } from "./internals.js";
import type { RouteApp } from "../types.js";

const log = adminLog.child("self-identity-sources");

/**
 * Mount the self-identity-sources admin endpoints.
 *
 * Each collector POSTs the self-identity hooks of the sources it hosts,
 * derived from `defineSource.selfIdentity`. The gateway merges them by source
 * type — a collector hosting none pushes an empty list, one on an older pin
 * pushes fewer than its peer, and neither may erase what a sibling declared.
 * The self-detection pass (`detectSelfFromSourceIds`) then pairs every synced
 * source account to the self LID alias its normalizer emits.
 *
 * The push is the pass's trigger, not just its input. The registry is empty
 * until a collector connects — after the boot pass has already run — and the
 * collector republishes on every mid-session source add, so re-running here
 * is what gets the alias onto self before a newly added source's first sync.
 * Without it a Strava/GitHub source added to a running gateway accrues its
 * self-authored documents under a duplicate person until the next boot.
 *
 * No source-specific logic lives here — the gateway treats entries as opaque
 * `{ sourceType, aliasPrefix, accountPattern? }` triples. Per-source self-LID
 * knowledge lives in each source package on `defineSource(...)`.
 */
export function mountSelfIdentitySourcesRoutes(app: RouteApp, deps: AdminRoutesDeps): void {
  app.post(
    "/admin/self-identity-sources",
    scope.writeAny(),
    validateJson(selfIdentitySourcesBody),
    async (c) => {
      enforceBroadWriteScope(c.get("auth").scopes);
      const { entries } = c.req.valid("json");
      mergeSelfIdentitySources(entries);
      const hooks = listSelfIdentitySources();
      // Re-pair every registered source against the merged registry. The
      // hooks go with the call because the pass runs on the writer worker,
      // which never sees this thread's registry. Bounded work (one row per
      // source) and idempotent — the alias insert is INSERT OR IGNORE. A
      // failure here is not the push's failure: the registry is merged either
      // way and the next push or boot retries the pairing.
      try {
        const added = hooks.length === 0 ? 0 : await deps.writeGate.detectSelfFromSourceIds(hooks);
        log.info(
          `merged ${entries.length} self-identity hook(s), registry holds ${hooks.length}; pass added ${added} alias(es) to self`,
        );
      } catch (err) {
        log.warn(
          `self-detection pass after registry push failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return c.json({ ok: true, count: entries.length });
    },
  );
}
