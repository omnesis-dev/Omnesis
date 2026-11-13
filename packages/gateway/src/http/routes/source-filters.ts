// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { SourceId } from "@omnesis/types";
import { scope } from "../scope.js";
import { validateJson, validateQuery } from "../validate.js";
import { sourceFilterOptionsQuery, sourceFilterPreviewBody } from "../schemas/source-filters.js";
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
export function mountSourceFilterRoutes(
  app: RouteApp,
  deps: { service: SourceFilterService; access: AccessService },
): void {
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
    scope.accessEditorAdmin((deviceId) => deps.access.isNativeAccessEditorDevice(deviceId)),
    validateJson(sourceFilterPreviewBody),
    async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(
        await deps.service.preview(sourceId(c.req.param("sourceId")), c.req.valid("json").policy),
      );
    },
  );
}
