// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { zodToJsonSchema } from "./zod-to-json-schema.js";

describe("zodToJsonSchema", () => {
  it("converts a flat object with required + optional fields", () => {
    const schema = z.object({
      query: z.string().min(1).describe("the query"),
      limit: z.number().int().min(1).max(50).optional(),
      sort: z.enum(["relevance", "recency"]).optional(),
    });
    const out = zodToJsonSchema(schema);
    expect(out.type).toBe("object");
    expect(out.required).toEqual(["query"]);
    expect(out.properties?.query).toMatchObject({
      type: "string",
      minLength: 1,
      description: "the query",
    });
    expect(out.properties?.limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 50,
    });
    expect(out.properties?.sort).toMatchObject({
      type: "string",
      enum: ["relevance", "recency"],
    });
  });

  it("converts arrays of primitives + nested objects", () => {
    const schema = z.object({
      tags: z.array(z.string()),
      filters: z
        .object({
          dateFrom: z.string().optional(),
          dateTo: z.string().optional(),
        })
        .optional(),
    });
    const out = zodToJsonSchema(schema);
    expect(out.properties?.tags).toMatchObject({ type: "array" });
    expect(out.properties?.tags?.items).toMatchObject({ type: "string" });
    expect(out.properties?.filters).toMatchObject({ type: "object" });
    expect(out.properties?.filters?.required).toBeUndefined();
  });

  it("preserves descriptions on optional fields", () => {
    const schema = z.object({
      foo: z.boolean().optional().describe("toggle foo"),
    });
    const out = zodToJsonSchema(schema);
    expect(out.properties?.foo).toMatchObject({
      type: "boolean",
      description: "toggle foo",
    });
  });

  it("unwraps ZodEffects so refined object schemas keep type: object", () => {
    const schema = z
      .object({
        documentId: z.string().min(1),
        quote: z.string().optional(),
        note: z.string().optional(),
      })
      .refine((a) => a.quote !== undefined || a.note !== undefined, {
        message: "at least one of quote/note required",
      });
    const out = zodToJsonSchema(schema);
    expect(out.type).toBe("object");
    expect(out.properties?.documentId).toMatchObject({ type: "string" });
    expect(out.required).toEqual(["documentId"]);
  });

  it("exposes discriminated branches, required fields and strict nested objects", () => {
    const schema = z
      .object({
        assessment: z
          .discriminatedUnion("status", [
            z
              .object({
                status: z.literal("integrated"),
                links: z
                  .array(z.object({ otherRevision: z.number().int().nonnegative() }).strict())
                  .min(1)
                  .max(16),
              })
              .strict(),
            z.object({ status: z.literal("standalone"), reason: z.string() }).strict(),
          ])
          .optional(),
      })
      .strict();
    const out = zodToJsonSchema(schema);
    expect(out.additionalProperties).toBe(false);
    expect(out.required).toBeUndefined();
    expect(out.properties?.assessment?.anyOf?.[0]).toMatchObject({
      type: "object",
      required: ["status", "links"],
      additionalProperties: false,
      properties: {
        status: { type: "string", enum: ["integrated"] },
        links: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          items: {
            type: "object",
            required: ["otherRevision"],
            additionalProperties: false,
            properties: { otherRevision: { type: "integer", minimum: 0 } },
          },
        },
      },
    });
    expect(out.properties?.assessment?.anyOf?.[1]?.properties?.status).toEqual({
      type: "string",
      enum: ["standalone"],
    });
  });

  it("keeps dynamic version maps open while constraining each union value", () => {
    const schema = z
      .object({
        versions: z.record(z.string(), z.union([z.string(), z.number().int().nonnegative()])),
      })
      .strict();
    const out = zodToJsonSchema(schema);
    expect(out.additionalProperties).toBe(false);
    expect(out.properties?.versions).toEqual({
      type: "object",
      additionalProperties: { anyOf: [{ type: "string" }, { type: "integer", minimum: 0 }] },
    });
  });
  it("exposes null as a constrained branch in primitive record unions", () => {
    expect(
      zodToJsonSchema(
        z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
      ),
    ).toEqual({
      type: "object",
      additionalProperties: {
        anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }],
      },
    });
  });

  it.each([
    ["flag", true, "boolean"],
    ["count", 3, "number"],
    ["empty", null, "null"],
  ] as const)("preserves %s scalar literals", (_name, value, type) => {
    expect(zodToJsonSchema(z.literal(value))).toEqual({ type, enum: [value] });
  });

  it("preserves explicit null while requiring nullable fields and honoring both optional wrapper orders", () => {
    const out = zodToJsonSchema(
      z.object({
        required: z.string().nullable(),
        outerOptional: z.string().nullable().optional(),
        innerOptional: z.string().optional().nullable(),
        defaulted: z.string().nullable().default(null),
      }),
    );
    expect(out.required).toEqual(["required"]);
    for (const key of ["required", "outerOptional", "innerOptional", "defaulted"])
      expect(out.properties?.[key]?.anyOf).toEqual([{ type: "string" }, { type: "null" }]);
  });

  it("preserves exact array length and nested union descriptions", () => {
    const out = zodToJsonSchema(
      z.array(z.union([z.string(), z.number()]).describe("a label or amount")).length(2),
    );
    expect(out).toEqual({
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: { anyOf: [{ type: "string" }, { type: "number" }], description: "a label or amount" },
    });
  });
});
