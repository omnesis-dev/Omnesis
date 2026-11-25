// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
