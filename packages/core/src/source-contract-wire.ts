// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";

/**
 * Source sync wire capabilities, independent of database and authoring versions.
 * Revision 1 includes partition claims, analytics row keys, scoped analytics
 * reads, versioned cursors, and typed authentication challenges.
 */
export const SOURCE_CONTRACT_WIRE_VERSION = 1;
export const SOURCE_CONTRACT_WIRE_MIN_VERSION = 1;

export const SOURCE_CONTRACT_WIRE_RANGE = {
  min: SOURCE_CONTRACT_WIRE_MIN_VERSION,
  max: SOURCE_CONTRACT_WIRE_VERSION,
} as const;

export const sourceContractWireRangeSchema = z
  .object({ min: z.number().int().positive(), max: z.number().int().positive() })
  .refine((range) => range.min <= range.max);

const sourceContractHealth = z.object({
  status: z.literal("ok"),
  capabilities: z
    .object({
      sourceContract: sourceContractWireRangeSchema.optional(),
    })
    .optional(),
});

export function assertGatewaySourceContract(health: unknown): void {
  const result = sourceContractHealth.safeParse(health);
  if (!result.success)
    throw new Error("Cannot verify gateway source contract: invalid health response");
  const range = result.data.capabilities?.sourceContract;
  if (!range || range.max < SOURCE_CONTRACT_WIRE_MIN_VERSION) {
    throw new Error(
      "Gateway upgrade required: upgrade the gateway before this collector; source sync and authentication are paused until the gateway supports the source contract",
    );
  }
  if (range.min > SOURCE_CONTRACT_WIRE_VERSION) {
    throw new Error("Collector upgrade required: the gateway requires a newer source contract");
  }
}
