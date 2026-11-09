// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import {
  buildToolsInstallCommand,
  buildToolsRefusal,
  missingBuildTools,
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
