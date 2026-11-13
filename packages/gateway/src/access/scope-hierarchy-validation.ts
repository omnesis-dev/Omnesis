// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import * as z from "zod/v4";

const id = z.string().min(1).max(512);
export const hierarchyParentsSchema = z
  .array(id)
  .max(16)
  .refine((values) => new Set(values).size === values.length);
export const documentHierarchySchema = z
  .array(
    z.strictObject({
      kind: z.literal("folder"),
      parentIds: hierarchyParentsSchema,
      complete: z.boolean(),
      refreshEpoch: id.optional(),
    }),
  )
  .max(1);
export const hierarchyUpdateSchema = z
  .strictObject({
    kind: z.literal("folder"),
    refreshEpoch: id.optional(),
    nodes: z
      .array(
        z.strictObject({
          id,
          label: id,
          parentIds: hierarchyParentsSchema,
          complete: z.boolean(),
          deleted: z.boolean().optional(),
        }),
      )
      .max(256)
      .optional(),
    documents: z
      .array(
        z.strictObject({
          externalId: id,
          parentIds: hierarchyParentsSchema,
          complete: z.boolean(),
          refreshEpoch: id.optional(),
        }),
      )
      .max(256)
      .optional(),
    snapshot: z.strictObject({ id, phase: z.enum(["begin", "scan", "end"]) }).optional(),
  })
  .refine(
    (value) =>
      new Set(value.nodes?.map((node) => node.id)).size === (value.nodes?.length ?? 0) &&
      new Set(value.documents?.map((doc) => doc.externalId)).size ===
        (value.documents?.length ?? 0),
  );
