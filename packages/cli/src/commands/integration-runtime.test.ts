// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { prepareHermesRuntimeAssets } from "./integration-runtime.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("POSIX Hermes remains Python-only without a compiler or JavaScript runtime graph", () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-python-assets-"));
  roots.push(root);
  mkdirSync(join(root, "hermes"));
  for (const file of ["adapter.py", "__init__.py", "plugin.yaml"])
    writeFileSync(join(root, "hermes", file), `invented ${file}`);
  for (const platform of ["linux", "darwin"] as const) {
    const runtime = prepareHermesRuntimeAssets(
      { packageRoot: root, entry: join(root, "src/index.ts") },
      platform,
    );
    expect(runtime.files.map((f) => f.file)).toEqual(["__init__.py", "adapter.py", "plugin.yaml"]);
    runtime.cleanup();
  }
});

test("Windows source Hermes materializes fresh canonical helpers with no workspace runtime dependency", () => {
  const root = mkdtempSync(join(process.cwd(), ".hermes-artifact-fixture-"));
  roots.push(root);
  const source = join(process.cwd(), "packages/agent-integration");
  for (const name of [
    "src",
    "hermes",
    "package.json",
    "openclaw-entry.mjs",
    "openclaw.plugin.json",
  ])
    cpSync(join(source, name), join(root, name), { recursive: true });
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      extends: join(process.cwd(), "tsconfig.base.json"),
      compilerOptions: { rootDir: "src" },
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    }),
  );
  mkdirSync(join(root, "dist"));
  writeFileSync(
    join(root, "dist/windows-files.js"),
    "throw new Error('stale runtime must not ship')",
  );
  const runtime = prepareHermesRuntimeAssets(
    { packageRoot: root, entry: join(root, "src/index.ts") },
    "win32",
  );
  const deployed = mkdtempSync(join(tmpdir(), "hermes-standalone-assets-"));
  roots.push(deployed);
  try {
    expect(runtime.files.some((f) => f.file.endsWith("test_adapter.py"))).toBe(false);
    expect(
      runtime.files.some(
        (f) => f.file === join("runtime/private-platform/native/windows-worker-source.js"),
      ),
    ).toBe(true);
    for (const { file, content } of runtime.files) {
      const path = join(deployed, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import {privateWindowsFiles} from './runtime/windows-files.js'; if(typeof privateWindowsFiles().readWindowsPrivateFileContentsSync !== 'function')throw Error('incomplete graph');console.log('standalone ready')",
      ],
      { cwd: deployed, encoding: "utf8", timeout: 20000 },
    );
    expect(output.trim()).toBe("standalone ready");
    expect(existsSync(join(deployed, "node_modules"))).toBe(false);
  } finally {
    runtime.cleanup();
  }
}, 30000);
