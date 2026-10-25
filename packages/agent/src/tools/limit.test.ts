// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toolInputJsonSchema } from "../zod-to-json-schema.js";
import { cappedLimit } from "./limit.js";

describe("cappedLimit", () => {
  const schema = z.object({ limit: cappedLimit(50).optional() }).strict();

  it("reads a request above the maximum as the maximum", () => {
    expect(schema.parse({ limit: 100 })).toEqual({ limit: 50 });
    expect(schema.parse({ limit: 50 })).toEqual({ limit: 50 });
    expect(schema.parse({})).toEqual({});
  });

  it("still refuses a limit that is not a positive integer", () => {
    for (const limit of [0, -3, 2.5, "10", null])
      expect(schema.safeParse({ limit }).success).toBe(false);
  });

  it("still shows the model the real maximum", () => {
    expect(toolInputJsonSchema(schema).properties?.limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 50,
    });
  });
});
