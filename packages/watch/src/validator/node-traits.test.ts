// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { SOURCE_NODE_TYPES, nodeSchema, type WatchNodeType } from "../dsl/schema.js";
import { NODE_TRAITS, isStateful } from "./node-traits.js";

describe("node traits", () => {
  const declared = nodeSchema.options.map((o) => o.shape.type.value as WatchNodeType).sort();

  it("covers every node type the DSL defines", () => {
    // The table's type already forces this at compile time; asserting it here
    // catches the case where both drift together in a refactor.
    expect(Object.keys(NODE_TRAITS).sort()).toEqual(declared);
  });

  it("agrees with the schema about which node types are trip-wires", () => {
    const fromTraits = Object.entries(NODE_TRAITS)
      .filter(([, traits]) => traits.source)
      .map(([type]) => type)
      .sort();
    expect(fromTraits).toEqual([...SOURCE_NODE_TYPES].sort());
  });

  it("gives a source node nothing to collide with and nothing to cancel", () => {
    for (const type of SOURCE_NODE_TYPES) {
      expect(NODE_TRAITS[type].collisionModes).toEqual([]);
      expect(NODE_TRAITS[type].cancellable).toBe(false);
    }
  });

  it("reads a SQL node's statefulness off its fields, not its type", () => {
    const base = { id: "q", type: "sql", inputs: {}, query: "SELECT true AS fires" } as const;
    expect(isStateful({ ...base } as never)).toBe(false);
    expect(isStateful({ ...base, timer: "1 hours" } as never)).toBe(true);
    expect(isStateful({ ...base, persistence: "2 days" } as never)).toBe(true);
    expect(isStateful({ ...base, fire_on: "rising_edge" } as never)).toBe(true);
    expect(isStateful({ ...base, fire_on: "every_true" } as never)).toBe(false);
  });

  it("treats every non-SQL node type as decided by its type alone", () => {
    for (const [type, traits] of Object.entries(NODE_TRAITS)) {
      if (type === "sql") continue;
      expect(traits.stateful).not.toBe("by-shape");
    }
  });
});
