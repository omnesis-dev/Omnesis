// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createSecretStore,
  secretFileEncryptionRequired,
  storageEncryptionRequired,
} from "@omnesis/core";

/** No paths, keys or backend details cross this remote admission boundary. */
export interface GatewayStorageProtection {
  version: 1;
  atRest: "encrypted" | "unprotected" | "unavailable";
}

/** Capture once during startup; HTTP is exposed only after these keyed stores open. */
export async function captureGatewayStorageProtection(
  configDir: string,
  liveStoresEncrypted: boolean,
  dependencies = {
    keyringStatus: () => createSecretStore({ configDir }).status(),
    secretsRequired: () => secretFileEncryptionRequired(configDir),
    storesRequired: () => storageEncryptionRequired(configDir),
  },
): Promise<GatewayStorageProtection> {
  if (!liveStoresEncrypted) return { version: 1, atRest: "unprotected" };
  try {
    const keyring = await dependencies.keyringStatus();
    if (!keyring.available) return { version: 1, atRest: "unavailable" };
    return {
      version: 1,
      atRest:
        keyring.secure && dependencies.secretsRequired() && dependencies.storesRequired()
          ? "encrypted"
          : "unprotected",
    };
  } catch {
    return { version: 1, atRest: "unavailable" };
  }
}
