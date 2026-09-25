#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";

const HEADER =
  "// SPDX-License-Identifier: AGPL-3.0-or-later\n// Copyright (c) 2026 Adrien Conrath";

// Languages whose line comments use `//`, so the header above applies verbatim.
const SUPPORTED = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".swift",
  ".kt",
  ".kts",
]);

// Third-party vendored code must NOT receive an Omnesis SPDX/copyright header:
// stamping our AGPL license + copyright onto someone else's MIT/BSD/ISC code is
// a false authorship claim and strips their required upstream notice. Attribution
// for these libraries lives in THIRD_PARTY_NOTICES.md instead.
const EXCLUDED_SUBSTRINGS = ["packages/gateway/portal/vendor/"];

function isExcluded(file) {
  const normalized = file.split("\\").join("/");
  return EXCLUDED_SUBSTRINGS.some((sub) => normalized.includes(sub));
}

function hasHeader(content) {
  const firstChunk = content.slice(0, 500);
  return (
    /^\/\/\s*SPDX-License-Identifier:/m.test(firstChunk) || /^\/\/\s*Copyright\b/m.test(firstChunk)
  );
}

function addHeader(content) {
  const shebangMatch = content.match(/^#![^\n]*\n/);
  if (shebangMatch) {
    const shebang = shebangMatch[0];
    const rest = content.slice(shebang.length);
    return `${shebang}${HEADER}\n${rest.startsWith("\n") ? "" : "\n"}${rest}`;
  }
  return `${HEADER}\n${content.startsWith("\n") ? "" : "\n"}${content}`;
}

const files = process.argv.slice(2);
let updated = 0;
let skipped = 0;

for (const file of files) {
  if (!SUPPORTED.has(extname(file))) {
    skipped++;
    continue;
  }
  if (isExcluded(file)) {
    skipped++;
    continue;
  }
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    skipped++;
    continue;
  }
  if (hasHeader(content)) {
    skipped++;
    continue;
  }
  writeFileSync(file, addHeader(content));
  updated++;
}

if (updated > 0) {
  console.log(`add-license-header: updated ${updated} file(s), skipped ${skipped}`);
}
