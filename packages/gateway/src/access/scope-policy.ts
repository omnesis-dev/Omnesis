// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import * as z from "zod/v4";
import { normalizeEmail } from "@omnesis/core";
import type { ScopePolicy, ScopeRef, SourceScopes } from "@omnesis/types";

const stableId = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim().length > 0);
export const scopeIdentifierSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("phone"),
    value: z.string().regex(/^\+[1-9][0-9]{6,14}$/, "Use an international phone number."),
  }),
  z.strictObject({ type: z.literal("email"), value: z.email().max(320).transform(normalizeEmail) }),
  z.strictObject({
    type: z.literal("domain"),
    value: z
      .string()
      .max(253)
      .toLowerCase()
      .regex(
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
        "Use a domain such as example.org.",
      ),
  }),
]);
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
