// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Resvg } from "@resvg/resvg-js";
import { rasterizeSvgToPngBase64 } from "./icon-rasterize.js";

// The real render runs through the worker in icon-normalizer.test.ts; these
// cases pin what the renderer is asked to load.
vi.mock("@resvg/resvg-js", () => ({
  Resvg: vi.fn(function () {
    return { render: () => ({ asPng: () => Uint8Array.of(1, 2, 3) }) };
  }),
}));

const svg = (body: string) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>`);

function loadedSystemFonts(body: string): boolean | undefined {
  rasterizeSvgToPngBase64(svg(body), 16);
  return vi.mocked(Resvg).mock.lastCall?.[1]?.font?.loadSystemFonts;
}

describe("rasterizeSvgToPngBase64", () => {
  beforeEach(() => vi.mocked(Resvg).mockClear());

  it("returns the rendered PNG as base64, at the requested width", () => {
    expect(rasterizeSvgToPngBase64(svg("<circle r='9'/>"), 16)).toBe("AQID");
    expect(vi.mocked(Resvg).mock.lastCall?.[1]?.fitTo).toEqual({ mode: "width", value: 16 });
  });

  it("reads no system fonts for an icon without text", () => {
    expect(loadedSystemFonts('<path d="M2 2h20v20H2z"/>')).toBe(false);
    expect(loadedSystemFonts("<title>text</title><desc>A text label</desc>")).toBe(false);
  });

  it("keeps system fonts for an icon that draws text", () => {
    expect(loadedSystemFonts('<text x="2" y="20">Aa</text>')).toBe(true);
    expect(loadedSystemFonts("<text>Aa</text>")).toBe(true);
    expect(
      loadedSystemFonts('<g xmlns:s="http://www.w3.org/2000/svg"><s:text>Aa</s:text></g>'),
    ).toBe(true);
  });
});
