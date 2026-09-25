// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";

/** POST /answer — one read-only agent turn, optionally continuing a transcript. */
export const answerBody = z
  .object({
    question: z
      .string()
      .min(1)
      .max(10_000)
      .refine((value) => value.trim().length > 0, "must not be blank"),
    conversationId: z
      .string()
      .regex(/^[A-Za-z0-9_:-]{1,128}$/, "must be a valid conversation id")
      .optional(),
    workflowId: z
      .string()
      .regex(/^[A-Za-z0-9_:-]{1,128}$/, "must be a valid workflow id")
      .optional(),
    clientRequestId: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{1,160}$/, "must be a valid client request id")
      .optional(),
    workflowName: z.string().min(1).max(120).optional(),
    workflowPurpose: z.string().max(500).optional(),
    approval: z.enum(["allow", "never"]).optional(),
  })
  .strict();

export type AnswerBody = z.infer<typeof answerBody>;
