// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The installer is served to users as https://omnesis.dev/install.sh — the
 * landing site deploys whatever is in website/, so website/install.sh is the
 * published mirror of the canonical scripts/install.sh. They must stay
 * byte-identical; after editing the canonical script, refresh the mirror:
 *
 *   cat scripts/install.sh > website/install.sh
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("website/install.sh mirrors scripts/install.sh exactly", () => {
  const canonical = readFileSync(join(repoRoot, "scripts", "install.sh"), "utf8");
  const mirror = readFileSync(join(repoRoot, "website", "install.sh"), "utf8");
  expect(mirror).toBe(canonical);
});

test("website/install-prompt.md mirrors scripts/install-prompt.md exactly", () => {
  const canonical = readFileSync(join(repoRoot, "scripts", "install-prompt.md"), "utf8");
  const mirror = readFileSync(join(repoRoot, "website", "install-prompt.md"), "utf8");
  expect(mirror).toBe(canonical);
});
