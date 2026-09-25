// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { validateReleaseProse } from "./check-product-version.mjs";

const heading = (bump) => `### ${bump} Changes`;
const changelog = `# Product\n\n## 0.4.6\n\n${heading("Patch")}\n\n- A fictional fix.\n`;

test("accepts release notes and changesets with a declared bump", () => {
  expect(() =>
    validateReleaseProse("0.4.6", changelog, {
      "fictional.md": '---\n"@example/package": patch\n---\n\nA fictional fix.\n',
    }),
  ).not.toThrow();
});

test("rejects missing release notes and changesets without a bump", () => {
  expect(() => validateReleaseProse("0.4.7", changelog, {})).toThrow(/no release notes/u);
  expect(() =>
    validateReleaseProse("0.4.6", changelog, { "fictional.md": "---\n---\nNo bump.\n" }),
  ).toThrow(/declares no recognized bump/u);
});
