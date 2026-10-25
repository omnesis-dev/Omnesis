// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { packageLauncher } from "../update/package-migration-plan.js";
import { sourceRecoveryLauncher } from "../update/source-launcher.js";
import {
  classifyLauncherText,
  DOCKER_WRAPPER_MARKER,
  parseShellQuoted,
  readLauncher,
} from "./launcher.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseShellQuoted", () => {
  test("reads what shell_single_quote writes, embedded quotes included", () => {
    expect(parseShellQuoted("'/home/maya/omnesis'")).toBe("/home/maya/omnesis");
    expect(parseShellQuoted(`'/home/o'"'"'brien/omnesis'`)).toBe("/home/o'brien/omnesis");
    expect(parseShellQuoted("'with space'")).toBe("with space");
  });

  test("refuses anything that needs a real shell to evaluate", () => {
    expect(parseShellQuoted("$HOME/omnesis")).toBeNull();
    expect(parseShellQuoted("'unterminated")).toBeNull();
    expect(parseShellQuoted("")).toBeNull();
  });
});

describe("classifyLauncherText", () => {
  test("the installer's source launcher names its checkout and config dir", () => {
    const text = sourceRecoveryLauncher(
      "/home/maya/omnesis",
      "/home/maya/.config/omnesis",
      "/x/lock.cjs",
    );
    expect(classifyLauncherText("/l", text)).toEqual({
      kind: "source",
      path: "/l",
      sourceRoot: "/home/maya/omnesis",
      configDir: "/home/maya/.config/omnesis",
    });
  });

  test("a source launcher in a quoted path still parses", () => {
    const root = "/home/o'brien/omnesis checkout";
    const launcher = classifyLauncherText("/l", sourceRecoveryLauncher(root, "/c", "/x/lock.cjs"));
    expect(launcher).toMatchObject({ kind: "source", sourceRoot: root });
  });

  test("the package launcher names its prefix", () => {
    const text = packageLauncher("/home/maya/.npm-global", "/home/maya/.npm-global/bin/omnesis");
    expect(classifyLauncherText("/l", text)).toEqual({
      kind: "package",
      path: "/l",
      prefix: "/home/maya/.npm-global",
      executable: "/home/maya/.npm-global/bin/omnesis",
    });
  });

  test("the Docker wrapper names its compose file", () => {
    const text = `#!/bin/sh\n${DOCKER_WRAPPER_MARKER}\nCOMPOSE_FILE='/home/maya/.config/omnesis/docker-compose.yml'\nSERVICE='gateway'\nset -eu\n`;
    expect(classifyLauncherText("/l", text)).toEqual({
      kind: "docker",
      path: "/l",
      composeFile: "/home/maya/.config/omnesis/docker-compose.yml",
    });
  });

  test("a script of the operator's own is foreign, even one that looks close", () => {
    expect(classifyLauncherText("/l", "#!/bin/bash\nexec node cli.js\n").kind).toBe("foreign");
    const edited = `${packageLauncher("/p", "/p/bin/omnesis")}echo extra\n`;
    expect(classifyLauncherText("/l", edited).kind).toBe("foreign");
    const elsewhere = "#!/bin/sh\nSOURCE_ROOT='/home/maya/omnesis'\nexec /opt/other \"$@\"\n";
    expect(classifyLauncherText("/l", elsewhere).kind).toBe("foreign");
  });
});

describe("readLauncher", () => {
  test("nothing there, a symlink and a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-launcher-"));
    dirs.push(dir);
    expect(readLauncher(join(dir, "omnesis")).kind).toBe("absent");
    writeFileSync(join(dir, "target"), packageLauncher("/p", "/p/bin/omnesis"));
    symlinkSync(join(dir, "target"), join(dir, "omnesis"));
    expect(readLauncher(join(dir, "omnesis"))).toMatchObject({
      kind: "foreign",
      reason: "it is a symbolic link",
    });
    mkdirSync(join(dir, "folder"));
    expect(readLauncher(join(dir, "folder")).kind).toBe("foreign");
    expect(readLauncher(join(dir, "target")).kind).toBe("package");
  });
});
