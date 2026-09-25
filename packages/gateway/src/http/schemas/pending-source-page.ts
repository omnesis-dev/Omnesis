// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { analyticsIngestBody } from "./analytics.js";
import { upsertWithCursorBody } from "./documents.js";

const tableWrite = analyticsIngestBody
  .omit({ sourceId: true, writeEpoch: true, observationId: true })
  .extend({ records: analyticsIngestBody.shape.records.optional() });
const fields = upsertWithCursorBody.shape;
// Reuse the execution boundaries. Remaining progress/issue fields are opaque
// presentation data retained losslessly; they cannot grant write authority.
const result = z
  .object({
    cursor: fields.cursor,
    hasMore: fields.hasMore,
    analytics: z.union([tableWrite, z.array(tableWrite)]).optional(),
    documents: fields.documents,
    edges: fields.edges,
    deletedExternalIds: fields.deletedExternalIds,
    presentExternalIds: fields.presentExternalIds,
    presentClaims: fields.presentClaims,
    consentExpiresAt: fields.consentExpiresAt,
    watermark: fields.watermark,
  })
  .passthrough();

export const prepareStructuredPageBody = z.object({
  id: z.string().uuid(),
  writeEpoch: z.number().int().nonnegative(),
  result,
  meta: fields.meta,
  documentTemporalProjections: fields.documentTemporalProjections,
});
export const acknowledgeStructuredPageBody = prepareStructuredPageBody.pick({
  id: true,
  writeEpoch: true,
});
