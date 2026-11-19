// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import { hostConfigIssues, object, path } from "./config-schema.js";
import {
  containerPathHint,
  expandHostPath,
  hostHomeDir,
  nodePathProbe,
} from "./path-probe-node.js";

vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
}));

// Root reads everything, so a closed folder proves nothing when run as root.
const asRoot = process.getuid?.() === 0;

describe("nodePathProbe.readable", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function folder(): string {
    const dir = mkdtempSync(join(tmpdir(), "path-probe-"));
    dirs.push(dir);
    return dir;
  }

  test("an open folder and file are readable", () => {
    const dir = folder();
    writeFileSync(join(dir, "note.md"), "fictional");
    expect(nodePathProbe.readable!(dir)).toBe(true);
    expect(nodePathProbe.readable!(join(dir, "note.md"))).toBe(true);
  });

  // chmod changes POSIX mode bits, not Windows directory ACLs.
  test.skipIf(asRoot || process.platform === "win32")(
    "a POSIX folder with no access bits is unreadable",
    () => {
      const dir = folder();
      chmodSync(dir, 0o000);
      expect(nodePathProbe.readable!(dir)).toBe(false);
    },
  );

  test.each(["EACCES", "EPERM"])(
    "denied access (%s) is reported without throwing on every platform",
    (code) => {
      const directory = folder();
      vi.spyOn(fs, "accessSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("permission denied"), { code });
      });
      expect(nodePathProbe.readable!(directory)).toBe(false);
      expect(nodePathProbe.readable!(directory)).toBe(true);
    },
  );

  test("a path that is gone is not", () => {
    expect(nodePathProbe.readable!(join(folder(), "missing"))).toBe(false);
  });
});

describe("a Docker install's container: the host's home and its folders", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("outside a container, ~ is the running user's home and there is no hint", () => {
    vi.stubEnv("OMNESIS_HOST_HOME", "");
    expect(hostHomeDir()).toBe(homedir());
    expect(expandHostPath("~/Documents/Vault")).toBe(join(homedir(), "Documents/Vault"));
    expect(containerPathHint("/srv/notes")).toBeUndefined();
  });

  test("in a container, ~ is the host account's home, not the container's", () => {
    vi.stubEnv("OMNESIS_HOST_HOME", "/Users/maya");
    expect(expandHostPath("~")).toBe("/Users/maya");
    expect(expandHostPath("~/Documents/Vault")).toBe(join("/Users/maya", "Documents", "Vault"));
    // An absolute path is the operator's already.
    expect(expandHostPath("/Volumes/Archive")).toBe("/Volumes/Archive");
  });

  test("a relative host home is ignored rather than trusted", () => {
    vi.stubEnv("OMNESIS_HOST_HOME", "Users/maya");
    expect(hostHomeDir()).toBe(homedir());
  });

  test("a missing folder names the container boundary and the exact command that shares it", () => {
    vi.stubEnv("OMNESIS_HOST_HOME", "/Users/maya");
    const vault = object({
      vaultPath: path({ label: "Vault path", mustExist: "directory", required: true }),
    });
    const issues = hostConfigIssues(vault, { vaultPath: "~/Documents/field-notes" }, nodePathProbe);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toBe(
      "Vault path does not exist: ~/Documents/field-notes. This collector runs in a Docker " +
        "container, which sees only the install's config directory and the folders shared with " +
        "it. If the folder is on the machine that runs Docker, share it with the collector " +
        `there: omnesis folders share '${join("/Users/maya", "Documents", "field-notes")}'`,
    );
  });

  test("a quote in the folder name stays one shell word", () => {
    vi.stubEnv("OMNESIS_HOST_HOME", "/Users/maya");
    expect(containerPathHint("/Users/maya/Jamie's notes")).toContain(
      `omnesis folders share '/Users/maya/Jamie'\\''s notes'`,
    );
  });
});

test("native home paths expand only the host's directory separators", () => {
  vi.stubEnv("OMNESIS_HOST_HOME", "");
  try {
    expect(expandHostPath("~")).toBe(homedir());
    expect(expandHostPath("~/Documents/Vault")).toBe(join(homedir(), "Documents", "Vault"));
    const backslashPath = "~\\Documents\\Vault";
    expect(expandHostPath(backslashPath)).toBe(
      process.platform === "win32" ? join(homedir(), "Documents", "Vault") : resolve(backslashPath),
    );
    expect(expandHostPath("~another/Notes")).toBe(resolve("~another/Notes"));
  } finally {
    vi.unstubAllEnvs();
  }
});
