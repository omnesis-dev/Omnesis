// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Reading one version's section out of the changeset-generated changelog.
 *
 * `packages/cli/CHANGELOG.md` is the product changelog: the CLI is the package
 * whose version is the product version, and changesets writes one `## X.Y.Z`
 * section per release into it. The release PR body and the GitHub Release body
 * are both that section, so the notes a reader sees are the notes the release
 * commit generated — never a second, hand-maintained copy that can drift.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PRODUCT_CHANGELOG = "packages/cli/CHANGELOG.md";

const HEADING = /^##\s+(.+?)\s*$/u;

/**
 * The body of the `## <version>` section, without its heading and with the
 * "Updated dependencies" bookkeeping that changesets appends for the lockstep
 * graph removed — every `@omnesis/*` package moves together, so listing all
 * eleven of them under every release says nothing.
 *
 * Returns `null` when the version has no section yet.
 */
export function extractChangelogSection(text, version) {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.match(HEADING)?.[1] === version);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => HEADING.test(line));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n");
  return stripLockstepBookkeeping(body).trim() || null;
}

/**
 * Drop the `### Patch Changes` block when it contains nothing but the
 * lockstep graph's own dependency bumps. A patch section that also carries a
 * real entry is kept whole.
 */
function stripLockstepBookkeeping(body) {
  const sections = body.split(/^(?=###\s)/mu);
  return sections
    .filter((section) => {
      if (!/^###\s+Patch Changes/u.test(section)) return true;
      const entries = section
        .split(/\r?\n/u)
        .slice(1)
        .filter((line) => line.trim().length > 0);
      return entries.some(
        (line) => !/^\s*-\s*(Updated dependencies|@omnesis\/[\w-]+@\d)/u.test(line),
      );
    })
    .join("");
}

export function readChangelogSection(root, version) {
  return extractChangelogSection(readFileSync(join(root, PRODUCT_CHANGELOG), "utf8"), version);
}
