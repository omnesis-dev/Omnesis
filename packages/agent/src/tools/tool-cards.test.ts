// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { AGENT_TOOL_CARDS } from "@omnesis/core";
import { buildBuiltinTools } from "./registry.js";
import type { ToolPorts } from "./types.js";

// Construction never calls a port, so every port can be an empty stand-in.
const port = {} as never;
const ports: ToolPorts = {
  search: port,
  document: port,
  person: port,
  trail: port,
  sql: port,
  record: port,
  documentByUrl: port,
  watch: port,
  subagent: port,
  loopRead: port,
  temporal: port,
  entityContext: port,
};

describe("agent tool cards", () => {
  it("decides how every builtin tool reads in a transcript", () => {
    const names = buildBuiltinTools({ ports, experimental: true }).map((tool) => tool.name);
    // The batch tools draw each child as its singular tool.
    for (const name of [...names, "search_documents", "fetch_document", "annotate"])
      expect(AGENT_TOOL_CARDS[name], name).toBeDefined();
  });

  it("gives every drawn card a label and glyph", () => {
    for (const [name, card] of Object.entries(AGENT_TOOL_CARDS)) {
      if (card.presentation !== "ephemeral") continue;
      expect(card.label, name).toBeTruthy();
      expect(card.icon, name).toBeTruthy();
    }
  });
});
