// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { SourceId } from "@omnesis/types";
import { scope } from "../scope.js";
import { validateJson, validateQuery } from "../validate.js";
import {
  filterIdentifierCheckBody,
  sourceFilterOptionsQuery,
  sourceFilterPreviewBody,
} from "../schemas/source-filters.js";
import { BadRequestError } from "../errors.js";
import type { SourceFilterService } from "../services/SourceFilterService.js";
import type { AccessService } from "../../access/service.js";
import type { RouteApp } from "./types.js";

function sourceId(value: string): string {
  try {
    return SourceId(value);
  } catch {
    throw new BadRequestError("Invalid source ID.");
  }
}

/**
 * The owner's filter screens: the editor of one account and its picker, the
 * preview of a draft filter, the check of a typed identifier, and, per
 * document, its filter details and who can read it. Every route is the
 * owner's; an external agent's credential never reaches them.
 */
export function mountSourceFilterRoutes(
  app: RouteApp,
  deps: { service: SourceFilterService; access: AccessService },
): void {
  const editor = scope.accessEditorAdmin((deviceId) =>
    deps.access.isNativeAccessEditorDevice(deviceId),
  );
  app.post(
    "/admin/access/source-filters/identifiers",
    editor,
    validateJson(filterIdentifierCheckBody),
    (c) => {
      c.header("Cache-Control", "no-store");
      const { type, value } = c.req.valid("json");
      return c.json(deps.service.identifier(type, value));
    },
  );
  app.get("/admin/access/source-filters/:sourceId", scope.admin(), async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await deps.service.editor(sourceId(c.req.param("sourceId"))));
  });
  app.get(
    "/admin/access/source-filters/:sourceId/options",
    scope.admin(),
    validateQuery(sourceFilterOptionsQuery),
    async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(
        await deps.service.options({
          sourceId: sourceId(c.req.param("sourceId")),
          ...c.req.valid("query"),
        }),
      );
    },
  );
  app.post(
    "/admin/access/source-filters/:sourceId/preview",
    editor,
    validateJson(sourceFilterPreviewBody),
    async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(
        await deps.service.preview(sourceId(c.req.param("sourceId")), c.req.valid("json").policy),
      );
    },
  );
  app.get("/admin/documents/:id/filter-details", scope.admin(), async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await deps.service.documentFilterDetails(c.req.param("id")));
  });
  app.get("/admin/documents/:id/access", scope.admin(), async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await deps.service.documentAccess(c.req.param("id")));
  });
}
