// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { stableNodeBinDir } from "./node-bin-dir.js";

/** A fake realpath: resolves the given links, returns every other path unchanged. */
function realpathWith(links: Record<string, string>): (path: string) => string {
  return (path) => {
    if (path in links) return links[path]!;
    if (path.includes("/missing/")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return path;
  };
}

describe("stableNodeBinDir", () => {
  it("uses Homebrew's opt link when it points at the running keg's binary", () => {
    const execPath = "/opt/homebrew/Cellar/node@24/24.21.0/bin/node";
    const realpath = realpathWith({ "/opt/homebrew/opt/node@24/bin/node": execPath });
    expect(stableNodeBinDir(execPath, realpath)).toBe("/opt/homebrew/opt/node@24/bin");
  });

  it("handles the Intel and Linuxbrew prefixes the same way", () => {
    for (const prefix of ["/usr/local", "/home/linuxbrew/.linuxbrew"]) {
      const execPath = `${prefix}/Cellar/node/25.1.0/bin/node`;
      const realpath = realpathWith({ [`${prefix}/opt/node/bin/node`]: execPath });
      expect(stableNodeBinDir(execPath, realpath)).toBe(`${prefix}/opt/node/bin`);
    }
  });

  it("keeps the keg directory when the opt link points at another version", () => {
    const execPath = "/opt/homebrew/Cellar/node@24/24.20.0/bin/node";
    const realpath = realpathWith({
      "/opt/homebrew/opt/node@24/bin/node": "/opt/homebrew/Cellar/node@24/24.21.0/bin/node",
    });
    expect(stableNodeBinDir(execPath, realpath)).toBe("/opt/homebrew/Cellar/node@24/24.20.0/bin");
  });

  it("keeps the keg directory when there is no opt link", () => {
    const execPath = "/missing/Cellar/node@24/24.21.0/bin/node";
    expect(stableNodeBinDir(execPath, realpathWith({}))).toBe(
      "/missing/Cellar/node@24/24.21.0/bin",
    );
  });

  it("keeps the binary's own directory outside Homebrew", () => {
    for (const execPath of [
      "/usr/bin/node",
      "/home/maya/.nvm/versions/node/v24.21.0/bin/node",
      "/usr/local/bin/node",
    ]) {
      expect(stableNodeBinDir(execPath, realpathWith({}))).toBe(
        execPath.slice(0, execPath.lastIndexOf("/")),
      );
    }
  });
});
