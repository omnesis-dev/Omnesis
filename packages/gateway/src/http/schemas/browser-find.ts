// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";

export const browserFindSearchBody = z
  .object({
    version: z.number().int().min(1).max(2).optional(),
    mode: z.enum(["direct", "agentic"]).optional(),
    text: z.string().trim().min(1).max(1024),
    limit: z.number().int().min(1).max(200).default(25),
    timeZone: z
      .string()
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "must be a valid IANA time zone")
      .optional(),
  })
  .superRefine((input, ctx) => {
    if ((input.mode !== undefined) !== (input.version === 2))
      ctx.addIssue({
        code: "custom",
        path: ["mode"],
        message: "Explicit search mode requires version 2; version 2 requires an explicit mode",
      });
  });

/** A distinct route prevents older gateways from stripping the requested mode. */
export const browserFindModeSearchBody = browserFindSearchBody.refine(
  (input) => input.version === 2 && input.mode !== undefined,
  "Version 2 and an explicit search mode are required",
);

export const browserFindSuggestBody = z
  .object({
    version: z.number().int().min(1).max(1),
    text: z.string().trim().min(1).max(1024),
    limit: z.number().int().min(1).max(8).default(5),
  })
  .strict();
