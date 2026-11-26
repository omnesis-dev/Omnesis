// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { z } from "zod";
import { permissionActionSchema } from "./sync-remediation.js";

/** Bind capability evidence to the selected scope without returning paths or account identifiers. */
export function sourcePermissionScopeDigest(
  descriptorId: string,
  accountId: string | undefined,
  params: unknown,
): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  };
  return createHash("sha256")
    .update(JSON.stringify([descriptorId, accountId ?? null, canonical(params ?? {})]))
    .digest("hex");
}

const safeText = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine((s) => !/[\u0000-\u001f]/u.test(s));
export const sourcePermissionRequirementSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,79}$/u),
    kind: z.enum(["protected-files", "selected-folder"]),
    summary: safeText,
    scope: safeText,
    blocking: z.boolean(),
    actions: z.array(permissionActionSchema).max(8),
  })
  .strict();
export const sourcePermissionsRequestSchema = z
  .object({
    descriptorId: z.string().min(1).max(100),
    accountId: z.string().min(1).max(500).optional(),
    params: z
      .record(z.string().min(1).max(100), z.string().max(4096))
      .refine((p) => Object.keys(p).length <= 64)
      .optional(),
    sourceId: z.string().min(1).max(600).optional(),
    expectedScopeDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict();
export const sourcePermissionsResponseSchema = z
  .object({
    descriptorId: z.string().min(1).max(100),
    sourceId: z.string().min(1).max(600).optional(),
    checkedAt: z.iso.datetime(),
    scopeDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    status: z.enum(["readable", "denied", "unavailable", "unsupported", "not-required"]),
    requirements: z.array(sourcePermissionRequirementSchema).max(16).optional(),
    target: z.literal("unverified"),
    /** Reports the actual collecting engine's pre-publication protection, not a permission grant. */
    publicationGuard: z.literal("managed-v1").optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.publicationGuard && !value.requirements?.some((requirement) => requirement.blocking))
      context.addIssue({
        code: "custom",
        message: "Publication protection requires a blocking access declaration",
      });
    if (value.status === "not-required" && value.requirements?.length !== 0)
      context.addIssue({
        code: "custom",
        message: "No-permission observations require an explicit empty declaration",
      });
    if (value.status === "readable" && !value.requirements?.length)
      context.addIssue({
        code: "custom",
        message: "Read access must be scoped to declared requirements",
      });
    if (value.requirements === undefined && !["unsupported", "unavailable"].includes(value.status))
      context.addIssue({ code: "custom", message: "Legacy requirements cannot imply permission" });
  });
export type SourcePermissionsRequest = z.infer<typeof sourcePermissionsRequestSchema>;
export type SourcePermissionsResponse = z.infer<typeof sourcePermissionsResponseSchema>;
