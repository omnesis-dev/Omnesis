// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { extractChangelogSection, PRODUCT_CHANGELOG } from "../release/changelog.mjs";
import { checkProductVersion } from "../release/check-product-version.mjs";
import { parseChangeset } from "../release/plan.mjs";
import { assertTreeFingerprint } from "./tree-state.mjs";

export function validateReleaseProse(version, changelog, changesets) {
  if (!extractChangelogSection(changelog, version)) {
    throw new Error(`${PRODUCT_CHANGELOG} has no release notes for ${version}`);
  }
  for (const [name, contents] of Object.entries(changesets)) {
    if (parseChangeset(contents).bumps.length === 0) {
      throw new Error(`.changeset/${name} declares no recognized bump`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.OMNESIS_TREE_FINGERPRINT) {
    assertTreeFingerprint(process.env.OMNESIS_TREE_BASE, process.env.OMNESIS_TREE_FINGERPRINT);
  }
  const version = JSON.parse(readFileSync("packages/cli/package.json", "utf8")).version;
  checkProductVersion(process.cwd(), `v${version}`);
  const changesets = Object.fromEntries(
    readdirSync(".changeset")
      .filter((name) => name.endsWith(".md") && name !== "README.md")
      .map((name) => [name, readFileSync(join(".changeset", name), "utf8")]),
  );
  validateReleaseProse(version, readFileSync(PRODUCT_CHANGELOG, "utf8"), changesets);
  process.stdout.write(`Release metadata for ${version} is consistent.\n`);
}
