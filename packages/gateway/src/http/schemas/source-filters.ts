// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { sourceFilterSchema } from "../../access/scope-policy.js";

export const sourceFilterOptionsQuery = z.strictObject({
  /** A declared field's path, or `$people`. */
  field: z.string().min(1).max(256),
  q: z.string().max(256).optional(),
  parentId: z.string().min(1).max(512).optional(),
  device: z.string().min(1).max(512).optional(),
  cursor: z.string().min(1).max(8192).optional(),
});
export const sourceFilterPreviewBody = z.strictObject({ policy: sourceFilterSchema });
export const filterIdentifierCheckBody = z.strictObject({
  type: z.enum(["phone", "email", "domain"]),
  value: z.string().max(512),
});
