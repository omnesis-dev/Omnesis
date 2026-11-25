// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import {
  normalizeDesktopTestRunner,
  reduceTestRunnerEntitlements,
} from "../../macos/Tests/Support/normalize-test-runner-signature.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-ui-signature-fixture-")));
  roots.push(root);
  const products = join(root, "build/Build/Products/Debug");
  const app = join(products, "OmnesisDesktopUITests-Runner.app");
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents/MacOS/OmnesisDesktopUITests-Runner"), "inert fixture");
  writeFileSync(join(app, "Contents/Info.plist"), "inert metadata fixture");
  const info = {
    CFBundleIdentifier: "dev.omnesis.desktop.uitests.xctrunner",
    CFBundleExecutable: "OmnesisDesktopUITests-Runner",
    CFBundlePackageType: "APPL",
  };
  let entitlements = {
    "com.apple.application-identifier": info.CFBundleIdentifier,
    "com.apple.developer.team-identifier": "EXAMPLETEAM",
    "com.apple.security.get-task-allow": true,
    "com.apple.security.app-sandbox": true,
    "com.apple.security.network.client": true,
    "com.apple.security.temporary-exception.mach-lookup.global-name": ["com.apple.testmanagerd"],
  };
  let addPermission = false;
  const run = vi.fn((command, args, options) => {
    if (command === "/usr/bin/plutil" && args.includes("Info.plist"))
      throw new Error("Unexpected bare metadata path");
    if (command === "/usr/bin/plutil" && args.at(-1).endsWith("Info.plist"))
      return { status: 0, stdout: JSON.stringify(info) };
    if (command === "/usr/bin/codesign" && args[0] === "-d")
      return { status: 0, stdout: JSON.stringify(entitlements) };
    if (command === "/usr/bin/plutil" && args.at(-1) === "-")
      return { status: 0, stdout: options.input };
    if (command === "/usr/bin/codesign" && args[0] === "--force") {
      entitlements = JSON.parse(readFileSync(args[args.indexOf("--entitlements") + 1], "utf8"));
      if (addPermission) entitlements["com.apple.security.network.server"] = true;
    }
    return { status: 0, stdout: "" };
  });
  return {
    root,
    products,
    app,
    info,
    run,
    dependencies: { run, platform: "darwin" },
    changePermission: () => {
      addPermission = true;
    },
  };
}

test("only identified restricted claims are removed; every existing permission remains byte-equivalent", () => {
  const before = {
    "com.apple.application-identifier": "dev.example.uitests",
    "com.apple.developer.team-identifier": "EXAMPLETEAM",
    "com.apple.security.get-task-allow": true,
    "com.apple.security.app-sandbox": true,
    "fixture-preserved": { array: [true, "value"] },
  };
  const result = reduceTestRunnerEntitlements(before);
  expect(result).toEqual({
    "com.apple.security.get-task-allow": true,
    "com.apple.security.app-sandbox": true,
    "fixture-preserved": { array: [true, "value"] },
  });
  expect(before).toHaveProperty("com.apple.application-identifier");
});

test("normalizes only the exact generated test runner and verifies its resulting entitlements", () => {
  const f = fixture();
  expect(normalizeDesktopTestRunner(f.products, f.dependencies, f.root)).toEqual({
    removed: ["com.apple.application-identifier", "com.apple.developer.team-identifier"],
    addedPermissions: 0,
  });
  const signing = f.run.mock.calls.filter(
    ([command, args]) => command === "/usr/bin/codesign" && args[0] === "--force",
  );
  expect(signing).toHaveLength(1);
  expect(signing[0][1].at(-1)).toBe(f.app);
  expect(signing[0][1]).toContain("--timestamp=none");
  expect(
    f.run.mock.calls.some(([, args]) => args.some((arg) => arg.endsWith("/Omnesis.app"))),
  ).toBe(false);
});

test("a resulting added permission fails instead of claiming normalization succeeded", () => {
  const f = fixture();
  f.changePermission();
  expect(() => normalizeDesktopTestRunner(f.products, f.dependencies, f.root)).toThrow(
    /unexpected permission/,
  );
});

test("wrong bundle identity refuses signing before any mutation", () => {
  const f = fixture();
  f.info.CFBundleIdentifier = "dev.example.other-app";
  expect(() => normalizeDesktopTestRunner(f.products, f.dependencies, f.root)).toThrow(/identity/);
  expect(f.run.mock.calls.some(([, args]) => args[0] === "--force")).toBe(false);
});

test("an arbitrary products directory is never accepted", () => {
  const f = fixture();
  expect(() => normalizeDesktopTestRunner(join(f.root, "other"), f.dependencies, f.root)).toThrow(
    /generated Debug/,
  );
  expect(f.run).not.toHaveBeenCalled();
});

test.skipIf(process.platform === "win32")(
  "an aliased runner cannot authorize changes to another app",
  () => {
    const f = fixture();
    rmSync(f.app, { recursive: true, force: true });
    const other = join(f.root, "other.app");
    mkdirSync(other);
    symlinkSync(other, f.app);
    expect(() => normalizeDesktopTestRunner(f.products, f.dependencies, f.root)).toThrow(/unsafe/);
    expect(f.run).not.toHaveBeenCalled();
  },
);

test("a hard-linked executable refuses mutation of shared code", () => {
  const f = fixture();
  linkSync(join(f.app, "Contents/MacOS/OmnesisDesktopUITests-Runner"), join(f.root, "shared-code"));
  expect(() => normalizeDesktopTestRunner(f.products, f.dependencies, f.root)).toThrow(/unsafe/);
  expect(f.run).not.toHaveBeenCalled();
});

test("signature inspection records exact owned runner evidence without mutation", () => {
  const f = fixture();
  const observed = normalizeDesktopTestRunner(f.products, f.dependencies, f.root, true);
  expect(observed.bundleIdentifier).toBe(f.info.CFBundleIdentifier);
  expect(observed.executableSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(observed.restrictedClaimsPresent).toEqual([
    "com.apple.application-identifier",
    "com.apple.developer.team-identifier",
  ]);
  expect(f.run.mock.calls.some(([, args]) => args[0] === "--force")).toBe(false);
});
