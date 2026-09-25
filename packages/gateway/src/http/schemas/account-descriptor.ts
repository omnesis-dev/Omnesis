// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";

const accountSubjectSchema = z.object({
  kind: z.enum(["email", "phone", "handle", "opaque"]),
  value: z.string().min(1).max(512),
});

/** Closed wire shape shared by discovery registration and metadata refresh. */
export const accountDescriptorSchema = z.object({
  id: z.string().min(1).max(512),
  label: z.string().max(512).optional(),
  subject: accountSubjectSchema.optional(),
  tenant: z
    .object({ id: z.string().min(1).max(256), label: z.string().max(512).optional() })
    .optional(),
  aliases: z.array(accountSubjectSchema).max(32).optional(),
});
