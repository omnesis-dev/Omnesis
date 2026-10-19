// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";

/**
 * The owner's thumbs on one item of a sent morning brief
 * (`PUT /agent/conversations/:id/briefs/:day/items/:observationId/reaction`).
 * `null` clears the reaction. `note` carries their words: why they are not
 * interested, or the correction a factual error needs. `noteId` is the Tell
 * Omnesis note id a correction is saved under; a client retrying the same
 * correction sends the same id so the note is captured once.
 */
export const briefItemReactionBody = z
  .object({
    reaction: z.enum(["up", "not_interested", "factual_error"]).nullable(),
    note: z.string().trim().min(1).max(2000).optional(),
    noteId: z.string().uuid().optional(),
  })
  .strict();

export type BriefItemReactionBody = z.infer<typeof briefItemReactionBody>;
