// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The dependency files `patches/` rewrites, with the digest each has once
 * patched.
 *
 * patch-package applies these patches to the workspace install, and the
 * runtime images apply them again to the production tree they ship. A shipped
 * file whose digest differs from the patched workspace copy carries upstream
 * behavior the patch exists to remove. One of those patches removes libsignal's
 * console dumps of whole session records, ratchet private keys included.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** A block of lines compared by content only; indentation and trailing blanks vary. */
function normalize(lines) {
  return `\n${lines.map((line) => line.trim()).join("\n")}\n`;
}

/**
 * Every file each patch touches, as a repository-relative `node_modules/...`
 * path, with the SHA-256 of the patched copy under `root`. Throws when the
 * copy under `root` does not read as each hunk's result, or still reads as its
 * original, so a comparison never runs against an unpatched reference.
 *
 * @param {string} root the repository root holding `patches/` and `node_modules/`
 * @returns {{ patch: string, path: string, sha256: string }[]}
 */
export function patchedFiles(root) {
  const patchDir = join(root, "patches");
  const files = [];
  for (const patch of readdirSync(patchDir)
    .filter((name) => name.endsWith(".patch"))
    .sort()) {
    const sections = readFileSync(join(patchDir, patch), "utf8")
      .split(/^diff --git /mu)
      .slice(1);
    for (const section of sections) {
      const path = /^\+\+\+ b\/(\S+)$/mu.exec(section)?.[1];
      if (!path?.startsWith("node_modules/")) {
        throw new Error(`${patch}: a section names no node_modules target`);
      }
      const content = readFileSync(join(root, path));
      const text = normalize(content.toString("utf8").split("\n"));
      for (const hunk of section.split(/^@@[^\n]*\n/mu).slice(1)) {
        const lines = hunk.split("\n").filter((line) => /^[ +-]/u.test(line));
        const side = (sign) =>
          normalize(lines.filter((l) => l[0] === " " || l[0] === sign).map((l) => l.slice(1)));
        if (!text.includes(side("+")) || text.includes(side("-"))) {
          throw new Error(`${path} is not patched by ${patch}`);
        }
      }
      files.push({ patch, path, sha256: createHash("sha256").update(content).digest("hex") });
    }
  }
  if (files.length === 0) throw new Error(`${patchDir} holds no patches`);
  return files;
}
