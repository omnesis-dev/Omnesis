// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Shared zod atoms used across multiple route schemas. Keep this file small —
 * everything here should be reused at least twice.
 */
import { z } from "zod";
import { sourceContractWireRangeSchema } from "@omnesis/core";
import {
  DEVICE_KINDS,
  MULTI_DEVICE_MODES,
  isValidScope,
  Scope,
  trySourceType,
  type Scope as ScopeType,
} from "@omnesis/types";
import {
  isSafeKnownUrlPattern,
  MAX_KNOWN_URL_PATTERN_LENGTH,
} from "../../known-url-pattern-safety.js";

/** Non-empty trimmed string. */
export const nonEmptyString = z.string().min(1);

/** A bounded URL-id expression accepted by the non-backtracking matcher. */
export const urlPatternRegexSchema = z
  .string()
  .min(1)
  .max(MAX_KNOWN_URL_PATTERN_LENGTH)
  .refine(isSafeKnownUrlPattern, { message: "must be a supported safe regular expression" });

export const urlPatternSpecSchema = z.object({
  regex: urlPatternRegexSchema,
  idGroup: z.number().int().nonnegative().optional(),
});

/** Device kind, narrowed to the union from `@omnesis/core`. */
export const deviceKindSchema = z.enum(DEVICE_KINDS);

/**
 * Single scope string, validated via `isValidScope` and re-branded as `Scope`
 * so call-sites accepting `Scope[]` don't need an extra cast.
 */
export const scopeSchema = z
  .string()
  .refine(isValidScope, { message: "invalid scope" })
  .transform((s): ScopeType => Scope(s));

/** Non-empty array of scopes (branded as `Scope[]`). */
export const scopeArraySchema = z.array(scopeSchema).min(1);

const sourceTypeSchema = z.string().transform((s, ctx) => {
  const sourceType = trySourceType(s);
  if (!sourceType) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid source type" });
    return z.NEVER;
  }
  return sourceType;
});

/** Device capability — open record; collectors and native clients each carry their own shape. */
export const deviceCapabilitySchema = z
  .object({
    sourceContract: sourceContractWireRangeSchema.optional(),
    hostableSourceTypes: z.array(sourceTypeSchema).optional(),
    pushBasedSourceTypes: z.array(sourceTypeSchema).optional(),
    multiDeviceModes: z.record(sourceTypeSchema, z.enum(MULTI_DEVICE_MODES)).optional(),
    replicaVersionPolicies: z.record(sourceTypeSchema, z.literal("source-updated-at")).optional(),
    syncLease: z.boolean().optional(),
    deviceDoctor: z.literal(true).optional(),
    pushAppId: z.string().trim().min(1).max(255).optional(),
    // Pair-time adoption keys: the client's per-install identity and the
    // device id it was last paired as.
    installId: z.string().trim().min(1).max(120).optional(),
    previousDeviceId: z.string().uuid().optional(),
    agentIntegration: z
      .object({
        harness: z.enum(["openclaw", "hermes"]),
        // A range, not a pin: the gateway speaks a span of delivery
        // versions and each plugin says which it understands, so the two can
        // be upgraded independently.
        deliveryProtocolMin: z.number().int().positive().max(64),
        deliveryProtocolMax: z.number().int().positive().max(64),
        maxConcurrentRuns: z.number().int().positive().max(128),
        watchPrivacyPolicyVersion: z.literal(1).optional(),
      })
      .strict()
      .refine((capability) => capability.deliveryProtocolMin <= capability.deliveryProtocolMax, {
        message: "the protocol range must not be inverted",
      })
      .optional(),
  })
  .passthrough();

/** Generic params record (string → string), used by source.add / auth.start. */
export const stringParamsSchema = z.record(z.string(), z.string());

/** RFC 5322-ish basic email shape: `local@domain.tld`. */
export const emailLikeSchema = z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "invalid email");
