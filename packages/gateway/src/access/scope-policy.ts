// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import * as z from "zod/v4";
import { canonicalScopeIdentifier } from "@omnesis/source-sdk";
import type { ScopeIdentifier, ScopePolicy, ScopeRef, SourceScopes } from "@omnesis/types";

const stableId = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim().length > 0);
const IDENTIFIER_HINTS = {
  phone: "Use an international phone number.",
  email: "Use an email address such as person@example.org.",
  domain: "Use a domain such as example.org.",
} as const;
/**
 * Saved identifiers and source-declared facts take the same canonical
 * spelling, so a filter typed with separators, capitals or a display name
 * still equals the fact it names.
 */
export const scopeIdentifierSchema = z
  .strictObject({ type: z.enum(["phone", "email", "domain"]), value: z.string().max(512) })
  .transform((identifier, context): ScopeIdentifier => {
    const canonical = canonicalScopeIdentifier(identifier.type, identifier.value);
    if (canonical) return canonical;
    context.addIssue({
      code: "custom",
      path: ["value"],
      message: IDENTIFIER_HINTS[identifier.type],
    });
    return z.NEVER;
  });
export const scopeRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("conversation"), id: stableId }),
  z.strictObject({ kind: z.literal("label"), id: stableId }),
  z.strictObject({ kind: z.literal("folder"), id: stableId }),
  z.strictObject({
    kind: z.literal("participant"),
    label: z.string().trim().min(1).max(512),
    identifiers: z.array(scopeIdentifierSchema).min(1).max(256),
  }),
]);

/** Exactly the two V1 list shapes. Unknown fields fail rather than disappear. */
export const scopePolicyV1Schema = z
  .strictObject({
    sourceId: stableId,
    audience: z.strictObject({
      accessLevel: stableId,
      capability: z.enum(["direct", "answer"]),
    }),
    rules: z
      .array(
        z.strictObject({
          match: z.array(scopeRefSchema).max(256),
          action: z.enum(["share", "hide"]),
        }),
      )
      .length(1),
    otherwise: z.enum(["share", "hide"]),
  })
  .refine(
    (policy) =>
      policy.rules.reduce(
        (total, rule) =>
          total +
          rule.match.reduce(
            (count, ref) => count + (ref.kind === "participant" ? ref.identifiers.length : 1),
            0,
          ),
        0,
      ) <= 256,
    { message: "A filter can contain at most 256 identifiers or items." },
  )
  .refine((policy) => policy.rules[0]?.action !== policy.otherwise, {
    message: "Choose only these or everything except these.",
  });

/** Enforce the source's declaration as well as the generic wire shape. */
export function parseScopePolicyV1(input: unknown, scopes: SourceScopes): ScopePolicy {
  const policy = scopePolicyV1Schema.parse(input);
  for (const rule of policy.rules) {
    for (const ref of rule.match) {
      const declaration = scopes.items.find((item) => item.kind === ref.kind);
      if (!declaration) throw new Error(`This source does not support ${ref.kind} filters.`);
      if (ref.kind === "participant" && declaration.kind === "participant") {
        for (const identifier of ref.identifiers) {
          if (!declaration.identifiers.includes(identifier.type)) {
            throw new Error(`This source does not identify people by ${identifier.type}.`);
          }
        }
      }
    }
  }
  return policy;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Canonicalize unordered OR lists, keeping ordered rules and saved identifiers intact. */
export function canonicalScopePolicies(policies: readonly ScopePolicy[]): ScopePolicy[] {
  function ref(input: ScopeRef): ScopeRef {
    if (input.kind !== "participant") return { kind: input.kind, id: input.id };
    return {
      kind: "participant",
      label: input.label,
      identifiers: input.identifiers
        .map((identifier) => ({
          type: identifier.type,
          value: identifier.value,
        }))
        .sort((left, right) => compare(left.type, right.type) || compare(left.value, right.value)),
    };
  }
  return policies
    .map((policy) => ({
      sourceId: policy.sourceId,
      audience:
        typeof policy.audience === "string"
          ? policy.audience
          : {
              accessLevel: policy.audience.accessLevel,
              capability: policy.audience.capability,
            },
      rules: policy.rules.map((rule) => ({
        match: rule.match
          .map(ref)
          .sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right))),
        action: rule.action,
      })),
      otherwise: policy.otherwise,
      ...(policy.maxAge === undefined ? {} : { maxAge: policy.maxAge }),
    }))
    .sort((left, right) => compare(left.sourceId, right.sourceId));
}
