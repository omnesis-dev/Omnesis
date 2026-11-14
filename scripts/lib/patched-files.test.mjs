// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { patchedFiles } from "./patched-files.mjs";

const roots = [];
const target = "node_modules/invented-dependency/index.js";
const patch = "invented-dependency+1.0.0.patch";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(hunks, content) {
  const root = mkdtempSync(join(tmpdir(), "omnesis-patch-verifier-"));
  roots.push(root);
  mkdirSync(join(root, "patches"));
  mkdirSync(join(root, "node_modules", "invented-dependency"), { recursive: true });
  writeFileSync(
    join(root, "patches", patch),
    [`diff --git a/${target} b/${target}`, `--- a/${target}`, `+++ b/${target}`, ...hunks, ""].join(
      "\n",
    ),
  );
  writeFileSync(join(root, target), content);
  return root;
}

const addition = ["@@ -1,2 +1,3 @@", "+// Added dependency guard.", " /**", "  * Invented module."];
const removal = [
  "@@ -1,3 +1,2 @@",
  " function close(session) {",
  '-  console.info("secret session", session);',
  " }",
];

describe("patched dependency reference validation", () => {
  it("accepts a pure addition whose unchanged context remains in the patched file", () => {
    const content = "// Added dependency guard.\n/**\n * Invented module.\n";
    const root = fixture(addition, content);
    expect(patchedFiles(root)).toEqual([
      {
        patch,
        path: target,
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ]);
  });

  it.each([
    "/**\n * Invented module.\n",
    "// Added dependency guard.\nconst unrelated = true;\n/**\n * Invented module.\n",
  ])("refuses an absent addition or an addition outside its context", (content) => {
    expect(() => patchedFiles(fixture(addition, content))).toThrow("is not patched");
  });

  it("accepts a context-free addition even when the file contains a blank line", () => {
    const root = fixture(
      ["@@ -0,0 +1,2 @@", "+const enabled = true;", "+"],
      "const enabled = true;\n\n",
    );
    expect(patchedFiles(root)).toHaveLength(1);
  });

  it("refuses the original secret-log removal hunk even alongside a patched copy", () => {
    const original = 'function close(session) {\n console.info("secret session", session);\n}\n';
    const applied = "function close(session) {\n}\n";
    expect(() => patchedFiles(fixture(removal, original))).toThrow("is not patched");
    expect(() => patchedFiles(fixture(removal, applied + original))).toThrow("is not patched");
    expect(patchedFiles(fixture(removal, applied))).toHaveLength(1);
  });

  it("still rejects the original side of a replacement when its new side is also present", () => {
    const hunks = [
      "@@ -1,3 +1,3 @@",
      " function close() {",
      '-  console.info("secret");',
      "+  scrub();",
      " }",
    ];
    const original = 'function close() {\n console.info("secret");\n}\n';
    const applied = "function close() {\n scrub();\n}\n";
    expect(() => patchedFiles(fixture(hunks, applied + original))).toThrow("is not patched");
    expect(patchedFiles(fixture(hunks, applied))).toHaveLength(1);
  });

  it("requires both an addition and a separate secret-log removal to be applied", () => {
    const hunks = [...addition, "@@ -4,3 +5,2 @@", ...removal.slice(1)];
    const header = "// Added dependency guard.\n/**\n * Invented module.\n";
    const original = 'function close(session) {\n console.info("secret session", session);\n}\n';
    const applied = "function close(session) {\n}\n";
    expect(() => patchedFiles(fixture(hunks, header + original))).toThrow("is not patched");
    expect(() => patchedFiles(fixture(hunks, applied))).toThrow("is not patched");
    expect(patchedFiles(fixture(hunks, header + applied))).toHaveLength(1);
  });
});
