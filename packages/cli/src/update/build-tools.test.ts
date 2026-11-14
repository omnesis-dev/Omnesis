// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNpmInvocation, summarizeCommandFailure } from "@omnesis/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildToolsInstallCommand,
  buildToolsRefusal,
  missingBuildTools,
  nodeBuildToolProbe,
  nodeNpmRefusal,
  npmRefusal,
  REQUIRED_BUILD_TOOLS,
  type BuildToolProbe,
} from "./build-tools.js";

function probe(overrides: Partial<BuildToolProbe> & { present?: string[] } = {}): BuildToolProbe {
  const present = new Set(overrides.present ?? [...REQUIRED_BUILD_TOOLS]);
  return {
    platform: overrides.platform ?? "linux",
    runs: overrides.runs ?? ((command) => present.has(command)),
  };
}

describe("missingBuildTools", () => {
  it("names nothing on a Linux machine that has the whole toolchain", () => {
    expect(missingBuildTools(probe())).toEqual([]);
  });

  it("names the tool a machine without a compiler is missing", () => {
    expect(missingBuildTools(probe({ present: ["make", "cc", "python3"] }))).toEqual(["c++"]);
  });

  it("names every missing tool, in the order an operator reads them", () => {
    expect(missingBuildTools(probe({ present: [] }))).toEqual(["make", "cc", "c++", "python3"]);
  });

  it("treats a name on PATH that cannot run as missing", () => {
    // `command -v make` succeeding proves a file exists, not that it executes:
    // a broken symlink or a stub on a trimmed image passes the first test and
    // fails the build. Only running it settles the question.
    const broken = probe({ runs: (command) => command !== "make" });
    expect(missingBuildTools(broken)).toEqual(["make"]);
  });

  it("asks nothing of macOS, whose toolchain arrives with Xcode's command-line tools", () => {
    expect(missingBuildTools(probe({ platform: "darwin", present: [] }))).toEqual([]);
  });
});

describe("buildToolsInstallCommand", () => {
  it("names apt's packages on a Debian-family machine", () => {
    expect(buildToolsInstallCommand(probe({ present: ["apt-get"] }))).toBe(
      "sudo apt-get install -y build-essential python3",
    );
  });

  it("names dnf's packages on a RHEL-family machine", () => {
    expect(buildToolsInstallCommand(probe({ present: ["dnf"] }))).toBe(
      "sudo dnf install -y gcc-c++ make python3",
    );
  });

  it("needs a package manager that runs, not merely a name on PATH", () => {
    // Same reason as the toolchain check: a container image can carry a
    // dpkg-less apt-get stub, and naming it would send the operator to a
    // command that cannot work.
    expect(buildToolsInstallCommand(probe({ runs: () => false }))).toBeNull();
  });

  it("has no command for a distribution it does not know", () => {
    expect(buildToolsInstallCommand(probe({ present: [] }))).toBeNull();
  });
});

describe("buildToolsRefusal", () => {
  it("names what is missing, the command that fixes it, and that nothing moved", () => {
    const message = buildToolsRefusal(["make"], "sudo apt-get install -y build-essential python3");
    expect(message).toContain("missing make");
    // One tool is "it"; the operator reads this sentence, so it has to parse.
    expect(message).toContain("Install it with:");
    expect(message).toContain("sudo apt-get install -y build-essential python3");
    expect(message).toContain("omnesis update");
    expect(message).toContain("still on its current release");
  });

  it("falls back to naming the toolchain where no package manager is known", () => {
    const message = buildToolsRefusal(["make", "cc"], null);
    expect(message).toContain("missing make, cc");
    expect(message).toContain("C/C++ compilers, make and Python 3");
  });
});

describe("npmRefusal", () => {
  it("has nothing to say where npm runs", () => {
    expect(npmRefusal(probe({ present: ["npm"] }))).toBeNull();
  });

  it("refuses on macOS too, where a service's PATH can hold node without npm", () => {
    // Unlike the toolchain, npm is needed on every platform: the update spawns
    // `npm ci` by name, so a launchd PATH without it fails after the checkout
    // moved, and so does the rollback's own `npm ci`.
    const message = npmRefusal(probe({ platform: "darwin", present: [] }));
    expect(message).toContain("`npm ci`");
    expect(message).toContain("`npm` does not run on this PATH");
    expect(message).toContain("beside the `node` it runs");
    expect(message).toMatch(
      /Nothing has been changed, so the installation is still on its current release\.$/,
    );
  });
});

describe("npmRefusal on a named host", () => {
  const host = { nodeDir: "/opt/omnesis/bin", path: "/opt/omnesis/bin:/usr/bin:/bin" };
  const noNpm = probe({ platform: "darwin", present: [] });

  it("names the directory of the Node running the update and the PATH searched", () => {
    // Read on the gateway, about another machine: "beside the node it runs"
    // is a directory the operator cannot see from there.
    const message = npmRefusal(noNpm, host);
    expect(message).toContain("That node is in /opt/omnesis/bin");
    expect(message).toContain("the PATH is /opt/omnesis/bin:/usr/bin:/bin.");
  });

  it("says so when the process has no PATH at all", () => {
    expect(npmRefusal(noNpm, { ...host, path: undefined })).toContain("the PATH is empty.");
  });

  it("keeps the cause, the fix and that nothing moved in what a fleet update relays", () => {
    // A collector sends the gateway a capped summary of its updater's output,
    // cut at the end. The PATH is the one part of any length, so it is last.
    const relayed = summarizeCommandFailure(
      npmRefusal(noNpm, { ...host, path: Array(80).fill("/some/long/directory").join(":") })!,
    );
    expect(relayed).toContain("`npm` does not run on this PATH");
    expect(relayed).toContain("beside the `node` it runs");
    expect(relayed).toContain("Nothing has been changed");
    expect(relayed).toContain("That node is in /opt/omnesis/bin");
    expect(relayed.endsWith("…")).toBe(true);
  });
});

// The probe itself, against real processes: the fakes above cannot show that
// "npm is not on this PATH" is something the real question detects.
describe("npm availability on a real PATH", () => {
  const originalPath = process.env.PATH;
  let dir: string | undefined;

  /** A PATH holding this Node and whatever else the test puts beside it. */
  function isolatedPath(): string {
    dir = mkdtempSync(join(tmpdir(), "omnesis-npm-probe-"));
    copyFileSync(process.execPath, join(dir, process.platform === "win32" ? "node.exe" : "node"));
    process.env.PATH = dir;
    return dir;
  }

  function script(directory: string, body: string): void {
    writeFileSync(join(directory, "npm"), `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
    const bin = join(directory, "node_modules", "npm", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "npm-cli.js"), body);
  }

  const resolveIsolatedNpm: typeof resolveNpmInvocation = (args) =>
    resolveNpmInvocation(args, {
      env: process.env,
      nodePath: join(dir!, process.platform === "win32" ? "node.exe" : "node"),
    });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("finds no npm on a service PATH whose Node stands alone", async () => {
    const nodeDir = isolatedPath();
    expect(nodeBuildToolProbe.runs("node")).toBe(true);
    expect(await nodeNpmRefusal({ nodeDir, path: process.env.PATH }, resolveIsolatedNpm)).toContain(
      `That node is in ${nodeDir}, and the PATH is ${nodeDir}.`,
    );
  });

  it("finds the npm placed beside that Node, which is the fix the refusal names", async () => {
    script(isolatedPath(), "process.stdout.write('11.0.0');");
    expect(await nodeNpmRefusal(undefined, resolveIsolatedNpm)).toBeNull();
  });

  it("does not take an npm that exits the way a missing command does for one that runs", async () => {
    script(isolatedPath(), "process.exit(127);");
    expect(await nodeNpmRefusal(undefined, resolveIsolatedNpm)).toContain("npm` does not run");
  });

  it("does not take a launcher with no npm installation for one that runs", async () => {
    const directory = isolatedPath();
    if (process.platform === "win32") {
      writeFileSync(join(directory, "npm.cmd"), "@echo off\r\nnode missing-npm-cli.js\r\n");
    } else {
      symlinkSync("/nonexistent/npm", join(directory, "npm"));
    }
    expect(await nodeNpmRefusal(undefined, resolveIsolatedNpm)).toContain("npm` does not run");
  });
});

describe("npm executable probe", () => {
  it("accepts a resolved executable that runs successfully", async () => {
    expect(
      await nodeNpmRefusal(undefined, async () => ({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      })),
    ).toBeNull();
  });

  it("refuses an npm executable that fails", async () => {
    expect(
      await nodeNpmRefusal(undefined, async () => ({
        command: process.execPath,
        args: ["-e", "process.exit(1)"],
      })),
    ).toContain("npm` does not run");
  });

  it("reports an unresolved npm installation without mutating it", async () => {
    expect(
      await nodeNpmRefusal(undefined, async () => {
        throw new Error("npm not installed");
      }),
    ).toContain("Nothing has been changed");
  });
});
