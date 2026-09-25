// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import definition from "./index.js";

describe("things definition", () => {
  test("has correct type and metadata", () => {
    expect(definition.type).toBe("source");
    expect(definition.id).toBe("things");
    expect(definition.name).toBe("Things 3");
    expect(definition.authType).toBe("local");
    expect(definition.unitName).toBe("tasks");
    expect(definition.singleInstance).toBe(true);
  });

  test("provider field is undefined (defaults match)", () => {
    expect(definition.provider).toBeUndefined();
  });

  test("has discover function", () => {
    expect(typeof definition.discover).toBe("function");
  });

  test("has create function", () => {
    expect(typeof definition.create).toBe("function");
  });

  test("has icon with hosted url", () => {
    expect(definition.icon).toBeDefined();
    expect(definition.icon!.url).toMatch(/^https:\/\//);
  });
});
