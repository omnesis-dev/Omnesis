// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — tests browser-only plain-JavaScript portal module identity.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  initialState as portalState,
  reducer as portalReducer,
} from "../../views/agent-reducer.js";
import { initialState, reducer } from "./reducer.js";
import { AssistantMarkdown as portalMarkdown } from "../../components/agent/assistant-markdown.js";
import { AssistantMarkdown } from "./index.js";

describe("shared browser agent presentation contract", () => {
  it("keeps portal imports on the exact shared reducer and Markdown functions", () => {
    expect(portalState).toBe(initialState);
    expect(portalReducer).toBe(reducer);
    expect(portalMarkdown).toBe(AssistantMarkdown);
  });
  it("uses one CSS source and keeps the Chrome export free of gateway services", () => {
    const styles = readFileSync(new URL("../../../css/style.css", import.meta.url), "utf8");
    expect(styles).toContain('@import url("../js/shared/agent-ui/styles.css")');
    expect(styles).not.toContain(".agent-ephemeral {");
    for (const file of readdirSync(new URL(".", import.meta.url)).filter((file) =>
      file.endsWith(".js"),
    )) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(/(?:from|import)\s*["'](?:node:|.*\/router\.js|.*\/api\.js)/u);
    }
  });
});
