// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  codexBackendTestFiles,
  prepareCodexBackendTestFixture,
} from "./codex-backend-test-fixture.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omnesis-backend-producer-"));
  roots.push(root);
  return join(root, "output");
}
test("the compiled production backend shares the preload's single launcher module", async () => {
  const { files, hashes } = await codexBackendTestFiles();
  expect(Object.keys(files).sort()).toEqual([
    "package.json",
    "packages/core/dist/managed-runtime-bootstrap.js",
    "packages/core/dist/node-command.js",
    "program.mjs",
  ]);
  expect(files["program.mjs"]).toContain('from "./packages/core/dist/node-command.js"');
  expect(files["program.mjs"]).not.toMatch(/let managed[; =]/u);
  expect(files["program.mjs"]).toContain("prepareManagedCodexModelCatalog");
  expect(files["program.mjs"]).toContain("experimentalFeature/list");
  for (const [name, bytes] of Object.entries(files))
    expect(hashes[name]).toBe(createHash("sha256").update(bytes).digest("hex"));
});
test("owned compiled inputs are rehashed and repaired instead of trusting stale receipts", async () => {
  const output = await fixture();
  await prepareCodexBackendTestFixture({ output });
  await writeFile(join(output, "program.mjs"), "invented modified input");
  await prepareCodexBackendTestFixture({ output });
  const metadata = JSON.parse(await readFile(join(output, "backend-fixture.json"), "utf8"));
  expect(metadata.owner).toBe("omnesis-desktop-codex-backend-test-fixture");
  expect(metadata.qualifiedRuntimeVersion).toBe("0.171.0");
  expect(
    createHash("sha256")
      .update(await readFile(join(output, "program.mjs")))
      .digest("hex"),
  ).toBe(metadata.hashes["program.mjs"]);
});
test("an unowned existing output cannot be adopted or removed", async () => {
  const output = await fixture();
  await mkdir(output);
  await writeFile(join(output, "keep"), "invented independent data");
  await expect(prepareCodexBackendTestFixture({ output })).rejects.toThrow(/ownership/u);
  expect(await readFile(join(output, "keep"), "utf8")).toBe("invented independent data");
});
