// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";

/**
 * The owner's thumbs on one item of a sent morning brief
 * (`PUT /agent/conversations/:id/briefs/:day/items/:observationId/reaction`).
 * `null` clears the reaction. `note` carries their words: why they are not
 * interested, or the correction a factual error needs. The gateway names the
 * note a correction is saved as, so the same correction sent twice is one note.
 */
export const briefItemReactionBody = z
  .object({
    reaction: z.enum(["up", "not_interested", "factual_error"]).nullable(),
    note: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
