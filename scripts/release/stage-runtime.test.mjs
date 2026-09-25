// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION } from "../../packages/gateway/src/data/schema-version.ts";
import {
  compileRuntimeClosure,
  localRuntimeClosure,
  stageRuntime,
} from "../runtime/stage-runtime.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function allFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? join(prefix, entry.name) : entry.name;
    return entry.isDirectory() ? allFiles(join(directory, entry.name), relative) : [relative];
  });
}

describe("runtime staging", () => {
  it("computes only the transitive local gateway closure", () => {
    const names = localRuntimeClosure("@omnesis/gateway").map((entry) => entry.pkg.name);

    expect(names).toContain("@omnesis/gateway");
    expect(names).toContain("@omnesis/core");
    expect(names).toContain("@omnesis/provider-web");
    expect(names).not.toContain("@omnesis/collector");
    expect(names).not.toContain("@omnesis/provider-google");
  });

  it("unions the closures of every requested root", () => {
    const names = localRuntimeClosure(["@omnesis/gateway", "omnesis"]).map(
      (entry) => entry.pkg.name,
    );
    const directories = localRuntimeClosure(["@omnesis/gateway", "omnesis"]).map(
      (entry) => entry.dir,
    );

    expect(names).toContain("@omnesis/gateway");
    expect(names).toContain("omnesis");
    expect(names).toContain("@omnesis/collector");
    expect(names).toContain("@omnesis/provider-google");
    expect(new Set(names).size).toBe(names.length);
    expect(directories).toEqual([...directories].sort((a, b) => a.localeCompare(b)));
    expect(names).toEqual(
      expect.arrayContaining(
        localRuntimeClosure("@omnesis/gateway").map((entry) => entry.pkg.name),
      ),
    );
  });

  it("rejects an empty root list", () => {
    expect(() => localRuntimeClosure([])).toThrow(/at least one runtime root/u);
  });

  it("compiles every package in the staged closure", () => {
    const entries = localRuntimeClosure("@omnesis/gateway");
    const calls = [];

    compileRuntimeClosure(entries, (...args) => calls.push(args));

    expect(calls).toHaveLength(1);
    const [executable, args, options] = calls[0];
    expect(executable).toBe(process.execPath);
    expect(args.slice(0, 2)).toEqual([
      expect.stringMatching(/node_modules\/typescript\/bin\/tsc$/u),
      "--build",
    ]);
    expect(args.slice(2)).toEqual(entries.map((entry) => join(process.cwd(), entry.dir)));
    expect(args).toEqual(expect.arrayContaining([expect.stringMatching(/packages\/near-dupes$/u)]));
    expect(options).toMatchObject({ stdio: "inherit" });
  });

  it("keeps prebuilt outputs out of the Docker build context", () => {
    const patterns = readFileSync(join(process.cwd(), ".dockerignore"), "utf8").split("\n");

    expect(patterns).toContain("**/dist");
    expect(patterns).toContain("**/*.tsbuildinfo");
  });

  it("contains compiled runtime files and no source or tests", () => {
    const root = mkdtempSync(join(tmpdir(), "omnesis-gateway-runtime-"));
    temporaryDirectories.push(root);
    const directory = join(root, "staged");
    const manifest = stageRuntime(directory);
    const files = allFiles(directory);

    expect(manifest.packages.some((entry) => entry.name === "@omnesis/gateway")).toBe(true);
    expect(existsSync(join(directory, "packages/gateway/dist/index.js"))).toBe(true);
    expect(statSync(join(directory, "packages/gateway/dist/index.js")).mode & 0o777).toBe(0o644);
    const schemaVersionModule = join(directory, "packages/gateway/dist/data/schema-version.js");
    expect(existsSync(schemaVersionModule)).toBe(true);
    const isolatedDirectory = mkdtempSync(join(tmpdir(), "omnesis-schema-version-"));
    temporaryDirectories.push(isolatedDirectory);
    const isolatedSchemaVersionModule = join(isolatedDirectory, "schema-version.mjs");
    copyFileSync(schemaVersionModule, isolatedSchemaVersionModule);
    expect(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import(${JSON.stringify(pathToFileURL(isolatedSchemaVersionModule).href)}).then((module) => process.stdout.write(String(module.LATEST_SCHEMA_VERSION)))`,
        ],
        { encoding: "utf8" },
      ),
    ).toBe(String(LATEST_SCHEMA_VERSION));
    expect(existsSync(join(directory, "packages/gateway/portal/index.html"))).toBe(true);
    expect(files.some((file) => file.includes("/src/"))).toBe(false);
    expect(files.some((file) => /\.(?:test|e2e)\./u.test(file))).toBe(false);

    for (const entry of manifest.packages) {
      const packageJson = JSON.parse(
        readFileSync(join(directory, entry.path, "package.json"), "utf8"),
      );
      expect(JSON.stringify(packageJson)).not.toContain("src/");
    }
  });

  it("refuses to replace any existing output", () => {
    const directory = mkdtempSync(join(tmpdir(), "omnesis-gateway-runtime-existing-"));
    temporaryDirectories.push(directory);

    expect(() => stageRuntime(directory)).toThrow(/must not already exist/u);
    expect(existsSync(directory)).toBe(true);
  });
});
