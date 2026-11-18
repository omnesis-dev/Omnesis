// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveNpmInvocation } from "./node-command.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "omnesis-npm-command-"));
  roots.push(path);
  return path;
}

async function materializeNpm(path: string): Promise<string> {
  const bin = join(path, "node_modules", "npm", "bin");
  await mkdir(bin, { recursive: true });
  const cli = join(bin, "npm-cli.js");
  await writeFile(cli, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  // A batch file must never run, even when its contents are executable elsewhere.
  await writeFile(join(path, "npm.cmd"), "@echo SHIM_MUST_NOT_EXECUTE\n");
  return cli;
}

describe("resolveNpmInvocation", () => {
  it("uses the invoking npm JavaScript CLI on Windows without a shell", async () => {
    const cli = await materializeNpm(await root());
    expect(
      await resolveNpmInvocation(["run", "test"], {
        env: { npm_execpath: cli },
        platform: "win32",
      }),
    ).toEqual({ command: process.execPath, args: [cli, "run", "test"] });
  });

  it("rejects a relative invoking npm path", async () => {
    await expect(
      resolveNpmInvocation([], { env: { npm_execpath: "relative/npm-cli.js" }, platform: "win32" }),
    ).rejects.toThrow("existing absolute JavaScript npm CLI");
  });
  it("finds npm beside Node and executes its CLI with literal argv", async () => {
    const install = join(await root(), "Node ' & $() install");
    const cli = await materializeNpm(install);
    const args = ["ci", "--prefix", "space & $() value", '"quoted"'];
    const invocation = await resolveNpmInvocation(args, {
      command: "npm.cmd",
      env: {},
      platform: "win32",
      nodePath: join(install, "node.exe"),
    });
    expect(invocation).toEqual({ command: process.execPath, args: [cli, ...args] });
    expect(
      JSON.parse(execFileSync(invocation.command, invocation.args, { encoding: "utf8" })),
    ).toEqual(args);
  });

  it("resolves npm using a mixed-case Path environment variable on Windows", async () => {
    const dir = await root();
    const install = join(dir, "npm on path");
    const cli = await materializeNpm(install);
    expect(
      await resolveNpmInvocation(["--version"], {
        env: { Path: `"${install}"` },
        platform: "win32",
        nodePath: join(dir, "missing", "node.exe"),
      }),
    ).toEqual({ command: process.execPath, args: [cli, "--version"] });
  });

  it("honors an explicit npm.cmd installation instead of a default Node installation", async () => {
    const dir = await root();
    const defaultInstall = join(dir, "default");
    const explicitInstall = join(dir, "explicit");
    await materializeNpm(defaultInstall);
    const cli = await materializeNpm(explicitInstall);
    expect(
      await resolveNpmInvocation([], {
        command: join(explicitInstall, "npm.cmd"),
        env: {},
        platform: "win32",
        nodePath: join(defaultInstall, "node.exe"),
      }),
    ).toEqual({ command: process.execPath, args: [cli] });
  });

  it("does not replace a broken explicit npm.cmd installation with another npm", async () => {
    const dir = await root();
    const defaultInstall = join(dir, "default");
    await materializeNpm(defaultInstall);
    await expect(
      resolveNpmInvocation([], {
        command: join(dir, "missing", "npm.cmd"),
        env: {},
        platform: "win32",
        nodePath: join(defaultInstall, "node.exe"),
      }),
    ).rejects.toThrow("Cannot locate npm's JavaScript CLI");
  });

  it.each(["npm.exe", "custom-npm"])("preserves the explicit %s executable", async (command) => {
    expect(await resolveNpmInvocation(["--version"], { command, platform: "win32" })).toEqual({
      command,
      args: ["--version"],
    });
  });

  it("runs an explicit JavaScript npm CLI through Node", async () => {
    expect(
      await resolveNpmInvocation(["ci"], { command: "npm-cli.js", platform: "win32" }),
    ).toEqual({ command: process.execPath, args: ["npm-cli.js", "ci"] });
  });

  it("rejects custom batch commands without parsing their contents", async () => {
    await expect(
      resolveNpmInvocation([], { command: "custom-npm.cmd", platform: "win32" }),
    ).rejects.toThrow("JavaScript CLI, or an executable");
  });

  it("preserves POSIX command overrides", async () => {
    expect(await resolveNpmInvocation(["pack"], { command: "npm", platform: "linux" })).toEqual({
      command: "npm",
      args: ["pack"],
    });
  });
});
