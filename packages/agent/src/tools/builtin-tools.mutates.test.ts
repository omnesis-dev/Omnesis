// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The write classification of every shippable tool, pinned.
 *
 * `selectSubagentTools` withholds writes from a delegated session by asking
 * each handle whether it mutates. That is only a real guarantee if every
 * handle answers — a tool added next month with the field left off is inherited
 * by every sub-agent, every specialist and the watch compiler, and nothing
 * about it looks wrong.
 *
 * So this is an inventory rather than a rule: the whole of `buildBuiltinTools`
 * with each tool's answer beside it. Adding a tool reddens this test, and
 * turning it green means writing down what the new tool does. That is the whole
 * point — the classification is not something anybody has to remember to make.
 *
 * Scope is exactly that catalog, which is what `AgentService.listTools()`
 * returns and therefore what every delegated selection starts from. Tools built
 * per session elsewhere — the Cognition Steward's own handles — never enter it,
 * and are guarded where they are built.
 */

import { describe, expect, it } from "vitest";

import { allToolPorts } from "./builtin-tools.fixture.js";
import { buildBuiltinTools, selectSharedTools, selectSubagentTools } from "./registry.js";

/**
 * Every tool the catalog can build, and whether it writes.
 *
 * `annotate_many` is deliberately `false`. It persists citation rows, but it is
 * the one way a delegated worker hands evidence back to its parent, so the
 * write classification would take that away. A surface that must not leave
 * citation rows behind drops it by name with `selectNonCitationTools` instead.
 */
const CATALOG: ReadonlyArray<readonly [name: string, mutates: boolean]> = [
  ["search_many", false],
  ["fetch_many", false],
  ["annotate_many", false],
  ["plan", false],
  ["trace_connections", false],
  ["run_sql", false],
  ["cite_record", true],
  ["lookup_people", false],
  ["lookup_document_by_url", false],
  ["watches_list", false],
  ["watch_get", false],
  ["watch_probe", false],
  ["watch_create", true],
  ["watch_update", true],
  ["watch_delete", true],
  ["spawn_subagent", false],
  ["join_subagents", false],
  ["search_loops", false],
  ["fetch_loop", false],
  ["list_loops", false],
  ["temporal_query", false],
  ["entity_context", false],
];

describe("built-in tool write classification", () => {
  it("classifies every tool the catalog builds", () => {
    const tools = buildBuiltinTools({ ports: allToolPorts(), experimental: true });
    const actual = tools.map((tool) => [tool.name, tool.mutates === true] as const);
    expect([...actual].sort()).toEqual([...CATALOG].sort());
  });

  it("withholds exactly the writing tools from a delegated session", () => {
    const tools = buildBuiltinTools({ ports: allToolPorts(), experimental: true });
    const inherited = new Set(selectSubagentTools(tools).map((tool) => tool.name));
    for (const [name, mutates] of CATALOG) {
      expect([name, inherited.has(name)]).toEqual([name, !mutates]);
    }
  });

  it("cannot be re-granted a writing tool by an explicit allowlist", () => {
    const tools = buildBuiltinTools({ ports: allToolPorts(), experimental: true });
    const writers = CATALOG.filter(([, mutates]) => mutates).map(([name]) => name);
    expect(writers.length).toBeGreaterThan(0);
    const requested = selectSubagentTools(tools, [...writers, "search_many"]).map(
      (tool) => tool.name,
    );
    expect(requested).toEqual(["search_many"]);
  });
});

/**
 * The probe hands back the runtime's own words about documents in this corpus
 * — per-sample reasons, per-node diagnostics. That is fine for the person
 * whose corpus it is, and a disclosure for anyone else. Nothing on the handle
 * distinguishes it (it writes nothing), so the exclusion is by name, and this
 * is what keeps the name honest.
 */
describe("tools only the operator's own conversation holds", () => {
  it("keeps the probe out of every shared tool set", () => {
    const tools = buildBuiltinTools({ ports: allToolPorts(), experimental: true });
    expect(
      tools.map((t) => t.name),
      "the probe was not built at all",
    ).toContain("watch_probe");

    const shared = new Set(selectSharedTools(tools).map((t) => t.name));
    expect(shared.has("watch_probe"), "an off-host caller can read corpus samples").toBe(false);
    // And nothing else was taken with it: the exclusion is one tool, not a
    // category that quietly grows.
    expect(tools.length - shared.size).toBe(1);
  });

  it("would not be withheld by the write filter alone", () => {
    // The reason a name list exists here. `selectSubagentTools` asks the handle
    // whether it writes, and this one does not — so without the name it is
    // inherited by every off-host caller by default.
    const tools = buildBuiltinTools({ ports: allToolPorts(), experimental: true });
    const byWrites = new Set(selectSubagentTools(tools).map((t) => t.name));
    expect(byWrites.has("watch_probe")).toBe(true);
  });
});
