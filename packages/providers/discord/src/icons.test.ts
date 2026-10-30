// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { discordIcon } from "./icons.js";
import discordProvider from "./index.js";

describe("discordIcon", () => {
  it("is complete for every client: symbol, colours, and a renderable bundled SVG", () => {
    expect(discordIcon.sfSymbol).toBeTruthy();
    expect(discordIcon.color).toMatch(/^#[0-9A-F]{6}$/i);
    expect(discordIcon.bgColor).toMatch(/^#[0-9A-F]{6}$/i);
    expect(discordIcon.imageDataUri).toMatch(/^data:image\/svg\+xml;base64,/);
    const svg = Buffer.from(discordIcon.imageDataUri!.split(",")[1], "base64").toString();
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain('fill="#5865F2"');
    expect(svg.length).toBeLessThan(4096);
  });

  it("is the icon on the descriptor", () => {
    expect(discordProvider.sources[0].icon).toBe(discordIcon);
  });
});
