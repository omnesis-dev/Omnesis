// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  assertNoManagedCodexAuthFile,
  buildCodexEnv,
  managedCodexArgs,
  managedCodexAuth,
  removeManagedCodexPoolAuth,
  type CodexRuntimeCommandInfo,
} from "@omnesis/agent";
import {
  CODEX_KEYRING_SERVICE,
  codexKeyringAccount,
  confirmMacosKeychainEntriesAbsent,
  createLogger,
  execWindowsJob,
  nodeCommandInvocation,
} from "@omnesis/core";

const execute = promisify(execFile);
const log = createLogger("gateway:models:codex:auth");

/** Runs under the lifecycle owner's admission/drain boundary. */
export async function clearCodexAuthentication(options: {
  env: NodeJS.ProcessEnv;
  home: string;
  legacyHome?: string;
  poolHome?: string;
  cliArgsPrefix: readonly string[];
  timeoutMs: number;
  command(): Promise<CodexRuntimeCommandInfo>;
  assertActive(): void;
  assertCleanup(): void;
  holdCleanup(error: unknown): void;
}): Promise<void> {
  const managed = managedCodexAuth(options.env);
  const homes = managed
    ? [...new Set([options.home, ...(options.legacyHome ? [options.legacyHome] : [])])]
    : [options.home];
  if (managed) {
    for (const home of homes) codexKeyringAccount(home);
    if (options.poolHome) codexKeyringAccount(options.poolHome);
  }
  try {
    const command = await options.command();
    for (const home of homes) {
      options.assertActive();
      const invocation = nodeCommandInvocation(
        command.command,
        managedCodexArgs(options.env, [...options.cliArgsPrefix, "logout"], home),
      );
      await (process.platform === "win32" ? execWindowsJob : execute)(
        invocation.command,
        invocation.args,
        { env: buildCodexEnv(options.env, home), timeout: options.timeoutMs, windowsHide: true },
      );
    }
  } catch (error) {
    if (error && typeof error === "object" && "cleanupFailure" in error) {
      options.holdCleanup(error);
      throw error;
    }
    options.assertActive();
    if (managed) throw error;
    log.warn(`Codex logout command failed; removing the owned local auth file`);
  }
  options.assertCleanup();
  if (
    managed &&
    !(await confirmMacosKeychainEntriesAbsent(homes.map(codexKeyringAccount), {
      backend: "macos-keychain",
      service: CODEX_KEYRING_SERVICE,
    }))
  )
    throw new Error(
      "This app’s ChatGPT sign-in remains in Keychain. Unlock Keychain and retry sign-out.",
    );
  options.assertCleanup();
  for (const home of homes) await rm(join(home, "auth.json"), { force: true });
  if (managed) {
    if (options.poolHome) await removeManagedCodexPoolAuth(options.poolHome);
    await assertNoManagedCodexAuthFile(options.env, homes);
  }
}
