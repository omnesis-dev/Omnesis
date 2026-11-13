// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeCommandInvocation } from "./node-command.js";

describe("nodeCommandInvocation", () => {
  it("executes a Windows JavaScript entry with literal argument boundaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-node-command-"));
    try {
      const entry = join(dir, "entry ' & $().mjs");
      writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
      const args = ["space value", "$(echo unexpected)", "& echo unexpected", '"quoted"', ""];
      const invocation = nodeCommandInvocation(entry, args, "win32");
      const output = execFileSync(invocation.command, invocation.args, { encoding: "utf8" });
      expect(JSON.parse(output)).toEqual(args);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["cli.js", "cli.mjs", "cli.cjs", "CLI.JS"])("wraps the %s entry", (entry) => {
    expect(nodeCommandInvocation(entry, ["--version"], "win32")).toEqual({
      command: process.execPath,
      args: [entry, "--version"],
    });
  });

  it.each(["linux", "darwin"] as const)("preserves %s executable invocation", (platform) => {
    expect(nodeCommandInvocation("cli.js", ["--version"], platform)).toEqual({
      command: "cli.js",
      args: ["--version"],
    });
  });

  it("preserves a native executable on Windows", () => {
    expect(nodeCommandInvocation("codex.exe", ["login", "status"], "win32")).toEqual({
      command: "codex.exe",
      args: ["login", "status"],
    });
  });
});
