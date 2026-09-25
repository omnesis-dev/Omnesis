// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

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
    expect(packages).toHaveLength(40);
    expect(packages.map(({ dir }) => dir)).not.toContainEqual(
      expect.stringMatching(/^packages\/providers-synth\//u),
    );
    expect(packages.map(({ pkg }) => pkg.name)).toContain("omnesis");
    expect(packages.map(({ pkg }) => pkg.name)).toContain("@omnesis/provider-local-files");
  });
});

describe("release package runtime assets", () => {
  test("stages the gateway's offline Models.dev snapshot beside its compiled catalog service", () => {
    expect(runtimeAssetsFor("@omnesis/gateway")).toContainEqual({
      from: "models-dev",
      to: "models-dev",
    });
    const temp = mkdtempSync(join(repoRoot, ".models-dev-stage-test-"));
    try {
      const entry = listPublishablePackages().find(({ pkg }) => pkg.name === "@omnesis/gateway");
      expect(entry).toBeDefined();
      const staged = stagePackage(entry, join(temp, "staged"));
      expect(existsSync(join(staged, "models-dev", "api.json"))).toBe(true);
      expect(existsSync(join(staged, "models-dev", "LICENSE"))).toBe(true);
      expect(existsSync(join(staged, "native-runtime-preflight.mjs"))).toBe(true);
      const manifest = JSON.parse(readFileSync(join(staged, "package.json"), "utf8"));
      expect(manifest.scripts).toEqual({ preinstall: "node native-runtime-preflight.mjs" });
      const pack = JSON.parse(
        execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: staged, encoding: "utf8" }),
      );
      expect(pack[0].files.map(({ path }) => path)).toContain("native-runtime-preflight.mjs");
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

  test("ships both agent harness entry points with the shared integration package", () => {
    const assets = runtimeAssetsFor("@omnesis/agent-integration");
    expect(assets).toEqual([
      { from: "openclaw-entry.mjs", to: "openclaw-entry.mjs" },
      { from: "openclaw.plugin.json", to: "openclaw.plugin.json" },
      { from: "hermes/__init__.py", to: "hermes/__init__.py" },
      { from: "hermes/adapter.py", to: "hermes/adapter.py" },
      { from: "hermes/plugin.yaml", to: "hermes/plugin.yaml" },
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
      expect(manifest.dependencies).toEqual({
        "@modelcontextprotocol/client": "2.0.0",
        ws: "^8.21.3",
        zod: "^4.5.4",
      });
      expect(manifest.engines).toEqual({ node: ">=24.0.0" });
      expect(manifest.dependencies).not.toHaveProperty("@omnesis/core");
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
