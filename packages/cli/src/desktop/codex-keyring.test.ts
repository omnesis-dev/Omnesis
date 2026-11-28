// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { codexKeyringAccount, codexPaths, CODEX_KEYRING_SERVICE } from "@omnesis/core";
import { desktopProfile } from "./environment.js";
import { purgeDesktopCodexKeyring } from "./codex-keyring.js";

describe("desktop Codex credential retirement", () => {
  const profile = desktopProfile(join(realpathSync(tmpdir()), "omnesis-codex-fixture"));
  test("deletes and verifies only the canonical owned account without reading secret values", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(44)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(44);
    await purgeDesktopCodexKeyring(profile, execute);
    const accounts = [
      codexKeyringAccount(codexPaths(profile.configDir, profile.instance).home),
      codexKeyringAccount(codexPaths(profile.configDir).home),
    ];
    expect(execute.mock.calls).toEqual(
      accounts.flatMap((account) => {
        const selector = ["-a", account, "-s", CODEX_KEYRING_SERVICE];
        return [
          [["delete-generic-password", ...selector]],
          [["find-generic-password", ...selector]],
        ];
      }),
    );
    expect(execute.mock.calls.flat(3)).not.toContain("-w");
  });
  test.each([[36], [0, 0], [0, 36], [44, 36]])(
    "refuses unverified cleanup %j",
    async (...codes: number[]) => {
      const execute = vi.fn();
      for (const code of codes) execute.mockResolvedValueOnce(code);
      await expect(purgeDesktopCodexKeyring(profile, execute)).rejects.toThrow(/Keychain/);
    },
  );
  test("a missing item still requires independent absence verification", async () => {
    const execute = vi.fn().mockResolvedValue(44);
    await purgeDesktopCodexKeyring(profile, execute);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  test("an aliased owned home never selects or deletes the target installation's account", async () => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), "omnesis-codex-alias-fixture-"));
    try {
      const owned = desktopProfile(root);
      const foreign = join(root, "other-codex-home");
      await mkdir(foreign);
      await writeFile(join(foreign, "keep.txt"), "unchanged fictional state");
      await mkdir(owned.configDir, { recursive: true });
      await symlink(
        foreign,
        codexPaths(owned.configDir).home,
        process.platform === "win32" ? "junction" : "dir",
      );
      const execute = vi.fn();
      await expect(purgeDesktopCodexKeyring(owned, execute)).rejects.toThrow(/alias/);
      expect(execute).not.toHaveBeenCalled();
      expect(await readFile(join(foreign, "keep.txt"), "utf8")).toBe("unchanged fictional state");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test.skipIf(process.platform === "win32")(
  "the default Keychain purge runner forwards actual inherited EX descriptor7 through its native adapter",
  async () => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), "omnesis-codex-authority-fixture-"));
    const profile = desktopProfile(root);
    await mkdir(`${profile.configDir}.bootstrap`, { recursive: true, mode: 0o700 });
    const lock = await open(
      join(`${profile.configDir}.bootstrap`, `.data-use-${profile.secretService.slice(-64)}.lock`),
      "wx+",
      0o600,
    );
    const stat = await lock.stat({ bigint: true });
    const operationId = "00000000-0000-4000-8000-000000000001";
    const scope = { format: 1, ...profile };
    const log = join(root, "observed");
    try {
      await writeFile(join(root, "package.json"), '{"type":"module"}');
      // Explicit OS fixture: validate the real descriptor and fixed native argv; never contact Keychain.
      await writeFile(
        join(root, "runtime-exec"),
        `#!${process.execPath}\nimport assert from 'node:assert/strict';import{fstatSync,appendFileSync}from'node:fs';
      const args=process.argv.slice(2);assert.deepEqual(args.slice(0,3),['--data-inherit','erase',${JSON.stringify(operationId)}]);
      assert.deepEqual(JSON.parse(Buffer.from(args[3],'base64url')),${JSON.stringify(scope)});
      assert.deepEqual(args.slice(4,6),['--external','/usr/bin/security']);
      assert.ok(['delete-generic-password','find-generic-password'].includes(args[6]));assert.ok(!args.includes('-w'));
      const stat=fstatSync(7,{bigint:true});assert.equal(stat.dev.toString(),${JSON.stringify(stat.dev.toString())});assert.equal(stat.ino.toString(),${JSON.stringify(stat.ino.toString())});
      appendFileSync(${JSON.stringify(log)},'descriptor-retained\\n');process.exit(44);`,
        { mode: 0o700 },
      );
      const module = new URL("./codex-keyring.ts", import.meta.url).href;
      const source = `const node=await import('@omnesis/core/node-command');
      node.installManagedRuntimeLauncher({root:${JSON.stringify(root)},launcher:${JSON.stringify(join(root, "runtime-exec"))},preload:${JSON.stringify(join(root, "packages/core/dist/managed-runtime-bootstrap.js"))},
      data:{format:1,scope:${JSON.stringify(scope)},lease:{device:${JSON.stringify(stat.dev.toString())},inode:${JSON.stringify(stat.ino.toString())}},exclusive:{purpose:'erase',operationId:${JSON.stringify(operationId)}}}});
      const {purgeDesktopCodexKeyring}=await import(${JSON.stringify(module)});await purgeDesktopCodexKeyring(${JSON.stringify(profile)});`;
      const preload = createRequire(import.meta.url).resolve("tsx/esm");
      const child = spawn(
        process.execPath,
        ["--import", pathToFileURL(preload).href, "--input-type=module", "-e", source],
        {
          env: { PATH: process.env.PATH, HOME: root },
          stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", lock.fd],
        },
      );
      const errors = child.stderr,
        output = child.stdout;
      if (!errors || !output) throw new Error("The fixture process has no output pipes");
      let stderr = "";
      errors.setEncoding("utf8");
      errors.on("data", (part) => {
        stderr += part;
      });
      output.resume();
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(exit, stderr).toBe(0);
      expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(4);
    } finally {
      await lock.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
