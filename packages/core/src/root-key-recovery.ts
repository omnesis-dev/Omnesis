// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  defaultSecretCommandRunner,
  inspectInstallRootKey,
  isInstallRootKey,
  OMNESIS_INSTALL_ROOT_KEY,
  readInstallRootKey,
  type CreateSecretStoreOptions,
} from "./secret-store.js";

/**
 * Restore an already recovered key into an explicitly selected macOS namespace.
 * Unlike a read-then-update, Keychain insertion without -U cannot overwrite an
 * item created concurrently. Existing general secret-store writes are unchanged.
 */
export async function restoreInstallRootKeyIfAbsent(
  value: string,
  options: CreateSecretStoreOptions & { service: string; configDir: string },
): Promise<void> {
  if (!isInstallRootKey(value)) throw new Error("The recovered root key has an invalid format.");
  if (
    options.backend !== "macos-keychain" ||
    (options.platform ?? process.platform) !== "darwin" ||
    typeof options.service !== "string" ||
    typeof options.configDir !== "string" ||
    options.configDir.length === 0 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{1,255}$/u.test(options.service)
  )
    throw new Error("Recovery requires an explicit macOS Keychain namespace.");
  const state = await inspectInstallRootKey(options);
  if (!state.store.available || !state.store.secure || state.store.backend !== "macos-keychain")
    throw new Error("Unlock the macOS Keychain before restoring recovery protection.");
  if (state.present)
    throw new Error("A root key already exists. Recovery will not replace an existing key.");
  const run = options.runCommand ?? defaultSecretCommandRunner;
  // /usr/bin/security preserves the existing reader ACL. Do not add -U: even
  // malformed or concurrently inserted entries must remain untouched.
  const result = await run("/usr/bin/security", [
    "add-generic-password",
    "-a",
    OMNESIS_INSTALL_ROOT_KEY,
    "-s",
    options.service,
    "-l",
    `Omnesis ${OMNESIS_INSTALL_ROOT_KEY}`,
    "-w",
    value,
  ]);
  if (result.code !== 0)
    throw new Error(
      "Keychain refused recovery. Unlock your Mac and retry; an existing key will never be replaced.",
    );
  if ((await readInstallRootKey(options)) !== value)
    throw new Error(
      "The recovered key could not be confirmed in Keychain. Keep your recovery files.",
    );
}
