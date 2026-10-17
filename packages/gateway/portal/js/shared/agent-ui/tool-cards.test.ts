// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — tests browser-only plain-JavaScript portal modules.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_CARDS,
  EPHEMERAL_CARD_TOOLS,
  SILENT_CARD_TOOLS,
  toolCardLabel,
} from "./tool-card-table.js";
import { TOOL_ICON_GLYPHS, toolCardGlyph, WIKI_GLYPH } from "./tool-cards.js";
import { EPHEMERAL_TOOLS, SILENT_TOOLS } from "./reducer.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../../../../../wire-fixtures/agent-tool-cards.json", import.meta.url), "utf8"),
);

describe("agent tool cards", () => {
  it("is the table every client follows", () => {
    expect(JSON.parse(JSON.stringify(AGENT_TOOL_CARDS))).toEqual(fixture);
  });

  it("has a glyph for every icon the table names", () => {
    for (const card of Object.values(fixture)) {
      if (card.icon) expect(TOOL_ICON_GLYPHS[card.icon], card.icon).toBeDefined();
    }
  });

  it("reads a wiki page with the product's wiki glyph", () => {
    expect(toolCardLabel("knowledge_fetch")).toBe("Read wiki page");
    expect(toolCardGlyph("knowledge_fetch")).toBe(WIKI_GLYPH);
  });

  it("keeps older names of renamed tools reading as the tool they became", () => {
    expect(toolCardLabel("time_index_query")).toBe(toolCardLabel("temporal_query"));
    expect(EPHEMERAL_CARD_TOOLS.has("time_index_add")).toBe(true);
  });

  it("dismisses exactly the ephemeral cards, and never draws the silent ones", () => {
    for (const [tool, card] of Object.entries(fixture)) {
      expect(EPHEMERAL_TOOLS.has(tool), tool).toBe(
        card.presentation === "ephemeral" || card.presentation === "subagent",
      );
      expect(SILENT_TOOLS.has(tool), tool).toBe(card.presentation === "silent");
    }
    expect(SILENT_CARD_TOOLS).toBe(SILENT_TOOLS);
  });
});
