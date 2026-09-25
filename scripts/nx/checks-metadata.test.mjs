// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { hasVersionMetadata, selectionFiles } from "./checks.mjs";
import { changedFiles, treeFingerprint } from "./tree-state.mjs";

const repository = process.cwd();
const fixtures = [];

function write(path, value) {
  const target = join(process.cwd(), path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omnesis-nx-metadata-"));
  fixtures.push(root);
  process.chdir(root);
  execFileSync("git", ["init", "-q", "-b", "main"]);
  execFileSync("git", ["config", "user.name", "fixture-author"]);
  execFileSync("git", ["config", "user.email", "maya.reeves@example.com"]);
  write("package.json", { name: "fixture", workspaces: ["packages/*"] });
  write("packages/alpha/package.json", {
    name: "@example/alpha",
    version: "0.4.5",
    dependencies: { example: "^1.0.0" },
  });
  write("package-lock.json", {
    name: "fixture",
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture" },
      "packages/alpha": {
        name: "@example/alpha",
        version: "0.4.5",
        dependencies: { example: "^1.0.0" },
      },
      "node_modules/example": { version: "1.0.0", integrity: "sha512-example" },
    },
  });
  write("packages/alpha/CHANGELOG.md", "# Changelog\n");
  write("integrations/openclaw-omnesis-plugin/package.json", {
    name: "@example/plugin",
    version: "0.4.5",
    dependencies: { example: "^1.0.0" },
  });
  write("extension/public/manifest.json", { version: "0.4.5", manifest_version: 3 });
  write("packages/agent-integration/hermes/plugin.yaml", "name: fixture\nversion: 0.4.5\n");
  write("android/app/build.gradle.kts", 'versionCode = 1\nversionName = "0.4.5"\n');
  write("ios/project.yml", 'MARKETING_VERSION: "0.4.5"\nCURRENT_PROJECT_VERSION: "1"\n');
  for (const file of ["ios/Info.plist", "ios/Info-Demo.plist"]) {
    write(
      file,
      "<key>CFBundleShortVersionString</key><string>0.4.5</string>\n" +
        "<key>CFBundleVersion</key><string>1</string>\n",
    );
  }
  write(".changeset/release.md", '---\n"@example/alpha": patch\n---\n\nFictional update.\n');
  execFileSync("git", ["add", "."]);
  execFileSync("git", ["commit", "-qm", "baseline"]);
  return root;
}

function bump() {
  const manifest = readJson("packages/alpha/package.json");
  manifest.version = "0.4.6";
  write("packages/alpha/package.json", manifest);
  const lock = readJson("package-lock.json");
  lock.packages["packages/alpha"].version = "0.4.6";
  write("package-lock.json", lock);
  write("packages/alpha/CHANGELOG.md", "# Changelog\n\n## 0.4.6\n\nFictional update.\n");
  write(
    ".changeset/release.md",
    '---\n"@example/alpha": patch\n---\n\nRevised fictional update.\n',
  );
}

afterEach(() => {
  process.chdir(repository);
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a combined release metadata change retains raw identity but selects no product tests", () => {
  fixture();
  const before = treeFingerprint("HEAD").fingerprint;
  bump();
  const raw = changedFiles("HEAD").files;
  expect(raw).toEqual([
    ".changeset/release.md",
    "package-lock.json",
    "packages/alpha/CHANGELOG.md",
    "packages/alpha/package.json",
  ]);
  expect(treeFingerprint("HEAD").fingerprint).not.toBe(before);
  expect(selectionFiles("HEAD", raw)).toEqual([]);
});

test("version-only files remain metadata when staged or committed after the merge base", () => {
  fixture();
  bump();
  execFileSync("git", ["add", "package-lock.json", "packages/alpha/package.json"]);
  expect(selectionFiles("HEAD", changedFiles("HEAD").files)).toEqual([]);
  execFileSync("git", ["add", "."]);
  execFileSync("git", ["commit", "-qm", "release metadata"]);
  expect(selectionFiles("HEAD^", changedFiles("HEAD^").files)).toEqual([]);
});

test("a release plugin version bump is metadata, but a dependency edit is selected", () => {
  fixture();
  const file = "integrations/openclaw-omnesis-plugin/package.json";
  const plugin = readJson(file);
  plugin.version = "0.4.6";
  write(file, plugin);
  expect(selectionFiles("HEAD", [file])).toEqual([]);
  plugin.dependencies.example = "^2.0.0";
  write(file, plugin);
  expect(selectionFiles("HEAD", [file])).toEqual([file]);
});

test("a store manifest version bump is metadata, but a permission edit is selected", () => {
  fixture();
  const file = "extension/public/manifest.json";
  const manifest = readJson(file);
  manifest.version = "0.4.6";
  write(file, manifest);
  expect(selectionFiles("HEAD", [file])).toEqual([]);
  expect(hasVersionMetadata([file], [])).toBe(true);
  manifest.permissions = ["storage"];
  write(file, manifest);
  expect(selectionFiles("HEAD", [file])).toEqual([file]);
});

test("a plugin YAML version bump is metadata, but a setting edit is selected", () => {
  fixture();
  const file = "packages/agent-integration/hermes/plugin.yaml";
  write(file, "name: fixture\nversion: 0.4.6\n");
  expect(selectionFiles("HEAD", [file])).toEqual([]);
  write(file, "name: changed\nversion: 0.4.6\n");
  expect(selectionFiles("HEAD", [file])).toEqual([file]);
});

test("native marketing and build-number bumps skip test suites, while other edits stay selected", () => {
  fixture();
  const changed = [
    ["android/app/build.gradle.kts", 'versionCode = 2\nversionName = "0.4.6"\n'],
    ["ios/project.yml", 'MARKETING_VERSION: "0.4.6"\nCURRENT_PROJECT_VERSION: "2"\n'],
    ...["ios/Info.plist", "ios/Info-Demo.plist"].map((file) => [
      file,
      "<key>CFBundleShortVersionString</key><string>0.4.6</string>\n" +
        "<key>CFBundleVersion</key><string>2</string>\n",
    ]),
  ];
  for (const [file, contents] of changed) {
    write(file, contents);
    expect(selectionFiles("HEAD", [file])).toEqual([]);
  }
  expect(
    hasVersionMetadata(
      changed.map(([file]) => file),
      [],
    ),
  ).toBe(true);
  write("android/app/build.gradle.kts", 'versionCode = 2\nversionName = "0.4.6"\nminSdk = 30\n');
  expect(selectionFiles("HEAD", ["android/app/build.gradle.kts"])).toEqual([
    "android/app/build.gradle.kts",
  ]);
});

test("dependency and integrity edits keep global inputs in the selected plan", () => {
  fixture();
  bump();
  const manifest = readJson("packages/alpha/package.json");
  manifest.dependencies.example = "^2.0.0";
  write("packages/alpha/package.json", manifest);
  const lock = readJson("package-lock.json");
  lock.packages["node_modules/example"].integrity = "sha512-changed";
  write("package-lock.json", lock);
  expect(selectionFiles("HEAD", changedFiles("HEAD").files)).toEqual([
    "package-lock.json",
    "packages/alpha/package.json",
  ]);
});

test.each([
  [
    "workspace dependency",
    (lock) => (lock.packages["packages/alpha"].dependencies.example = "^2.0.0"),
  ],
  ["external version", (lock) => (lock.packages["node_modules/example"].version = "2.0.0")],
  [
    "external integrity",
    (lock) => (lock.packages["node_modules/example"].integrity = "sha512-new"),
  ],
  ["lockfile schema", (lock) => (lock.lockfileVersion = 2)],
])("a %s lockfile edit is not dismissed as release metadata", (_, mutate) => {
  fixture();
  bump();
  const lock = readJson("package-lock.json");
  mutate(lock);
  write("package-lock.json", lock);
  expect(selectionFiles("HEAD", ["package-lock.json"])).toEqual(["package-lock.json"]);
});

test("release metadata does not mask a changed product source file", () => {
  fixture();
  bump();
  write("packages/alpha/src/index.ts", "export const value = 1;\n");
  expect(selectionFiles("HEAD", changedFiles("HEAD").files)).toEqual([
    "packages/alpha/src/index.ts",
  ]);
});

test("an inconsistent, malformed, missing or newly added manifest fails closed", () => {
  fixture();
  bump();
  const lock = readJson("package-lock.json");
  lock.packages["packages/alpha"].version = "0.4.7";
  write("package-lock.json", lock);
  expect(selectionFiles("HEAD", ["package-lock.json"])).toEqual(["package-lock.json"]);
  write("packages/alpha/package.json", "{ invalid json\n");
  expect(selectionFiles("HEAD", ["packages/alpha/package.json"])).toEqual([
    "packages/alpha/package.json",
  ]);
  write("packages/new/package.json", { name: "@example/new", version: "0.4.6" });
  expect(selectionFiles("HEAD", ["packages/new/package.json"])).toEqual([
    "packages/new/package.json",
  ]);
  rmSync("packages/alpha/package.json");
  expect(selectionFiles("HEAD", ["packages/alpha/package.json"])).toEqual([
    "packages/alpha/package.json",
  ]);
});

test("release prose alone is non-code, while changeset config stays selected", () => {
  fixture();
  expect(
    selectionFiles("HEAD", [
      ".changeset/release.md",
      "packages/alpha/CHANGELOG.md",
      ".changeset/config.json",
    ]),
  ).toEqual([".changeset/config.json"]);
});

test("version-only metadata requests consistency validation, while release prose does not", () => {
  fixture();
  bump();
  const files = changedFiles("HEAD").files;
  const selected = selectionFiles("HEAD", files);
  expect(selected).toEqual([]);
  expect(hasVersionMetadata(files, selected)).toBe(true);
  expect(hasVersionMetadata([".changeset/release.md"], [])).toBe(false);
});
