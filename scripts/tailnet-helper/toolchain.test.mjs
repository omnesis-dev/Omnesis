// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  atLeast,
  goArchiveFile,
  goArchiveKey,
  goEnv,
  installedGo,
  parseGoVersion,
  pinnedGo,
  requiredGoVersion,
} from "./toolchain.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pinned = JSON.parse(
  readFileSync(join(root, "scripts/tailnet-helper/go-toolchain.json"), "utf8"),
);

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-go-toolchain-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the pinned toolchain", () => {
  test("is the Go version the helper's go.mod names", () => {
    const goMod = readFileSync(join(root, "packages/tailnet-helper/go.mod"), "utf8");
    expect(pinned.version).toBe(requiredGoVersion(goMod));
  });

  test("names an archive with a SHA-256 for every Linux, macOS and Windows machine Omnesis runs on", () => {
    for (const key of [
      "linux-amd64",
      "linux-arm64",
      "darwin-amd64",
      "darwin-arm64",
      "windows-amd64",
      "windows-arm64",
    ])
      expect(pinned.archives[key], key).toBeDefined();
    for (const [key, archive] of Object.entries(pinned.archives)) {
      expect(archive.sha256, key).toMatch(/^[0-9a-f]{64}$/u);
      expect(archive.size, key).toBeGreaterThan(10_000_000);
    }
  });
});

describe("platforms and versions", () => {
  test("Node's platform and architecture name Go's archive", () => {
    expect(goArchiveKey("linux", "x64")).toBe("linux-amd64");
    expect(goArchiveKey("linux", "arm64")).toBe("linux-arm64");
    expect(goArchiveKey("linux", "arm")).toBe("linux-armv6l");
    expect(goArchiveKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(goArchiveKey("darwin", "x64")).toBe("darwin-amd64");
    expect(goArchiveKey("win32", "x64")).toBe("windows-amd64");
    expect(goArchiveKey("win32", "arm64")).toBe("windows-arm64");
    expect(goArchiveKey("freebsd", "x64")).toBeNull();
    expect(goArchiveFile("1.27.4", "windows-amd64")).toBe("go1.27.4.windows-amd64.zip");
    expect(goArchiveFile("1.27.4", "darwin-arm64")).toBe("go1.27.4.darwin-arm64.tar.gz");
    expect(goArchiveKey("linux", "mips")).toBeNull();
    // Every key the mapping produces for Linux and macOS has an archive.
    for (const platform of ["linux", "darwin", "win32"])
      for (const arch of ["x64", "arm64"])
        expect(pinned.archives[goArchiveKey(platform, arch)]).toBeDefined();
  });

  test("versions compare by number, and an installed Go must be at least the module's", () => {
    expect(parseGoVersion("go version go1.27.4 linux/arm64")).toEqual([1, 27, 4]);
    expect(parseGoVersion("1.28")).toEqual([1, 28, 0]);
    expect(parseGoVersion("not go")).toBeNull();
    expect(atLeast([1, 27, 4], [1, 27, 4])).toBe(true);
    expect(atLeast([1, 28, 0], [1, 27, 4])).toBe(true);
    expect(atLeast([1, 27, 3], [1, 27, 4])).toBe(false);
    expect(atLeast([1, 9, 9], [1, 27, 0])).toBe(false);
    const run =
      (stdout, status = 0) =>
      () => ({ stdout, status });
    expect(installedGo("1.27.4", run("go version go1.27.4 darwin/arm64"))).toBe("go");
    expect(installedGo("1.27.4", run("go version go1.26.9 linux/amd64"))).toBeNull();
    expect(installedGo("1.27.4", () => ({ error: new Error("spawn go ENOENT") }))).toBeNull();
    expect(installedGo("1.27.4", run("", 1))).toBeNull();
  });

  test("Go runs with its caches in the checkout, its module files writable, and no toolchain of its own choosing", () => {
    expect(goEnv("/checkout/.go")).toEqual({
      GOPATH: "/checkout/.go/path",
      GOCACHE: "/checkout/.go/build",
      GOFLAGS: "-modcacherw",
      GOTOOLCHAIN: "local",
      CGO_ENABLED: "0",
    });
  });
});

describe("downloading the pinned toolchain", () => {
  /** An archive shaped like Go's: a `go/` directory with `bin/go` in it. */
  function fakeArchive() {
    const tree = join(dir, "tree");
    mkdirSync(join(tree, "go", "bin"), { recursive: true });
    writeFileSync(join(tree, "go", "bin", "go"), "#!/bin/sh\necho go version go9.9.9\n", {
      mode: 0o755,
    });
    const archive = join(dir, "go.tar.gz");
    expect(spawnSync("tar", ["-czf", archive, "-C", tree, "go"]).status).toBe(0);
    const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
    return { archive, sha256 };
  }

  test("is checked against its SHA-256, unpacked once and reused, and older toolchains go", async () => {
    const { archive, sha256 } = fakeArchive();
    const toolchain = { version: "9.9.9", archives: { "linux-amd64": { sha256, size: 1 } } };
    const cacheDir = join(dir, "cache");
    mkdirSync(join(cacheDir, "toolchains", "go1.20.0", "bin"), { recursive: true });
    const download = vi.fn(async (url, file) => copyFileSync(archive, file));
    const go = await pinnedGo({ cacheDir, toolchain, key: "linux-amd64", download });
    expect(go).toBe(join(cacheDir, "toolchains", "go9.9.9", "bin", "go"));
    expect(download).toHaveBeenCalledWith(
      "https://go.dev/dl/go9.9.9.linux-amd64.tar.gz",
      expect.any(String),
    );
    expect(spawnSync(go, [], { encoding: "utf8" }).stdout).toContain("go9.9.9");
    expect(existsSync(join(cacheDir, "toolchains", "go1.20.0"))).toBe(false);
    // The next build finds it where it was left.
    expect(await pinnedGo({ cacheDir, toolchain, key: "linux-amd64", download })).toBe(go);
    expect(download).toHaveBeenCalledTimes(1);
  });

  test("an archive whose digest does not match is never unpacked", async () => {
    const { archive } = fakeArchive();
    const toolchain = {
      version: "9.9.9",
      archives: { "linux-amd64": { sha256: "0".repeat(64), size: 1 } },
    };
    const cacheDir = join(dir, "cache");
    await expect(
      pinnedGo({
        cacheDir,
        toolchain,
        key: "linux-amd64",
        download: async (url, file) => copyFileSync(archive, file),
      }),
    ).rejects.toThrow(/does not match its published SHA-256/u);
    expect(existsSync(join(cacheDir, "toolchains", "go9.9.9"))).toBe(false);
  });

  test("a platform with no known archive says to install Go", async () => {
    await expect(
      pinnedGo({ cacheDir: join(dir, "cache"), toolchain: pinned, key: null }),
    ).rejects.toThrow(/install Go 1\.27\.4 or newer/u);
  });
});

describe("the build", () => {
  const build = (env, args = []) =>
    spawnSync(process.execPath, [join(root, "scripts/tailnet-helper/build.mjs"), ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });

  test("is skipped when asked, for builds that package the TypeScript alone", () => {
    const result = build({ OMNESIS_TAILNET_HELPER_BUILD: "0" }, ["--best-effort"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Skipping the Tailscale helper");
  });
});
