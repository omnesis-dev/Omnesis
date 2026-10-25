// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { PERSON_IDENTIFIER_KINDS, SourceId } from "@omnesis/types";
import type { TranscriptionContext } from "@omnesis/core";

const person = z
  .object({
    personId: z.string().min(1).max(256).optional(),
    isSelf: z.boolean().optional(),
    identifiers: z
      .array(
        z
          .object({
            kind: z.enum(PERSON_IDENTIFIER_KINDS),
            value: z.string().min(1).max(256),
          })
          .strip(),
      )
      .max(4)
      .optional(),
  })
  .strip();

/**
 * Bounds are shared by direct dictionary calls and source audio context.
 * Unknown keys are dropped rather than refused: the context is an optional hint
 * that newer collectors and apps extend, and a refused one costs the recording
 * its transcript (the collector reads any 4xx as "no transcript").
 */
export const transcriptionContextSchema = z
  .object({
    purpose: z.enum(["source-audio", "dictation", "agent"]),
    speaker: person.optional(),
    conversation: z
      .object({
        sourceId: z
          .string()
          .min(1)
          .max(256)
          .transform((value, ctx) => {
            try {
              return SourceId(value);
            } catch {
              ctx.addIssue({ code: "custom", message: "Invalid sourceId" });
              return z.NEVER;
            }
          }),
        threadId: z.string().min(1).max(1024),
      })
      .strip()
      .optional(),
    participants: z.array(person).max(32).optional(),
    languageHints: z
      .array(
        z
          .string()
          .regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/)
          .max(32),
      )
      .max(8)
      .optional(),
    recordedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strip() satisfies z.ZodType<TranscriptionContext>;
