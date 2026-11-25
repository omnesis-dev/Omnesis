// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import {
  OMNESIS_SECRET_SERVICE,
  parseSecretStoreBackend,
  readInstallRootKey,
  resolveSecretStoreService,
  type SecretFileOptions,
} from "@omnesis/core";
import { directCandidateSchema } from "./direct-path.js";
import { readPrivateJson, savePrivateJson } from "./google-credentials.js";
import { withPairedDeviceFileLock } from "./paired-device-lock.js";
import type { CloudDevicePairing } from "./device-pairing.js";

export const pairedDeviceSchema = z
  .object({
    gatewayUrl: z.string().min(1).max(2048),
    gatewayFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    gatewayCertificate: z.string().min(1).max(16_384),
    tlsSpkiFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    directCandidates: z.array(directCandidateSchema).max(8).optional(),
    token: z.string().regex(/^[A-Za-z0-9._~-]{1,4096}$/),
    deviceId: z.string().uuid(),
    kind: z.enum(["cli", "collector"]),
    scopes: z.array(z.string().min(1).max(128)).max(128),
  })
  .strict();

/** Resolve from the supplied child environment, never from another install's ambient selectors. */
export function pairedDeviceSecretOptions(env: NodeJS.ProcessEnv): SecretFileOptions | undefined {
  if (!env.OMNESIS_CONFIG_DIR) {
    if (env.OMNESIS_SECRET_SERVICE)
      throw new Error("A scoped pairing requires its configuration directory");
    return undefined;
  }
  return {
    configDir: env.OMNESIS_CONFIG_DIR,
    backend: parseSecretStoreBackend(env.OMNESIS_SECRET_STORE),
    service: resolveSecretStoreService(env.OMNESIS_SECRET_SERVICE ?? OMNESIS_SECRET_SERVICE),
  };
}

/** Certificate/leaf-binding verification still belongs to the transport before credentials are sent. */
export async function readPairedDeviceFile(
  path: string,
  options?: SecretFileOptions,
): Promise<CloudDevicePairing> {
  return pairedDeviceSchema.parse(await readPrivateJson(path, options));
}

/** A managed app credential must never be published with the legacy plaintext fallback. */
export async function savePairedDeviceFile(
  path: string,
  value: CloudDevicePairing,
  options: SecretFileOptions,
): Promise<void> {
  const parsed = pairedDeviceSchema.parse(value);
  await withPairedDeviceFileLock(path, async () => {
    if (!(await readInstallRootKey(options)))
      throw new Error("The pairing credential requires an unlocked installation key");
    await savePrivateJson(path, parsed, options);
  });
}
