// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import source from "./index.js";

test("advertises the native source glyph and colour as a portable image", () => {
  const native = readFileSync(
    new URL(
      "../../../../ios/Sources/Omnesis/CoreLocationVisits/CoreLocationVisitsIcon.swift",
      import.meta.url,
    ),
    "utf8",
  );
  const nativeSvg = native.match(/<svg\b[\s\S]*?<\/svg>/)?.[0];
  expect(nativeSvg).toBeDefined();
  expect(source.icon).toMatchObject({ sfSymbol: "location.fill", color: "#FF9F0A" });
  expect(source.icon?.imageDataUri).toMatch(/^data:image\/svg\+xml;base64,/);
  const svg = Buffer.from(source.icon!.imageDataUri!.split(",")[1]!, "base64").toString("utf8");
  expect(svg).toBe(nativeSvg);
  expect(svg).toContain('stroke="#FF9F0A"');
});
