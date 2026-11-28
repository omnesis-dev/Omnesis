// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { scope } from "../scope.js";
import { validateJson, validateQuery } from "../validate.js";
import {
  artifactCatalogQuery,
  artifactDownloadId,
  readableArtifactConsent,
} from "../schemas/artifacts.js";
import { ForbiddenError, ValidationError } from "../errors.js";
import type { Context } from "hono";
import type { ArtifactDownloadService } from "../services/ArtifactDownloadService.js";
import type { AppEnv, RouteApp } from "./types.js";

export interface ArtifactRoutesDeps {
  service: ArtifactDownloadService;
  /** Recheck the approved token/session while a large download is streaming. */
  stillAuthorized(context: Context<AppEnv>): boolean;
}
export function mountArtifactRoutes(app: RouteApp, deps: ArtifactRoutesDeps): void {
  app.post(
    "/admin/artifacts/:id/readable-download",
    scope.admin(),
    validateJson(readableArtifactConsent),
    async (c) => {
      const parsed = artifactDownloadId.safeParse(c.req.param("id"));
      if (!parsed.success || new URL(c.req.url).search)
        throw new ValidationError("Invalid readable export request.");
      const auth = c.get("auth");
      return deps.service.readableExport(
        parsed.data,
        {
          caller: `${auth.authMethod}:${auth.tokenId ?? auth.deviceId ?? "portal"}`,
          stillAuthorized: () => deps.stillAuthorized(c),
        },
        c.req.raw.signal,
      );
    },
  );
  app.get("/admin/artifacts", scope.admin(), validateQuery(artifactCatalogQuery), async (c) => {
    if (!deps.stillAuthorized(c)) throw new ForbiddenError("Artifact access is no longer active.");
    const items = await deps.service.list(c.req.valid("query").kind, c.req.raw.signal);
    if (!deps.stillAuthorized(c)) throw new ForbiddenError("Artifact access is no longer active.");
    c.header("Cache-Control", "no-store");
    return c.json({ items });
  });
  app.get("/admin/artifacts/:id/download", scope.admin(), async (c) => {
    const parsed = artifactDownloadId.safeParse(c.req.param("id"));
    if (!parsed.success || new URL(c.req.url).search)
      throw new ValidationError("Invalid artifact download request.");
    const auth = c.get("auth");
    return deps.service.download(
      parsed.data,
      {
        caller: `${auth.authMethod}:${auth.tokenId ?? auth.deviceId ?? "portal"}`,
        stillAuthorized: () => deps.stillAuthorized(c),
      },
      c.req.raw.signal,
    );
  });
}
