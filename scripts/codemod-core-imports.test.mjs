// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Fixture test for the import-sweep codemod. Run with:
 *   node --test scripts/codemod-core-imports.test.mjs
 *
 * Uses node:test (the tool is a scripts/ node script, not package code that
 * vitest scans). Exercises the pure `rewriteSource` transform against a hand
 * provenance map — partitioning, statement splitting, `type` modifiers, and
 * `as` aliases.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteSource } from "./codemod-core-imports.mjs";

// SourceId/DocumentInput → types; OmnesisConfig → config; defineSource → source-sdk.
// createLogger stays on core.
const MAP = new Map([
  ["SourceId", "@omnesis/types"],
  ["DocumentInput", "@omnesis/types"],
  ["OmnesisConfig", "@omnesis/config"],
  ["defineSource", "@omnesis/source-sdk"],
]);

test("splits a mixed import, keeping core symbols and routing moved ones", () => {
  const input = `import { createLogger, defineSource, SourceId } from "@omnesis/core";\n`;
  const { text, changed, splits } = rewriteSource(input, MAP);
  assert.equal(changed, true);
  assert.equal(splits, 1);
  assert.match(text, /import \{ createLogger \} from "@omnesis\/core";/);
  assert.match(text, /import \{ defineSource \} from "@omnesis\/source-sdk";/);
  assert.match(text, /import \{ SourceId \} from "@omnesis\/types";/);
});

test("leaves a core-only import untouched", () => {
  const input = `import { createLogger } from "@omnesis/core";\n`;
  const { changed } = rewriteSource(input, MAP);
  assert.equal(changed, false);
});

test("preserves per-specifier type modifiers", () => {
  const input = `import { createLogger, type DocumentInput } from "@omnesis/core";\n`;
  const { text } = rewriteSource(input, MAP);
  assert.match(text, /import \{ createLogger \} from "@omnesis\/core";/);
  assert.match(text, /import \{ type DocumentInput \} from "@omnesis\/types";/);
});

test("preserves a whole-import `type` modifier", () => {
  const input = `import type { OmnesisConfig, SourceId } from "@omnesis/core";\n`;
  const { text } = rewriteSource(input, MAP);
  assert.match(text, /import type \{ OmnesisConfig \} from "@omnesis\/config";/);
  assert.match(text, /import type \{ SourceId \} from "@omnesis\/types";/);
});

test("preserves `as` aliases and routes by the imported (not local) name", () => {
  const input = `import { SourceId as SID, createLogger } from "@omnesis/core";\n`;
  const { text } = rewriteSource(input, MAP);
  assert.match(text, /import \{ createLogger \} from "@omnesis\/core";/);
  assert.match(text, /import \{ SourceId as SID \} from "@omnesis\/types";/);
});

test("rewrites `export … from` re-exports too", () => {
  const input = `export { defineSource } from "@omnesis/core";\n`;
  const { text, changed } = rewriteSource(input, MAP);
  assert.equal(changed, true);
  assert.match(text, /export \{ defineSource \} from "@omnesis\/source-sdk";/);
});

test("does not touch namespace or default imports", () => {
  const ns = `import * as core from "@omnesis/core";\n`;
  assert.equal(rewriteSource(ns, MAP).changed, false);
  const side = `import "@omnesis/core";\n`;
  assert.equal(rewriteSource(side, MAP).changed, false);
});
