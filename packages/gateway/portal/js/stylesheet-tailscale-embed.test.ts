// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
//
// The gateway's own Tailscale device must be purely additive: with
// OMNESIS_TAILSCALE_EMBED_ENABLED unset, no screen may change. Its CSS lives in
// one fenced block of style.css, and every selector there must name an element
// only the Tailscale page renders. A bare `.btn-primary` rule in that block
// would restyle every page; this test refuses it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const css = readFileSync(
  fileURLToPath(new URL("../css/style.css", import.meta.url)),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, (comment) =>
  comment.includes("tailscale-embed:start")
    ? "@@START@@"
    : comment.includes("tailscale-embed:end")
      ? "@@END@@"
      : " ",
);

/** Rule selectors and keyframe names, walking nested at-rules. */
function walk(source: string) {
  const selectors: string[] = [];
  const keyframes: string[] = [];
  const stack: string[] = [];
  let prelude = "";
  for (const char of source) {
    if (char === "{") {
      const head = prelude.trim();
      prelude = "";
      if (head.startsWith("@keyframes")) {
        keyframes.push(head.slice(10).trim());
        stack.push("keyframes");
      } else if (head.startsWith("@")) stack.push("group");
      else {
        if (!stack.includes("keyframes")) selectors.push(head);
        stack.push("rule");
      }
    } else if (char === "}") {
      stack.pop();
      prelude = "";
    } else if (char === ";" && stack.at(-1) !== "group" && stack.length > 0) prelude = "";
    else prelude += char;
  }
  return { selectors, keyframes };
}

/** Split a selector list on top-level commas, leaving `:is(a, b)` intact. */
function split(list: string): string[] {
  const parts: string[] = [];
  let depth = 0,
    current = "";
  for (const char of list) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += char;
  }
  parts.push(current.trim());
  return parts;
}

describe("Tailscale page styles", () => {
  const start = css.indexOf("@@START@@");
  const end = css.indexOf("@@END@@");

  test("live in one fenced block", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(css.indexOf("@@START@@", start + 1)).toBe(-1);
  });

  test("never style an element the portal renders with the flag off", () => {
    const { selectors, keyframes } = walk(css.slice(start, end).replace("@@START@@", ""));
    expect(selectors.length).toBeGreaterThan(30);
    // Every compound selector must start from a Tailscale-only element.
    const leaking = selectors.flatMap(split).filter((selector) => !/^\.tailscale-/.test(selector));
    expect(leaking).toEqual([]);
    expect(keyframes.every((name) => name.startsWith("tailscale-"))).toBe(true);
  });

  test("have no Tailscale-only rules outside the block", () => {
    const outside = css.slice(0, start) + css.slice(end);
    const { selectors } = walk(outside);
    expect(selectors.flatMap(split).filter((selector) => selector.includes(".tailscale-"))).toEqual([]);
  });
});
