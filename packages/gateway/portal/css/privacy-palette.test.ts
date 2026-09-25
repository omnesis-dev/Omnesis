// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The outcome palette, asserted as colour rather than as token names.
 *
 * Every other test in this tree checks that an outcome resolves to the tone
 * *called* "released" or "kept", which stays true whatever those tokens are
 * painted. This one reads `style.css` and checks the paint: that the two
 * outcomes where an answer reached the caller are green, that the two where
 * none did are amber, and that every chip clears WCAG AA against the tint it
 * is drawn on — the chip is 11.5px semibold, so 4.5:1 applies, not the 3:1
 * large-text threshold.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const CSS = readFileSync(fileURLToPath(new URL("./style.css", import.meta.url)), "utf8");

/**
 * The two blocks that declare the Privacy tokens, oldest-first: the `:root`
 * default and the `[data-theme="light"]` override. They are located by the
 * token they declare rather than by selector, because `:root` appears several
 * times in this sheet and only one of them is the palette.
 */
function privacyBlocks(): string[] {
  const blocks: string[] = [];
  for (const match of CSS.matchAll(/--privacy-released:/g)) {
    const open = CSS.lastIndexOf("{", match.index);
    const close = CSS.indexOf("\n}", match.index);
    blocks.push(CSS.slice(open, close));
  }
  if (blocks.length !== 2) throw new Error(`expected 2 privacy blocks, found ${blocks.length}`);
  return blocks;
}

function declarationsIn(block: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    tokens.set(name, value.trim());
  }
  return tokens;
}

/**
 * A theme's tokens as the browser resolves them: the light block overrides the
 * default rather than replacing it, so a token it leaves alone still carries
 * the default's value.
 */
function tokensOf(themeIndex: number): Map<string, string> {
  const [base, light] = privacyBlocks().map(declarationsIn);
  if (themeIndex === 0) return base;
  return new Map([...base, ...light]);
}

/** Follows `var(--x)` aliases to the literal a token finally resolves to. */
function resolve(tokens: Map<string, string>, name: string, depth = 0): string {
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`unknown token ${name}`);
  const alias = /^var\((--[\w-]+)\)$/.exec(value);
  if (!alias) return value;
  if (depth > 8) throw new Error(`alias cycle at ${name}`);
  return resolve(tokens, alias[1], depth + 1);
}

type Rgb = [number, number, number];

function parseColor(value: string): { rgb: Rgb; alpha: number } {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value);
  if (!rgba) throw new Error(`unparseable colour ${value}`);
  const parts = rgba[1].split(",").map((part) => Number.parseFloat(part.trim()));
  return { rgb: [parts[0], parts[1], parts[2]], alpha: parts.length > 3 ? parts[3] : 1 };
}

function composite(over: string, onto: Rgb): Rgb {
  const { rgb, alpha } = parseColor(over);
  return [0, 1, 2].map((i) => rgb[i] * alpha + onto[i] * (1 - alpha)) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(foreground: Rgb, background: Rgb): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/** Which of red / green / blue dominates, which is what "green" vs "amber" is. */
function family(value: string): "green" | "amber" | "grey" | "red" | "other" {
  const [r, g, b] = parseColor(value).rgb;
  if (g > r * 1.2 && g > b * 1.2) return "green";
  if (r >= g * 1.05 && g > b * 1.5) return "amber";
  if (r > g * 1.5 && r > b * 1.5) return "red";
  if (Math.abs(r - g) < 24 && Math.abs(g - b) < 24) return "grey";
  return "other";
}

const THEMES = [
  { name: "dark", index: 0, page: "#0d1117" },
  { name: "light", index: 1, page: "#ffffff" },
] as const;

describe("privacy outcome palette", () => {
  for (const theme of THEMES) {
    describe(theme.name, () => {
      const tokens = tokensOf(theme.index);
      const page = parseColor(theme.page).rgb;

      test("green means an answer reached the caller, amber means none did", () => {
        expect(family(resolve(tokens, "--privacy-released"))).toBe("green");
        expect(family(resolve(tokens, "--privacy-reduced"))).toBe("green");
        expect(family(resolve(tokens, "--privacy-review"))).toBe("amber");
        expect(family(resolve(tokens, "--privacy-kept"))).toBe("amber");
        expect(family(resolve(tokens, "--privacy-waiting"))).toBe("grey");
        expect(family(resolve(tokens, "--privacy-failed"))).toBe("red");
      });

      test("the answer comparison stays outside the outcome families", () => {
        // A line of a diff is not an outcome, and an outcome colour on one
        // would read as a verdict on that line rather than as which text went.
        expect(family(resolve(tokens, "--privacy-diff-added"))).not.toBe("green");
        expect(family(resolve(tokens, "--privacy-diff-added"))).not.toBe("amber");
        expect(family(resolve(tokens, "--privacy-diff-removed"))).toBe("grey");
      });

      test.each(["released", "reduced", "review", "kept", "waiting", "failed"])(
        "the %s chip clears 4.5:1 on its own tint",
        (tone) => {
          const foreground = parseColor(resolve(tokens, `--privacy-${tone}`)).rgb;
          const background = composite(resolve(tokens, `--privacy-${tone}-bg`), page);
          expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
        },
      );
    });
  }
});
