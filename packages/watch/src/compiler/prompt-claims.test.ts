// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Validator edge cases represented by the compiler's supported watch shapes. */

import { describe, expect, it } from "vitest";

import { loadOntology } from "../universe/paths.js";
import { validateWatch } from "../validator/validate.js";
import { examplesFor } from "./examples.js";

const ontology = loadOntology();

/** Wrap nodes in the smallest watch that can carry them. */
function watchOf(nodes: unknown[], sink: string): unknown {
  return {
    watch: {
      name: "claim-under-test",
      firing_policy: "stays_active",
      ontology_fingerprint: ontology.fingerprint,
      nodes,
      sink: { input: sink },
    },
  };
}

function codesFor(nodes: unknown[], sink: string): string[] {
  return validateWatch(watchOf(nodes, sink), ontology)
    .diagnostics.filter((d) => d.severity === "error")
    .map((d) => d.code);
}

const MAIL = {
  id: "mail",
  type: "source.document_event",
  filter: { source: "gmail", event: ["created"], documentType: "email" },
  output_map: { doc_id: "$e.docId" },
};

const TICK = { id: "tick", type: "source.time", recurring: "0 12 * * *" };

describe("wait, cooldown and persistence deadline validation", () => {
  it.each([
    [
      "stateful.wait",
      {
        id: "n",
        type: "stateful.wait",
        inputs: { mail: { role: "arm" } },
        on_collision: "ignore",
        duration: "3 days",
      },
    ],
    [
      "stateful.cooldown",
      {
        id: "n",
        type: "stateful.cooldown",
        inputs: { mail: { role: "arm" } },
        min_interval: "7 days",
      },
    ],
    [
      "stateful.persistence",
      {
        id: "n",
        type: "stateful.persistence",
        inputs: { mail: { role: "arm" } },
        min_events: 3,
        duration: "2 days",
      },
    ],
  ])("holds for %s: legal without one", (_name, node) => {
    expect(codesFor([MAIL, node], "n")).toEqual([]);
  });

  it.each([
    [
      "stateful.wait",
      {
        id: "n",
        type: "stateful.wait",
        inputs: { mail: { role: "arm" } },
        on_collision: "ignore",
        duration: "3 days",
        deadline: "5 days",
      },
    ],
    [
      "stateful.cooldown",
      {
        id: "n",
        type: "stateful.cooldown",
        inputs: { mail: { role: "arm" } },
        min_interval: "7 days",
        deadline: "5 days",
      },
    ],
    [
      "stateful.persistence",
      {
        id: "n",
        type: "stateful.persistence",
        inputs: { mail: { role: "arm" } },
        min_events: 3,
        duration: "2 days",
        deadline: "5 days",
      },
    ],
  ])("holds for %s: an error with one", (_name, node) => {
    expect(codesFor([MAIL, node], "n")).toContain("DSL_SCHEMA_INVALID");
  });
});

describe("judgement deadline validation", () => {
  const judge = (extra: Record<string, unknown>) => ({
    id: "n",
    type: "llm",
    mode: "judge",
    inputs: { mail: { role: "arm" } },
    proposition: "Worth surfacing",
    output_schema: { decision: "bool" },
    ...extra,
  });

  it("is an error without one", () => {
    expect(codesFor([MAIL, judge({ on_collision: "reset" })], "n")).toContain("DEADLINE_REQUIRED");
  });

  it("is legal with one", () => {
    expect(codesFor([MAIL, judge({ on_collision: "reset", deadline: "1 days" })], "n")).toEqual([]);
  });

  it("is legal without one when the cell accumulates", () => {
    expect(codesFor([MAIL, judge({ on_collision: "accumulate" })], "n")).toEqual([]);
  });
});

describe("max_live_instances validation", () => {
  const judge = (extra: Record<string, unknown>) => ({
    id: "n",
    type: "llm",
    mode: "judge",
    inputs: { mail: { role: "arm" } },
    proposition: "Worth surfacing",
    output_schema: { decision: "bool" },
    deadline: "1 days",
    ...extra,
  });

  it("holds: legal on a spawn node", () => {
    expect(codesFor([MAIL, judge({ on_collision: "spawn", max_live_instances: 3 })], "n")).toEqual(
      [],
    );
  });

  it("holds: rejected on any other collision mode", () => {
    expect(
      codesFor([MAIL, judge({ on_collision: "reset", max_live_instances: 3 })], "n"),
    ).toContain("MAX_LIVE_INSTANCES_WITHOUT_SPAWN");
    expect(
      codesFor([MAIL, judge({ on_collision: "accumulate", max_live_instances: 3 })], "n"),
    ).toContain("MAX_LIVE_INSTANCES_WITHOUT_SPAWN");
  });
});

describe("SQL node state validation", () => {
  const query = (extra: Record<string, unknown>) => ({
    id: "n",
    type: "sql",
    inputs: { tick: { role: "arm" } },
    query:
      "SELECT count(*) > 0 AS fires FROM plaid_transactions WHERE date > $today - INTERVAL 7 DAY",
    ...extra,
  });

  it("holds: bare is instant and needs no collision mode", () => {
    expect(codesFor([TICK, query({})], "n")).toEqual([]);
  });

  it("holds: a collision mode on an instant node is an error", () => {
    expect(codesFor([TICK, query({ on_collision: "reset" })], "n")).toContain(
      "COLLISION_MODE_NOT_APPLICABLE",
    );
  });

  it.each([
    ["a timer", { timer: "1 days", deadline: "30 days" }],
    ["rising-edge detection", { fire_on: "rising_edge", initial_level: "assume_false" }],
  ])("holds: %s makes it stateful, so a collision mode is required", (_name, extra) => {
    expect(codesFor([TICK, query(extra)], "n")).toContain("COLLISION_MODE_REQUIRED");
  });
});

describe("listed analytics tables", () => {
  it("holds: a query against the projected people table validates", () => {
    const node = {
      id: "n",
      type: "sql",
      inputs: { tick: { role: "arm" } },
      query: "SELECT count(*) > 0 AS fires FROM people WHERE is_self = false",
    };
    expect(codesFor([TICK, node], "n")).toEqual([]);
  });
});

describe("sink validation", () => {
  it("holds: a node typed 'sink' is not a node type at all", () => {
    expect(
      codesFor([MAIL, { id: "n", type: "sink", inputs: { mail: { role: "arm" } } }], "n"),
    ).toContain("DSL_SCHEMA_INVALID");
  });
});

describe("compiler vocabulary validation", () => {
  it("holds: a business-day wait is legal", () => {
    const node = {
      id: "n",
      type: "stateful.wait",
      inputs: { mail: { role: "arm" } },
      on_collision: "ignore",
      duration: "5 business_days",
    };
    expect(codesFor([MAIL, node], "n")).toEqual([]);
  });

  it("rejects a FROM clause in stateless.transform", () => {
    const node = {
      id: "n",
      type: "stateless.transform",
      inputs: { mail: { role: "arm" } },
      query: "SELECT count(*) > 0 AS fires FROM plaid_transactions",
    };
    expect(codesFor([MAIL, node], "n")).toContain("SQL_FROM_NOT_ALLOWED");
  });
});

describe("the worked examples agree with the prose", () => {
  it("none of them declares a deadline the schema does not have", () => {
    // The examples are the other half of what the model learns, and a
    // disagreement between them and the prose is a coin toss for the model.
    for (const example of examplesFor()) {
      const nodes = (JSON.parse(example.dsl) as { watch: { nodes: { type: string }[] } }).watch
        .nodes;
      for (const node of nodes) {
        if (["stateful.wait", "stateful.cooldown", "stateful.persistence"].includes(node.type)) {
          expect(node, `${example.name}`).not.toHaveProperty("deadline");
        }
      }
    }
  });
});
