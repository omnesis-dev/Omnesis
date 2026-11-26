// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  lstat,
  chmod,
  symlink,
  rm,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import {
  packageEnvironment,
  ensureNativePackageCache,
  createPackageNpmConfigs,
} from "./native-package.mjs";

test("package processes use pinned Node and an isolated home without inherited account configuration", () => {
  const env = packageEnvironment({
    home: "/fixture/private-home",
    distribution: "/fixture/node",
    temporary: "/fixture/tmp",
    developerDirectory: "/fixture/Xcode/Contents/Developer",
  });
  expect(env).toEqual({
    HOME: "/fixture/private-home",
    PATH: "/fixture/node/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: "/fixture/tmp",
    LANG: "en_US.UTF-8",
    NPM_CONFIG_USERCONFIG: "/fixture/private-home/npm-user.npmrc",
    NPM_CONFIG_GLOBALCONFIG: "/fixture/private-home/npm-global.npmrc",
    DEVELOPER_DIR: "/fixture/Xcode/Contents/Developer",
  });
});

const posixTest = test.skipIf(process.platform === "win32");

async function scratchFixture() {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "omnesis-package-cache-")));
  await chmod(scratch, 0o700);
  await writeFile(join(scratch, ".omnesis-desktop-scratch"), "desktop-native-v1\n", {
    mode: 0o600,
  });
  return scratch;
}

posixTest(
  "the bridge's pre-created cache is reused without replacing identity or existing content",
  async () => {
    const scratch = await scratchFixture();
    try {
      const cache = join(scratch, "package-cache");
      await mkdir(cache, { mode: 0o700 });
      await writeFile(join(cache, "invented-cache-receipt"), "invented pinned cache content", {
        mode: 0o600,
      });
      const before = await lstat(cache, { bigint: true });
      expect(await ensureNativePackageCache(scratch)).toBe(cache);
      expect(await ensureNativePackageCache(scratch)).toBe(cache);
      const after = await lstat(cache, { bigint: true });
      expect([after.dev, after.ino, after.mode]).toEqual([before.dev, before.ino, before.mode]);
      expect(await readFile(join(cache, "invented-cache-receipt"), "utf8")).toBe(
        "invented pinned cache content",
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

posixTest("a missing cache is created privately in the marked owned scratch", async () => {
  const scratch = await scratchFixture();
  try {
    const cache = await ensureNativePackageCache(scratch);
    const info = await lstat(cache);
    expect(info.isDirectory()).toBe(true);
    expect(info.mode & 0o777).toBe(0o700);
    expect(info.uid).toBe(process.getuid());
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

posixTest.each(["file", "symlink", "public-directory"])(
  "cache conflict %s is refused without adoption or chmod",
  async (kind) => {
    const scratch = await scratchFixture();
    try {
      const cache = join(scratch, "package-cache");
      if (kind === "file") await writeFile(cache, "invented existing file", { mode: 0o600 });
      if (kind === "symlink") {
        const outside = join(scratch, "other-owned-directory");
        await mkdir(outside, { mode: 0o700 });
        await symlink(outside, cache);
      }
      if (kind === "public-directory") {
        await mkdir(cache, { mode: 0o700 });
        await chmod(cache, 0o755);
      }
      const before = await lstat(cache, { bigint: true });
      await expect(ensureNativePackageCache(scratch)).rejects.toThrow("private owned canonical");
      const after = await lstat(cache, { bigint: true });
      expect([after.dev, after.ino, after.mode]).toEqual([before.dev, before.ino, before.mode]);
      if (kind === "file") expect(await readFile(cache, "utf8")).toBe("invented existing file");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

posixTest("unclaimed or aliased scratch cannot create a package cache", async () => {
  const scratch = await scratchFixture();
  const alias = scratch + "-alias";
  try {
    await symlink(scratch, alias);
    await expect(ensureNativePackageCache(alias)).rejects.toThrow("private owned canonical");
    await rm(join(scratch, ".omnesis-desktop-scratch"));
    await expect(ensureNativePackageCache(scratch)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(scratch, "package-cache"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(alias, { force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

posixTest(
  "npm config layers are distinct empty exclusive private files in the attempt home",
  async () => {
    const home = await scratchFixture();
    try {
      const paths = await createPackageNpmConfigs(home);
      expect(paths.userConfig).not.toBe(paths.globalConfig);
      for (const path of Object.values(paths)) {
        expect(dirname(path)).toBe(home);
        expect(await readFile(path, "utf8")).toBe("");
        const info = await lstat(path);
        expect(info.isFile()).toBe(true);
        expect(info.nlink).toBe(1);
        expect(info.mode & 0o777).toBe(0o600);
        expect(info.uid).toBe(process.getuid());
      }
      await writeFile(paths.userConfig, "invented existing config", { flag: "w" });
      await expect(createPackageNpmConfigs(home)).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(paths.userConfig, "utf8")).toBe("invented existing config");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

posixTest.each(["absent", "bogus"])(
  "actual sibling npm config loader ignores %s launcher metadata without install or network",
  async (launcher) => {
    expect(Number(process.versions.node.split(".")[0])).toBe(24);
    vi.stubEnv("npm_execpath", launcher === "absent" ? undefined : "/example/not-npm-cli.js");
    // npm ships beside the distribution's Node executable.
    const npmCli = await realpath(join(dirname(process.execPath), "npm"));
    const home = await scratchFixture();
    try {
      const paths = await createPackageNpmConfigs(home);
      const temporary = join(home, "tmp");
      await mkdir(temporary, { mode: 0o700 });
      const env = packageEnvironment({
        home,
        temporary,
        distribution: resolve(dirname(process.execPath), ".."),
      });
      const output = execFileSync(
        process.execPath,
        [npmCli, "config", "get", "userconfig", "globalconfig", "--offline", "--ignore-scripts"],
        { cwd: home, env, encoding: "utf8", timeout: 10000 },
      );
      expect(output.trim().split(/\r?\n/)).toEqual([
        `userconfig=${paths.userConfig}`,
        `globalconfig=${paths.globalConfig}`,
      ]);
      expect(await readFile(paths.userConfig, "utf8")).toBe("");
      expect(await readFile(paths.globalConfig, "utf8")).toBe("");
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  },
);
