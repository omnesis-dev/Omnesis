// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { createNoteBody } from "./notes.js";

export const authorizationBody = z.object({ id: z.string().uuid() }).strict();
const pageContext = z
  .object({
    url: z
      .string()
      .url()
      .max(4096)
      .refine((url) => /^https?:\/\//i.test(url), "must be an HTTP or HTTPS page"),
    title: z.string().max(512).optional(),
    selection: z.string().max(8192).optional(),
  })
  .strict();
// Reuse the note boundary's timezone/date pair checks without widening the existing /notes contract.
export const browserNoteBody = z
  .object({
    version: z.number().int().min(1).max(1),
    id: z.string().uuid(),
    text: z
      .string()
      .min(1)
      .max(8192)
      .refine((text) => text.trim().length > 0),
    capturedAt: z.string().max(64).optional(),
    capturedTimeZoneId: z.string().max(128).optional(),
    capturedUtcOffsetSeconds: z.number().optional(),
    page: pageContext,
  })
  .strict()
  .transform((body, ctx) => {
    const { version: _version, page: _page, ...note } = body;
    const result = createNoteBody.safeParse(note);
    if (!result.success) {
      for (const issue of result.error.issues)
        ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
      return z.NEVER;
    }
    return { ...result.data, id: body.id, version: body.version, page: body.page };
  });
