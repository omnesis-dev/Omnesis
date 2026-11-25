// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { codexKeyringAccount, codexPaths, CODEX_KEYRING_SERVICE } from "@omnesis/core";
import type { DesktopProfile } from "./environment.js";

const NOT_FOUND = 44;
type Run = (args: readonly string[]) => Promise<number>;
const run: Run = (args) =>
  new Promise((resolve, reject) => {
    execFile("/usr/bin/security", [...args], { timeout: 10_000, maxBuffer: 64 * 1024 }, (error) => {
      if (!error) resolve(0);
      else if (typeof error.code === "number") resolve(error.code);
      else
        reject(
          new Error("The desktop ChatGPT credential cleanup could not be checked.", {
            cause: error,
          }),
        );
    });
  });

/** No global enumeration and no secret reads: delete exactly this profile's account. */
export async function purgeDesktopCodexKeyring(
  profile: DesktopProfile,
  execute: Run = run,
): Promise<void> {
  const accounts = [
    ...new Set([
      codexKeyringAccount(codexPaths(profile.configDir, profile.instance).home),
      codexKeyringAccount(codexPaths(profile.configDir).home),
    ]),
  ];
  for (const account of accounts) {
    const selector = ["-a", account, "-s", CODEX_KEYRING_SERVICE];
    const deleted = await execute(["delete-generic-password", ...selector]);
    if (deleted !== 0 && deleted !== NOT_FOUND)
      throw new Error(
        "Keychain could not remove this app's ChatGPT sign-in. Unlock Keychain and retry cleanup.",
      );
    const remaining = await execute(["find-generic-password", ...selector]);
    if (remaining !== NOT_FOUND)
      throw new Error(
        "This app's ChatGPT sign-in could not be confirmed removed from Keychain. Retry cleanup.",
      );
  }
}
