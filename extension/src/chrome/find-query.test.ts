// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it } from "vitest";
import { parseFindQuery } from "./find-query.js";

it.each([
  [" a useful query ", { text: "a useful query" }],
  [" /search a useful query ", { text: "a useful query", mode: "direct" }],
  ["/AGENT\nmy latest activity", { text: "my latest activity", mode: "agentic" }],
  ["/agent", { text: "", mode: "agentic" }],
  ["a document mentioning /agent", { text: "a document mentioning /agent" }],
  ["/searchable document", { text: "/searchable document" }],
] as const)("parses leading routing commands in %s", (value, expected) => {
  expect(parseFindQuery(value)).toEqual(expected);
});
