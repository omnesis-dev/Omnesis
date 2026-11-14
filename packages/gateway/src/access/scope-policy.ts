// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import * as z from "zod/v4";
import { FILTER_IDENTIFIER_ERRORS, canonicalFilterIdentifier } from "@omnesis/core";
import { compileSourceFilter } from "./filter-sql.js";
import type { SourceFilterFields } from "./filter-fields.js";
import type { FilterIdentifier, FilterRef, SourceFilter } from "@omnesis/types";

/** Entries, counting each identifier of a person entry, one filter may hold. */
export const SOURCE_FILTER_MAX_ENTRIES = 256;

const stableId = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim().length > 0);

/**
 * A typed identifier in the one spelling records are compared in, so a filter
 * typed with separators, capitals or a `tel:` prefix names the same person as
 * one picked from a list.
 */
export const filterIdentifierSchema = z
  .strictObject({ type: z.enum(["phone", "email", "domain"]), value: z.string().max(512) })
  .transform((identifier, context): FilterIdentifier => {
    const canonical = canonicalFilterIdentifier(identifier.type, identifier.value);
    if (canonical) return canonical;
    context.addIssue({
      code: "custom",
      path: ["value"],
      message: FILTER_IDENTIFIER_ERRORS[identifier.type],
    });
    return z.NEVER;
  });

const fieldRef = (capability: "membership" | "tree") =>
  z
    .strictObject({
      capability: z.literal(capability),
      field: stableId,
      /** `""` with a device names the whole device. */
      id: z.string().max(512),
      device: stableId.optional(),
    })
    .refine((ref) => ref.id.trim() !== "" || (ref.id === "" && ref.device !== undefined), {
      message: "An entry must name an item or a device.",
    });

export const filterRefSchema = z.union([
  fieldRef("membership"),
  fieldRef("tree"),
  z.strictObject({
    capability: z.literal("person"),
    label: z.string().trim().min(1).max(512),
    identifiers: z.array(filterIdentifierSchema).min(1).max(SOURCE_FILTER_MAX_ENTRIES),
  }),
]);

/** What one filter holds, counting each identifier of a person entry. */
export function sourceFilterEntryCount(
  filters: ReadonlyArray<{
    rules: ReadonlyArray<{
      match: ReadonlyArray<{ capability: string; identifiers?: readonly unknown[] }>;
    }>;
  }>,
): number {
  return filters.reduce(
    (total, filter) =>
      total +
      filter.rules.reduce(
        (sum, rule) =>
          sum +
          rule.match.reduce(
            (count, ref) =>
              count + (ref.capability === "person" ? (ref.identifiers?.length ?? 0) : 1),
            0,
          ),
        0,
      ),
    0,
  );
}

/** The two filter shapes, share-only and hide. Unknown fields fail rather than disappear. */
export const sourceFilterSchema = z
  .strictObject({
    sourceId: stableId,
    audience: z.strictObject({
      accessLevel: stableId,
      capability: z.enum(["direct", "answer"]),
    }),
    rules: z
      .array(
        z.strictObject({
          match: z.array(filterRefSchema).max(SOURCE_FILTER_MAX_ENTRIES),
          action: z.enum(["share", "hide"]),
        }),
      )
      .length(1),
    otherwise: z.enum(["share", "hide"]),
  })
  .refine((filter) => sourceFilterEntryCount([filter]) <= SOURCE_FILTER_MAX_ENTRIES, {
    message: `A filter can contain at most ${SOURCE_FILTER_MAX_ENTRIES} identifiers or items.`,
  })
  .refine((filter) => filter.rules[0]?.action !== filter.otherwise, {
    message: "Choose only these or everything except these.",
  })
  .transform((filter) => filter as SourceFilter);

/**
 * Read a filter an owner saves: its shape, then every entry against what the
 * source declares filterable. A filter this gateway could not apply is
 * refused here rather than saved to hide the whole account later.
 */
export function parseSourceFilter(input: unknown, fields: SourceFilterFields): SourceFilter {
  const filter = sourceFilterSchema.parse(input);
  const compiled = compileSourceFilter(filter, fields);
  if (compiled.unusable !== null)
    throw new Error(`This filter cannot be applied to this source: ${compiled.unusable}.`);
  return filter;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalRef(input: FilterRef): FilterRef {
  if (input.capability === "person")
    return {
      capability: "person",
      label: input.label,
      identifiers: input.identifiers
        .map((identifier) => ({ type: identifier.type, value: identifier.value }))
        .sort((left, right) => compare(left.type, right.type) || compare(left.value, right.value)),
    };
  return {
    capability: input.capability,
    field: input.field,
    id: input.id,
    ...(input.device === undefined ? {} : { device: input.device }),
  };
}

/** Canonicalize unordered entry lists and the filters' order, keeping saved identifiers intact. */
export function canonicalSourceFilters(filters: readonly SourceFilter[]): SourceFilter[] {
  return filters
    .map((filter): SourceFilter => ({
      sourceId: filter.sourceId,
      audience: {
        accessLevel: filter.audience.accessLevel,
        capability: filter.audience.capability,
      },
      rules: filter.rules.map((rule) => ({
        match: rule.match
          .map(canonicalRef)
          .sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right))),
        action: rule.action,
      })) as SourceFilter["rules"],
      otherwise: filter.otherwise,
    }))
    .sort((left, right) => compare(left.sourceId, right.sourceId));
}
