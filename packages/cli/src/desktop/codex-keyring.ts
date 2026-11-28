// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  codexKeyringAccount,
  codexPaths,
  CODEX_KEYRING_SERVICE,
  spawnOwnedChildProcess,
} from "@omnesis/core";
import type { DesktopProfile } from "./environment.js";

const NOT_FOUND = 44;
type Run = (args: readonly string[]) => Promise<number>;
/** Security is a real data consumer: retain inherited EX ownership until its physical close. */
export const runDesktopCodexKeyringCommand: Run = async (args) => {
  const owner = spawnOwnedChildProcess("/usr/bin/security", args, { env: process.env });
  let exceeded = false;
  let bytes = 0;
  const stop = () => {
    exceeded = true;
    void owner.stop().catch(() => {});
  };
  const timer = setTimeout(stop, 10_000);
  timer.unref();
  for (const stream of [owner.child.stdout, owner.child.stderr])
    stream?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) stop();
    });
  owner.child.stdin?.end();
  try {
    await owner.ready;
    await owner.joined;
    if (exceeded) {
      await owner.stop();
      throw new Error("The desktop ChatGPT credential cleanup exceeded its bounded check.");
    }
    if (typeof owner.child.exitCode !== "number")
      throw new Error("The desktop ChatGPT credential cleanup could not be checked.");
    return owner.child.exitCode;
  } catch (error) {
    await owner.stop();
    throw new Error("The desktop ChatGPT credential cleanup could not be checked.", {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
};

/** No global enumeration and no secret reads: delete exactly this profile's account. */
export async function purgeDesktopCodexKeyring(
  profile: DesktopProfile,
  execute: Run = runDesktopCodexKeyringCommand,
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
