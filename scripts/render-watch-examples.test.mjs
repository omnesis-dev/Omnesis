// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The watch carousel is generated from the definitions in
 * render-watch-examples.mjs — both the JSON it shows and the graph beside it.
 * Two things have to stay true, and neither is obvious by reading the page:
 *
 *   1. the committed HTML is what the generator produces today, and
 *   2. every example is a watch the runtime would actually accept.
 *
 * The second is the one worth having. A marketing page is free to print any
 * JSON at all; this asserts the DSL on the page would validate if it were
 * installed, so an example cannot quietly drift from the language it claims
 * to be written in.
 */

import { expect, test } from "vitest";
import { watchDslSchema } from "@omnesis/watch";
import { EXAMPLES, renderFile } from "./render-watch-examples.mjs";

test("website/brain.html carries a freshly rendered watch carousel", async () => {
  const { before, after } = await renderFile();
  expect(before).toBe(after);
});

test.each(EXAMPLES.map((e) => [e.id, e]))("%s is a valid watch definition", (_id, example) => {
  const result = watchDslSchema.safeParse(example.dsl);
  const problems = result.success
    ? []
    : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  expect(problems).toEqual([]);
});

test("the examples span the node kinds the section claims", () => {
  const types = new Set(EXAMPLES.flatMap((e) => e.dsl.watch.nodes.map((n) => n.type)));
  // A source, a combinator, raw SQL and a model pass — the four the standfirst
  // names. An example set that lost one of these would stop illustrating it.
  expect(types.has("source.document_event") || types.has("source.analytics_row")).toBe(true);
  expect(types.has("stateful.wait") || types.has("stateful.and")).toBe(true);
  expect(types.has("sql")).toBe(true);
  expect(types.has("llm")).toBe(true);
});
