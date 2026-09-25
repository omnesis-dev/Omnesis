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
});
