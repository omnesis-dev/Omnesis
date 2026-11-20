// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";

/** Legacy operational metadata is accepted on input, never exposed or persisted as policy. */
export const storageRetentionPolicySchema = z
  .object({
    sourceId: z.string().min(1).max(512),
    maxAgeDays: z.number().int().positive().max(36500),
    sourceCreatedAt: z.number().int().nonnegative().optional(),
  })
  .strict()
  .transform(({ sourceId, maxAgeDays }) => ({ sourceId, maxAgeDays }));

export interface LegacyStorageRetentionBinding {
  sourceId: string;
  maxAgeDays: number;
  sourceCreatedAt: number;
}

/** Capture before schema normalization so an old binding cannot attach to a replacement source. */
export function legacyStorageRetentionBindingsFromInput(
  input: unknown,
): LegacyStorageRetentionBinding[] {
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const policies = object(object(object(input)?.gateway)?.storage)?.retention;
  if (!Array.isArray(policies)) return [];
  return policies.flatMap((policy: unknown) => {
    const row = object(policy);
    if (
      !row ||
      typeof row.sourceId !== "string" ||
      typeof row.maxAgeDays !== "number" ||
      !Number.isSafeInteger(row.maxAgeDays) ||
      row.maxAgeDays <= 0 ||
      row.maxAgeDays > 36500 ||
      typeof row.sourceCreatedAt !== "number" ||
      !Number.isSafeInteger(row.sourceCreatedAt) ||
      row.sourceCreatedAt < 0
    )
      return [];
    return [
      { sourceId: row.sourceId, maxAgeDays: row.maxAgeDays, sourceCreatedAt: row.sourceCreatedAt },
    ];
  });
}
