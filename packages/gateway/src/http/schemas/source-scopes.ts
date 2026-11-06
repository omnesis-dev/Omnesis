// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { sourceScopesSchema } from "../../access/scope-descriptors.js";

export const sourceScopesBody = z
  .strictObject({
    entries: z
      .array(
        z.strictObject({
          sourceType: z.string().min(1).max(512),
          scopes: sourceScopesSchema,
        }),
      )
      .max(256),
  })
  .refine(
    (body) => new Set(body.entries.map((entry) => entry.sourceType)).size === body.entries.length,
    {
      message: "Each source type may be declared only once.",
    },
  );
