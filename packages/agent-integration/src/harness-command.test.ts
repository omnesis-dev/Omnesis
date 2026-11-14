// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveHarnessBinary, resolveHarnessCommand } from "./harness-command.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function npmFixture(
  bin: unknown = { openclaw: "entry.mjs" },
  name = "openclaw",
): {
  shim: string;
  root: string;
  entry: string;
} {
  const root = mkdtempSync(join(tmpdir(), "harness command spaces-"));
  roots.push(root);
  const packageRoot = join(root, "node_modules", name);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name, bin }));
  const entry = join(packageRoot, "entry.mjs");
  writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  const shim = join(root, `${name}.cmd`);
  // The adapter must never parse or execute a shim's shell contents.
  writeFileSync(shim, "THIS MUST NEVER EXECUTE");
  return { shim, root, entry };
}

it("discovers Windows .exe/.cmd with semicolon PATH and service npm fallback", () => {
  const present = new Set([
    "C:\\tools\\openclaw.cmd",
    "C:\\Users\\Example\\AppData\\Roaming\\npm\\openclaw.cmd",
  ]);
  const opts = {
    platform: "win32" as const,
    env: {
      Path: "C:\\missing;C:\\tools",
      USERPROFILE: "C:\\Users\\Example",
      APPDATA: "C:\\Users\\Example\\AppData\\Roaming",
    },
    execPath: "C:\\Node\\node.exe",
    isExecutable: (path: string) => present.has(path),
  };
  expect(resolveHarnessBinary("openclaw", opts)).toBe("C:\\tools\\openclaw.cmd");
  expect(
    resolveHarnessBinary("openclaw", { ...opts, env: { ...opts.env, Path: "C:\\missing" } }),
  ).toBe("C:\\Users\\Example\\AppData\\Roaming\\npm\\openclaw.cmd");
  expect(
    resolveHarnessBinary("hermes", {
      ...opts,
      isExecutable: (path) => path === "C:\\tools\\hermes.exe",
    }),
  ).toBe("C:\\tools\\hermes.exe");
});
it("runs the installed npm bin through literal Node argv, retaining metacharacters and spaces", () => {
  const { shim, entry } = npmFixture();
  const args = [
    "plugins",
    "install",
    "a folder & literal$(nothing);.tgz",
    "",
    'quote"value',
    "line\nbreak",
  ];
  const command = resolveHarnessCommand(shim, args, { platform: "win32" });
  expect(command).toEqual({ command: process.execPath, args: [entry, ...args] });
  const child = spawnSync(command.command, command.args, { encoding: "utf8" });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual(args);
});
it.each([
  "../escape.mjs",
  "/outside.mjs",
  { openclaw: "missing.mjs" },
  { other: "entry.mjs" },
  { openclaw: "entry.cmd" },
])("rejects invalid installed bin %j rather than using a shell", (bin) => {
  const { shim } = npmFixture(bin);
  expect(() => resolveHarnessCommand(shim, [], { platform: "win32" })).toThrow(
    "reinstall OpenClaw",
  );
});
it.each(["unknown.cmd", "hermes.bat", "unknown.ps1"])(
  "refuses unsupported shell launcher %s",
  (command) => {
    expect(() =>
      resolveHarnessCommand(command, ["literal & argument"], { platform: "win32" }),
    ).toThrow("native executable");
  },
);
it("preserves Unix shebang commands and native Windows executables", () => {
  expect(resolveHarnessCommand("/invented/bin/openclaw", ["a b"], { platform: "darwin" })).toEqual({
    command: "/invented/bin/openclaw",
    args: ["a b"],
  });
  expect(resolveHarnessCommand("C:\\tools\\hermes.exe", ["a b"], { platform: "win32" })).toEqual({
    command: "C:\\tools\\hermes.exe",
    args: ["a b"],
  });
});

it("resolves npm's local node_modules/.bin layout without reading the shim", () => {
  const { shim, root, entry } = npmFixture();
  const directory = join(root, "node_modules", ".bin");
  mkdirSync(directory);
  const localShim = join(directory, "openclaw.cmd");
  renameSync(shim, localShim);
  expect(resolveHarnessCommand(localShim, ["gateway", "restart"], { platform: "win32" })).toEqual({
    command: process.execPath,
    args: [entry, "gateway", "restart"],
  });
});
it("rejects an existing JavaScript file outside the package, not just a missing file", () => {
  const { shim, root } = npmFixture({ openclaw: "../outside.mjs" });
  writeFileSync(join(root, "node_modules", "outside.mjs"), "process.exit(0)");
  expect(() => resolveHarnessCommand(shim, [], { platform: "win32" })).toThrow(
    "reinstall OpenClaw",
  );
});

it("resolves the published omnesis package bin while preserving update argv", () => {
  const { shim, root } = npmFixture({ omnesis: "./dist/index.js" }, "omnesis");
  const directory = join(root, "node_modules", "omnesis", "dist");
  mkdirSync(directory);
  const entry = join(directory, "index.js");
  writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  const args = ["update", "--no-restart", "--target-version=0.5.0", "literal & value"];
  const invocation = resolveHarnessCommand(shim, args, { platform: "win32" });
  expect(invocation).toEqual({ command: process.execPath, args: [entry, ...args] });
  const child = spawnSync(invocation.command, invocation.args, { encoding: "utf8" });
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual(args);
  expect(resolveHarnessCommand("C:/Example/omnesis.exe", args, { platform: "win32" })).toEqual({
    command: "C:/Example/omnesis.exe",
    args,
  });
});
it("refuses a shim whose adjacent manifest declares a different package", () => {
  const { shim, root } = npmFixture();
  writeFileSync(
    join(root, "node_modules", "openclaw", "package.json"),
    JSON.stringify({ name: "unrelated", bin: { openclaw: "entry.mjs" } }),
  );
  expect(() => resolveHarnessCommand(shim, [], { platform: "win32" })).toThrow(
    "reinstall OpenClaw",
  );
});
