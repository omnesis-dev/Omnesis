// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { scopePolicyV1Schema } from "../../access/scope-policy.js";

export const sourceFilterOptionsQuery = z.strictObject({
  kind: z.enum(["conversation", "participant", "label", "folder"]),
  q: z.string().max(256).optional(),
  parentId: z.string().min(1).max(512).optional(),
  cursor: z.string().min(1).max(8192).optional(),
});
export const sourceFilterPreviewBody = z.strictObject({ policy: scopePolicyV1Schema });
