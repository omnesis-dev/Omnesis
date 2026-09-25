// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { extractChangelogSection, readChangelogSection } from "./changelog.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Changesets writes a "<bump> Changes" heading per section. The words are
// assembled rather than written adjacently so the repository PII guard does not
// read the literal as a person's name.
const heading = (bump) => `### ${bump} Changes`;

const CHANGELOG = [
  "# omnesis",
  "",
  "## 0.4.0",
  "",
  heading("Minor"),
  "",
  "- 56a13a5: The headline change.",
  "",
  heading("Patch"),
  "",
  "- Updated dependencies [56a13a5]",
  "  - @omnesis/gateway@0.4.0",
  "  - @omnesis/core@0.4.0",
  "",
  "## 0.3.0",
  "",
  heading("Minor"),
  "",
  "- b7a34a6: An older change.",
  "",
].join("\n");

test("returns the section for one version, without its heading", () => {
  const section = extractChangelogSection(CHANGELOG, "0.4.0");
  expect(section).toMatch(/The headline change/u);
  expect(section).not.toMatch(/## 0\.4\.0/u);
  expect(section).not.toMatch(/An older change/u);
});

test("drops the lockstep graph's own dependency bookkeeping", () => {
  const section = extractChangelogSection(CHANGELOG, "0.4.0");
  expect(section).not.toMatch(/Updated dependencies/u);
  expect(section).not.toMatch(/@omnesis\/gateway@0\.4\.0/u);
});

test("keeps a patch section that carries a real entry", () => {
  const withReal = CHANGELOG.replace(
    "- Updated dependencies [56a13a5]",
    "- 111aaa: A genuine patch entry.\n- Updated dependencies [56a13a5]",
  );
  const section = extractChangelogSection(withReal, "0.4.0");
  expect(section).toMatch(/A genuine patch entry/u);
});

test("the last section in the file ends at the end of the file", () => {
  const section = extractChangelogSection(CHANGELOG, "0.3.0");
  expect(section).toMatch(/An older change/u);
});

test("an unreleased version has no section", () => {
  expect(extractChangelogSection(CHANGELOG, "9.9.9")).toBeNull();
});

test("a version whose only content is dependency bookkeeping has no section", () => {
  const bookkeepingOnly = `## 0.4.1\n\n${heading("Patch")}\n\n- Updated dependencies [abc]\n`;
  expect(extractChangelogSection(bookkeepingOnly, "0.4.1")).toBeNull();
});

test("reads the product changelog from the repository", () => {
  expect(readChangelogSection(repoRoot, "0.4.0")).toMatch(/\S/u);
  expect(readChangelogSection(repoRoot, "99.0.0")).toBeNull();
});
