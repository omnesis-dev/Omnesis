// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ts = createRequire(import.meta.url)("typescript");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Compile the actual private-key helper, never a hand-written test substitute. */
export async function privateKeyTestFixture() {
  const files = { "package.json": '{"type":"module"}\n' };
  for (const name of ["openssl-private-input", "node-command"]) {
    const source = await readFile(resolve(root, `packages/core/src/${name}.ts`), "utf8");
    const result = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
      reportDiagnostics: true,
      fileName: `${name}.ts`,
    });
    if (result.diagnostics?.some((item) => item.category === ts.DiagnosticCategory.Error))
      throw new Error("Private-key native test input could not be compiled");
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
