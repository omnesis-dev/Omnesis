// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { validateDocumentEventProfile } from "@omnesis/source-sdk";
import { enforceBroadWriteScope, scope } from "../../scope.js";
import { validateJson } from "../../validate.js";
import { BadRequestError } from "../../errors.js";
import { sourceDocumentProfilesBody } from "../../schemas/admin.js";
import { listSourceDocumentProfiles } from "../../../data/repositories/SourceDocumentProfileRepository.js";
import { log as adminLog } from "./internals.js";
import type { AdminRoutesDeps } from "./internals.js";
import type { RouteApp } from "../types.js";

const log = adminLog.child("source-document-profiles");

/**
 * Mount the source-document-profiles admin endpoints.
 *
 * The collector POSTs the `documentEventProfile` declared by *every known
 * source type* (every loaded source definition), derived at boot. Subscription
 * compilation reads the stored set to learn what a source's documents can be
 * asked about — the document types it emits, the person roles it populates,
 * and the metadata fields with their vocabularies — so a natural-language
 * watch condition compiles to a deterministic document predicate.
 *
 * Unlike the sibling boot pushes, the set is written to SQLite rather than
 * held in memory. The compiler treats a missing profile as "this source is
 * gone" and pauses watches that depend on it, so an in-memory registry would
 * pause every document watch during the window between a gateway restart and
 * the collector's reconnect. See `SourceDocumentProfileRepository`.
 *
 * Auth posture:
 *   - `POST /admin/source-document-profiles` — `scope.writeAny()` plus the
 *     `write:*` refinement, matching `owned-web-domains`: a process-wide
 *     configuration push a source-specific write token must not be able to
 *     replace.
 *   - `GET /admin/source-document-profiles` — `scope.read()`; it returns
 *     source contract metadata, never corpus content, but it is admin
 *     surface rather than something an unauthenticated client needs.
 *
 * No source-specific logic lives here — a profile is opaque source-declared
 * data validated against the shared source contract.
 */
export function mountSourceDocumentProfilesRoutes(app: RouteApp, deps: AdminRoutesDeps): void {
  app.post(
    "/admin/source-document-profiles",
    scope.writeAny(),
    validateJson(sourceDocumentProfilesBody),
    async (c) => {
      enforceBroadWriteScope(c.get("auth").scopes);
      const { entries } = c.req.valid("json");

      // The publisher is the collector, but the same contract the source-sdk
      // enforces at definition time is re-checked here: a profile reaches the
      // compiler's prompt, and an alias naming a value the source never
      // declares would compile a watch that silently can never match.
      const seen = new Set<string>();
      for (const entry of entries) {
        if (seen.has(entry.sourceType)) {
          throw new BadRequestError(`duplicate sourceType '${entry.sourceType}'`);
        }
        seen.add(entry.sourceType);
        try {
          validateDocumentEventProfile(entry.profile, `source '${entry.sourceType}'`);
        } catch (err) {
          throw new BadRequestError(err instanceof Error ? err.message : String(err));
        }
      }

      const { stored } = await deps.writeGate.upsertSourceDocumentProfiles(entries, Date.now());
      log.info(`registered document-event profiles for ${stored} source type(s)`);
      return c.json({ ok: true, count: stored });
    },
  );

  app.get("/admin/source-document-profiles", scope.read(), (c) => {
    return c.json({ entries: listSourceDocumentProfiles(deps.db) });
  });
}
