// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";

export const browserFindSearchBody = z.object({
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
});

export const browserFindSuggestBody = z
  .object({
    version: z.number().int().min(1).max(1),
    text: z.string().trim().min(1).max(1024),
    limit: z.number().int().min(1).max(8).default(5),
  })
  .strict();
