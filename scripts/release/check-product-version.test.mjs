// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { checkProductVersion } from "./check-product-version.mjs";

const jsonPlugins = [
  "plugins/omnesis-claude/.claude-plugin/plugin.json",
  "plugins/omnesis/.codex-plugin/plugin.json",
  "extension/public/manifest.json",
  "integrations/openclaw-omnesis-plugin/package.json",
];
const yamlPlugins = ["packages/agent-integration/hermes/plugin.yaml"];
const productVersionContracts = ["extension/release-contract.json"];
let fixture;

function write(path, contents) {
  const target = join(fixture, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function writeJson(path, value) {
  write(path, `${JSON.stringify(value)}\n`);
}

function makeFixture() {
  fixture = mkdtempSync(join(tmpdir(), "omnesis-product-version-"));
  writeJson("package.json", { workspaces: ["packages/*"] });
  writeJson("packages/cli/package.json", { version: "0.3.0" });
  writeJson("packages/core/package.json", { version: "0.3.0" });
  writeJson("extension/package.json", { version: "0.3.0", private: true });
  writeJson("package-lock.json", {
    packages: {
      "packages/cli": { version: "0.3.0" },
      "packages/core": { version: "0.3.0" },
      extension: { version: "0.3.0" },
    },
  });
  for (const path of jsonPlugins) writeJson(path, { version: "0.3.0" });
  for (const path of yamlPlugins) write(path, "name: fixture\nversion: 0.3.0\n");
  for (const path of productVersionContracts) writeJson(path, { productVersion: "0.3.0" });
  write("ios/project.yml", 'MARKETING_VERSION: "0.3.0"\nCURRENT_PROJECT_VERSION: "236"\n');
  for (const path of ["ios/Info.plist", "ios/Info-Demo.plist"]) {
    write(
      path,
      "<key>CFBundleShortVersionString</key><string>0.3.0</string>\n" +
        "<key>CFBundleVersion</key><string>236</string>\n",
    );
  }
  write("android/app/build.gradle.kts", 'versionCode = 1\nversionName = "0.3.0"\n');
  return fixture;
}

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  fixture = undefined;
});

test("the repository product, plugin, and native marketing versions are in lockstep", () => {
  const { version } = JSON.parse(
    readFileSync(new URL("../../packages/cli/package.json", import.meta.url), "utf8"),
  );
  expect(checkProductVersion(undefined, `v${version}`)).toBe(version);
});

test("accepts a complete isolated release fixture", () => {
  makeFixture();
  write(
    "ios/Info-Demo.plist",
    "<key>CFBundleShortVersionString</key><string>0.3.0</string>\n" +
      "<key>CFBundleVersion</key><string>999</string>\n",
  );
  expect(checkProductVersion(fixture, "v0.3.0")).toBe("0.3.0");
});

test("ignores private workspaces outside the published product version", () => {
  makeFixture();
  const root = JSON.parse(readFileSync(join(fixture, "package.json"), "utf8"));
  root.workspaces.push("packages/private-fixture");
  writeJson("package.json", root);
  writeJson("packages/private-fixture/package.json", {
    name: "@omnesis/private-fixture",
    version: "9.9.9",
    private: true,
  });

  expect(checkProductVersion(fixture, "v0.3.0")).toBe("0.3.0");
});

test("rejects drift in the private browser extension package or lock entry", () => {
  makeFixture();
  writeJson("extension/package.json", { version: "0.2.0", private: true });
  expect(() => checkProductVersion(fixture, "v0.3.0")).toThrow(/extension\/package\.json/u);
  writeJson("extension/package.json", { version: "0.3.0", private: true });
  const lock = JSON.parse(readFileSync(join(fixture, "package-lock.json"), "utf8"));
  lock.packages.extension.version = "0.2.0";
  writeJson("package-lock.json", lock);
  expect(() => checkProductVersion(fixture, "v0.3.0")).toThrow(/extension\/package\.json/u);
});

test("fails when a workspace is absent from the lockfile", () => {
  makeFixture();
  const lock = JSON.parse(readFileSync(join(fixture, "package-lock.json"), "utf8"));
  delete lock.packages["packages/core"];
  writeJson("package-lock.json", lock);
  expect(() => checkProductVersion(fixture, "v0.3.0")).toThrow(/missing from package-lock/u);
});

test("fails on workspace, plugin, native, and tag drift", () => {
  makeFixture();
  writeJson("packages/core/package.json", { version: "0.2.0" });
  expect(() => checkProductVersion(fixture, "v0.3.0")).toThrow(/manifest=0\.2\.0/u);
  writeJson("packages/core/package.json", { version: "0.3.0" });
  writeJson(jsonPlugins[0], { version: "0.2.0" });
  expect(() => checkProductVersion(fixture, "v0.3.0")).toThrow(/plugin\.json: 0\.2\.0/u);
  writeJson(jsonPlugins[0], { version: "0.3.0" });
  writeJson(productVersionContracts[0], { productVersion: "0.2.0" });
  expect(() => checkProductVersion(fixture, "v0.3.0")).toThrow(/release-contract\.json: 0\.2\.0/u);
  writeJson(productVersionContracts[0], { productVersion: "0.3.0" });
  write("android/app/build.gradle.kts", 'versionCode = 0\nversionName = "0.2.0"\n');
  expect(() => checkProductVersion(fixture, "v0.3.0")).toThrow(/Android versionName/u);
  expect(() => checkProductVersion(fixture, "v0.4.0")).toThrow(/tag=v0\.4\.0/u);
});

test("requires strict SemVer and an explicit tag", () => {
  makeFixture();
  expect(() => checkProductVersion(fixture)).toThrow(/Expected release tag/u);
  writeJson("packages/cli/package.json", { version: "01.3.0" });
  expect(() => checkProductVersion(fixture, "v01.3.0")).toThrow(/not strict SemVer/u);
});

test("rejects platform-invalid native build counters before native tests are omitted", () => {
  makeFixture();
  write("android/app/build.gradle.kts", 'versionCode = 2100000001\nversionName = "0.3.0"\n');
  expect(() => checkProductVersion(fixture, "v0.3.0")).toThrow(/invalid Android versionCode/u);
  write("android/app/build.gradle.kts", 'versionCode = 1\nversionName = "0.3.0"\n');
  write("ios/project.yml", 'MARKETING_VERSION: "0.3.0"\nCURRENT_PROJECT_VERSION: "10000"\n');
  expect(() => checkProductVersion(fixture, "v0.3.0")).toThrow(/invalid iOS build/u);
});
