// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { parsePackReport } from "./publish-graph.mjs";
import { resolveNpmInvocation } from "../../packages/core/src/node-command.ts";

import {
  assertExportsAreStaged,
  listPublishablePackages,
  runtimeAssetsFor,
  stagePackage,
} from "./stage-packages.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("release package selection", () => {
  test("publishes exactly the product packages and excludes synthetic providers", () => {
    const packages = listPublishablePackages();
    expect(packages).toHaveLength(47);
    expect(packages.map(({ dir }) => dir)).not.toContainEqual(
      expect.stringMatching(/^packages\/providers-synth\//u),
    );
    expect(packages.map(({ pkg }) => pkg.name)).toContain("omnesis");
    expect(packages.map(({ pkg }) => pkg.name)).toContain("@omnesis/provider-local-files");
    expect(packages.map(({ pkg }) => pkg.name)).toContain("@omnesis/cloud-relay");
    expect(packages.map(({ pkg }) => pkg.name)).toContain("@omnesis/platform");
  });
});

describe("release package runtime assets", () => {
  test("ships platform primitives without workspace runtime dependencies", async () => {
    const temp = mkdtempSync(join(tmpdir(), "omnesis-platform-stage-test-"));
    try {
      const entry = listPublishablePackages().find(({ pkg }) => pkg.name === "@omnesis/platform");
      expect(entry).toBeDefined();
      const staged = stagePackage(entry, join(temp, "staged"));
      const manifest = JSON.parse(readFileSync(join(staged, "package.json"), "utf8"));
      expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
      expect(manifest.exports["."]).toEqual({
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      });
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        const platform = await import(${JSON.stringify(pathToFileURL(join(staged, "dist/index.js")).href)});
        for (const name of ['spawnWindowsJob', 'runWindowsJob', 'writeWindowsPrivateFileAtomicSync']) {
          if (typeof platform[name] !== 'function') throw new Error('Missing platform export: ' + name);
        }
      `,
        ],
        { cwd: temp, stdio: ["ignore", "pipe", "pipe"] },
      );
      const npm = await resolveNpmInvocation(["pack", "--dry-run", "--json", "--ignore-scripts"]);
      const pack = parsePackReport(
        execFileSync(npm.command, npm.args, { cwd: staged, encoding: "utf8" }),
      );
      expect(pack.files.map(({ path }) => path)).toContain("dist/windows-private-file.js");
      expect(pack.files.map(({ path }) => path)).toContain("dist/windows-job.js");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("dotenv bootstrap subpath loads without the config writer or platform package", () => {
    const temp = mkdtempSync(join(tmpdir(), "omnesis-dotenv-stage-test-"));
    try {
      const entry = listPublishablePackages().find(({ pkg }) => pkg.name === "@omnesis/config");
      const staged = stagePackage(entry, join(temp, "staged"));
      const manifest = JSON.parse(readFileSync(join(staged, "package.json"), "utf8"));
      expect(manifest.exports["./dotenv"]).toEqual({
        types: "./dist/dotenv-reader.d.ts",
        default: "./dist/dotenv-reader.js",
      });
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        const before = JSON.stringify(process.env);
        const reader = await import(${JSON.stringify(pathToFileURL(join(staged, "dist/dotenv-reader.js")).href)});
        if (JSON.stringify(process.env) !== before) throw new Error('Import modified environment');
        if (reader.parseDotEnv('EXAMPLE=fictional-value').EXAMPLE !== 'fictional-value') throw new Error('Parser missing');
      `,
        ],
        { cwd: temp, stdio: ["ignore", "pipe", "pipe"] },
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
  test("ships the native tunnel and relay runtime exports required by the gateway", async () => {
    const temp = mkdtempSync(join(tmpdir(), "omnesis-cloud-relay-stage-test-"));
    try {
      const entry = listPublishablePackages().find(
        ({ pkg }) => pkg.name === "@omnesis/cloud-relay",
      );
      expect(entry).toBeDefined();
      const staged = stagePackage(entry, join(temp, "staged"));
      const manifest = JSON.parse(readFileSync(join(staged, "package.json"), "utf8"));
      expect(manifest.exports["."]).toEqual({
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      });
      expect(manifest.exports["./runtime"]).toEqual({
        types: "./dist/runtime.d.ts",
        default: "./dist/runtime.js",
      });
      expect(existsSync(join(staged, "dist", "tunnel-client.js"))).toBe(true);
      expect(existsSync(join(staged, "dist", "runtime.js"))).toBe(true);
      const browserModule = join(staged, "dist", "account-browser.js");
      expect(readFileSync(browserModule)).toEqual(
        readFileSync(join(repoRoot, entry.dir, "src", "account-browser.js")),
      );
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const browser = await import(${JSON.stringify(pathToFileURL(browserModule).href)}); if (typeof browser.installAccountUI !== "function") process.exit(1);`,
        ],
        { cwd: temp, stdio: ["ignore", "pipe", "pipe"] },
      );
      expect(existsSync(join(staged, "test"))).toBe(false);
      expect(existsSync(join(staged, "dist", "server.test.js"))).toBe(false);
      const npm = await resolveNpmInvocation(["pack", "--dry-run", "--json", "--ignore-scripts"]);
      const pack = parsePackReport(
        execFileSync(npm.command, npm.args, {
          cwd: staged,
          encoding: "utf8",
        }),
      );
      expect(pack.files.map(({ path }) => path)).toContain("dist/account-browser.js");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("stages the gateway's offline Models.dev snapshot beside its compiled catalog service", async () => {
    expect(runtimeAssetsFor("@omnesis/gateway")).toContainEqual({
      from: "models-dev",
      to: "models-dev",
    });
    const temp = mkdtempSync(join(tmpdir(), "omnesis-models-dev-stage-test-"));
    try {
      const entry = listPublishablePackages().find(({ pkg }) => pkg.name === "@omnesis/gateway");
      expect(entry).toBeDefined();
      const staged = stagePackage(entry, join(temp, "staged"));
      expect(existsSync(join(staged, "models-dev", "api.json"))).toBe(true);
      expect(existsSync(join(staged, "models-dev", "LICENSE"))).toBe(true);
      expect(existsSync(join(staged, "native-runtime-preflight.mjs"))).toBe(true);
      const manifest = JSON.parse(readFileSync(join(staged, "package.json"), "utf8"));
      expect(manifest.dependencies["@omnesis/cloud-relay"]).toBe(entry.pkg.version);
      expect(manifest.scripts).toEqual({
        preinstall: "node native-runtime-preflight.mjs",
        postinstall:
          "node native-vector-compat.mjs --package-dir . && " +
          "node duckdb-extensions.mjs --package-dir . --best-effort",
      });
      // The DuckDB extension pins ship; the per-platform binaries a checkout
      // fetched do not — an install fetches its own platform's build.
      expect(readdirSync(join(staged, "duckdb-extensions"))).toEqual(["manifest.json"]);
      expect(readFileSync(join(staged, "duckdb-extensions.mjs"), "utf8")).toBe(
        readFileSync(join(repoRoot, "scripts/duckdb-extensions.mjs"), "utf8"),
      );
      // npm's file filter decides whether the root install scripts ship; the
      // thousands of compiled files only make the pack slow, so leave them out.
      rmSync(join(staged, "dist"), { recursive: true, force: true });
      const npm = await resolveNpmInvocation(["pack", "--dry-run", "--json"]);
      const pack = parsePackReport(
        execFileSync(npm.command, npm.args, { cwd: staged, encoding: "utf8" }),
      );
      expect(pack.files.map(({ path }) => path)).toContain("native-runtime-preflight.mjs");
      expect(pack.files.map(({ path }) => path)).toContain("native-vector-compat.mjs");
      expect(pack.files.map(({ path }) => path)).toContain("duckdb-extensions.mjs");
      expect(pack.files.map(({ path }) => path)).toContain("duckdb-extensions/manifest.json");
      expect(readFileSync(join(staged, "native-vector-compat.mjs"), "utf8")).toBe(
        readFileSync(join(repoRoot, "scripts/native-vector-compat.mjs"), "utf8"),
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("rejects compiled modules whose source file was deleted", () => {
    const temp = mkdtempSync(join(repoRoot, ".orphaned-dist-test-"));
    try {
      const isolatedDist = join(temp, "compiled");
      mkdirSync(isolatedDist);
      writeFileSync(join(isolatedDist, "retired-feature.js"), "export {};\n");
      const entry = listPublishablePackages().find(({ pkg }) => pkg.name === "@omnesis/core");
      expect(entry).toBeDefined();
      expect(() => stagePackage(entry, join(temp, "staged"), { distDir: isolatedDist })).toThrow(
        /orphaned compiled output.*retired-feature\.js/,
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("ships the files every declared subpath points at", () => {
    // A manifest subpath and the file filter are decided independently, so a
    // package can declare an entry point whose files were excluded. `npm
    // publish` still succeeds; the failure appears only when someone installs
    // it and imports the subpath. `@omnesis/source-sdk` exports `./testing`,
    // which lives in a directory the filter used to drop wholesale.
    const temp = mkdtempSync(join(repoRoot, ".exports-stage-test-"));
    try {
      const entry = listPublishablePackages().find(({ pkg }) => pkg.name === "@omnesis/source-sdk");
      expect(entry).toBeDefined();
      expect(entry.pkg.exports["./testing"]).toBeDefined();
      const staged = stagePackage(entry, join(temp, "staged"));
      expect(existsSync(join(staged, "dist", "testing", "index.js"))).toBe(true);
      // …and the vitest-importing files beside it stay out.
      expect(existsSync(join(staged, "dist", "testing", "sync-cycle.test.js"))).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("refuses to stage a package whose manifest points at a missing file", () => {
    // The guard itself, against a manifest that names something not staged.
    const temp = mkdtempSync(join(repoRoot, ".missing-export-test-"));
    try {
      mkdirSync(join(temp, "staged"), { recursive: true });
      expect(() =>
        assertExportsAreStaged(
          "@omnesis/example",
          { exports: { ".": "./dist/index.js", "./extra": "./dist/extra/index.js" } },
          join(temp, "staged"),
        ),
      ).toThrow(/missing from the staged package.*dist\/extra\/index\.js/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("validates export replacement patterns without weakening concrete assets or main/bin paths", () => {
    const temp = mkdtempSync(join(tmpdir(), "omnesis-export-pattern-test-"));
    try {
      mkdirSync(join(temp, "dist/nested"), { recursive: true });
      mkdirSync(join(temp, "empty"));
      writeFileSync(join(temp, "dist/nested/index.js"), "export {};\n");
      const exports = { "./*": "./*", "./modules/*": "./dist/*.js" };
      expect(() => assertExportsAreStaged("example", { exports }, temp)).not.toThrow();
      expect(() =>
        assertExportsAreStaged(
          "example",
          {
            exports: {
              ...exports,
              "./agent-ui": {
                types: "./portal/agent-ui/index.d.ts",
                default: "./dist/nested/index.js",
              },
            },
          },
          temp,
        ),
      ).toThrow(/portal\/agent-ui\/index\.d\.ts/);
      for (const target of [
        "./missing/*",
        "./empty/*",
        "./dist/*.css",
        "./dist/../*",
        "./dist/nested/[a-z]*.js",
      ])
        expect(() =>
          assertExportsAreStaged("example", { exports: { "./*": target } }, temp),
        ).toThrow(/missing from the staged package/);
      expect(() => assertExportsAreStaged("example", { exports, main: "./*" }, temp)).toThrow(
        /missing from the staged package/,
      );
      expect(() =>
        assertExportsAreStaged("example", { exports, bin: { example: "./*" } }, temp),
      ).toThrow(/missing from the staged package/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("requires repeated stars to use the same subpath substitution", () => {
    const temp = mkdtempSync(join(tmpdir(), "omnesis-export-repeat-test-"));
    try {
      mkdirSync(join(temp, "dist/first"), { recursive: true });
      writeFileSync(join(temp, "dist/first/other.js"), "export {};\n");
      const manifest = { exports: { "./*": "./dist/*/*.js" } };
      expect(() => assertExportsAreStaged("example", manifest, temp)).toThrow(
        /missing from the staged package/,
      );
      writeFileSync(join(temp, "dist/first/first.js"), "export {};\n");
      expect(() => assertExportsAreStaged("example", manifest, temp)).not.toThrow();
      writeFileSync(join(temp, "dist/first/first2.js"), "export {};\n");
      expect(() =>
        assertExportsAreStaged("example", { exports: { "./*": "./dist/*/*2.js" } }, temp),
      ).not.toThrow();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("ships both agent harness entry points with the shared integration package", () => {
    const assets = runtimeAssetsFor("@omnesis/agent-integration");
    expect(assets).toEqual([
      { from: "../platform/dist", to: "dist/private-platform" },
      { from: "openclaw-entry.mjs", to: "openclaw-entry.mjs" },
      { from: "openclaw.plugin.json", to: "openclaw.plugin.json" },
      { from: "hermes/__init__.py", to: "hermes/__init__.py" },
      { from: "hermes/adapter.py", to: "hermes/adapter.py" },
      { from: "hermes/plugin.yaml", to: "hermes/plugin.yaml" },
      { from: "hermes/windows-files.mjs", to: "hermes/windows-files.mjs" },
    ]);
    for (const asset of assets) {
      expect(
        existsSync(join(repoRoot, "packages", "agent-integration", asset.from)),
        asset.from,
      ).toBe(true);
    }
    expect(assets.some((asset) => /__pycache__|\.py[co]$/.test(asset.from))).toBe(false);
  });

  test("stages directory runtime assets recursively", () => {
    const temp = mkdtempSync(join(tmpdir(), "omnesis-gateway-stage-"));
    try {
      const entry = listPublishablePackages().find(({ pkg }) => pkg.name === "@omnesis/gateway");
      expect(entry).toBeDefined();
      const staged = stagePackage(entry, join(temp, "staged"));
      expect(existsSync(join(staged, "portal", "index.html"))).toBe(true);
      expect(existsSync(join(staged, "portal", "js", "app.js"))).toBe(true);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("loads the isolated staged OpenClaw entry through the installed SDK", async () => {
    const temp = mkdtempSync(join(repoRoot, ".agent-integration-stage-test-"));
    try {
      const isolatedDist = join(temp, "compiled");
      execFileSync(
        process.execPath,
        [
          join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
          "--project",
          join(repoRoot, "packages", "agent-integration", "tsconfig.json"),
          "--outDir",
          isolatedDist,
          "--tsBuildInfoFile",
          join(temp, "agent-integration.tsbuildinfo"),
          "--composite",
          "false",
          "--declaration",
          "--declarationMap",
          "false",
          "--sourceMap",
          "false",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const entry = listPublishablePackages().find(
        ({ pkg }) => pkg.name === "@omnesis/agent-integration",
      );
      expect(entry).toBeDefined();
      const staged = stagePackage(entry, join(temp, "staged"), {
        distDir: isolatedDist,
      });
      const manifest = JSON.parse(readFileSync(join(staged, "package.json"), "utf8"));
      expect(Object.keys(manifest.dependencies).sort()).toEqual([
        "@modelcontextprotocol/client",
        "ws",
        "zod",
      ]);
      expect(manifest.dependencies).toEqual(entry.pkg.dependencies);
      expect(manifest.engines).toEqual({ node: ">=24.0.0" });
      expect(manifest.dependencies).not.toHaveProperty("@omnesis/core");
      expect(manifest.dependencies).not.toHaveProperty("@omnesis/platform");
      expect(existsSync(join(staged, "dist", "private-platform", "windows-private-file.js"))).toBe(
        true,
      );
      expect(
        existsSync(join(staged, "dist", "private-platform", "native", "windows-worker-source.js")),
      ).toBe(true);
      // This process has no workspace ancestor or Omnesis node_modules aliases.
      // A Linux import proves closure; Windows also exercises the bundled native
      // credential read/write boundary against a real protected file.
      const standalone = mkdtempSync(join(tmpdir(), "omnesis-standalone-runtime-"));
      try {
        cpSync(join(staged, "dist", "windows-files.js"), join(standalone, "windows-files.js"));
        cpSync(join(staged, "dist", "private-platform"), join(standalone, "private-platform"), {
          recursive: true,
        });
        writeFileSync(join(standalone, "package.json"), '{"type":"module"}');
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { privateWindowsFiles } from './windows-files.js';
const files = privateWindowsFiles();
if (typeof files.readWindowsPrivateFileContentsSync !== 'function' ||
    typeof files.writeWindowsPrivateFileAtomicSync !== 'function') throw new Error('Missing standalone helpers');
if (process.platform === 'win32') {
  const path = new URL('./invented-credentials.json', import.meta.url);
  const { fileURLToPath } = await import('node:url');
  const target = fileURLToPath(path);
  files.writeWindowsPrivateFileAtomicSync(target, Buffer.from('invented-private-bytes'));
  if (files.readWindowsPrivateFileContentsSync(target).toString() !== 'invented-private-bytes')
    throw new Error('Standalone native private file round trip failed');
}`,
          ],
          { cwd: standalone, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
        );
      } finally {
        rmSync(standalone, { recursive: true, force: true });
      }
      const loaded = await import(`${join(staged, "openclaw-entry.mjs")}?smoke=${Date.now()}`);
      expect(loaded.default).toMatchObject({
        id: "omnesis-integration",
        register: expect.any(Function),
      });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
