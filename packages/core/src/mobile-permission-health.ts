// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  MOBILE_PERMISSION_REPAIR_ACTIONS,
  MOBILE_PERMISSION_REQUIREMENTS,
  MOBILE_PERMISSION_STATES,
} from "@omnesis/types/mobile-permission-health";
import { z } from "zod";

export const MIN_MOBILE_PERMISSION_VALID_FOR_MS = 60_000;
export const MAX_MOBILE_PERMISSION_VALID_FOR_MS = 7 * 24 * 60 * 60 * 1_000;

export const mobilePermissionCapabilitySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/),
    label: z.string().trim().min(1).max(128),
    state: z.enum(MOBILE_PERMISSION_STATES),
    requirement: z.enum(MOBILE_PERMISSION_REQUIREMENTS),
    impact: z.string().trim().min(1).max(512).optional(),
    remediation: z.string().trim().min(1).max(1024).optional(),
    repairAction: z.enum(MOBILE_PERMISSION_REPAIR_ACTIONS),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state === "healthy" || value.state === "unknown") return;
    if (!value.impact) ctx.addIssue({ code: "custom", path: ["impact"], message: "required" });
    if (!value.remediation)
      ctx.addIssue({ code: "custom", path: ["remediation"], message: "required" });
  });

export const mobilePermissionHealthReportSchema = z
  .object({
    checkedAt: z.number().int().nonnegative().safe(),
    validForMs: z
      .number()
      .int()
      .min(MIN_MOBILE_PERMISSION_VALID_FOR_MS)
      .max(MAX_MOBILE_PERMISSION_VALID_FOR_MS),
    capabilities: z.array(mobilePermissionCapabilitySchema).max(64),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [index, capability] of value.capabilities.entries()) {
      if (seen.has(capability.id)) {
        ctx.addIssue({ code: "custom", path: ["capabilities", index, "id"], message: "duplicate" });
      }
      seen.add(capability.id);
    }
  });

export type MobilePermissionHealthReportInput = z.infer<typeof mobilePermissionHealthReportSchema>;
