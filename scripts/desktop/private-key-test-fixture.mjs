// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ts = createRequire(import.meta.url)("typescript");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Compile the actual private-key and lifetime-lock helpers for native composition tests. */
export async function privateKeyTestFixture() {
  const files = { "package.json": '{"type":"module"}\n' };
  for (const name of [
    "openssl-private-input",
    "node-command",
    "gateway-lock",
    "windows-powershell",
    "managed-runtime-bootstrap",
  ]) {
    let source = await readFile(
      resolve(
        root,
        `packages/${name === "windows-powershell" ? "platform" : "core"}/src/${name}.ts`,
      ),
      "utf8",
    );
    if (name === "gateway-lock")
      source = source.replace('from "./windows-process-tree.js"', 'from "./windows-powershell.js"');
    const result = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
      reportDiagnostics: true,
      fileName: `${name}.ts`,
    });
    if (result.diagnostics?.some((item) => item.category === ts.DiagnosticCategory.Error))
      throw new Error("Private-key native test input could not be compiled");
    files[`${name}.js`] = result.outputText;
  }
  for (const name of [
    "environment",
    "generation",
    "fresh-install-errors",
    "data-operation-frame",
    "snapshot-retention-errors",
    "snapshot-retention-host",
    "snapshot-retention-delete",
    "snapshot-retention-record",
    "snapshot-retention-witness",
    "snapshot-owner",
  ]) {
    const source = await readFile(resolve(root, `packages/cli/src/desktop/${name}.ts`), "utf8");
    const result = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
      reportDiagnostics: true,
      fileName: `${name}.ts`,
    });
    if (result.diagnostics?.some((item) => item.category === ts.DiagnosticCategory.Error))
      throw new Error("Snapshot native test input could not be compiled");
    files[`${name}.js`] = result.outputText;
  }
  files["test.mjs"] = await readFile(
    resolve(root, "scripts/desktop/private-key-test-program.mjs"),
    "utf8",
  );
  const hashes = Object.fromEntries(
    Object.entries(files).map(([name, value]) => [
      name,
      createHash("sha256").update(value).digest("hex"),
    ]),
  );
  return { files, hashes };
}
