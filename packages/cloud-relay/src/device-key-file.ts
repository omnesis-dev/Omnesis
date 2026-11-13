// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { KeyObject } from "node:crypto";

export interface DeviceKey {
  publicKey: string;
  privateKey: KeyObject;
}

function toDeviceKey(privateKey: KeyObject): DeviceKey {
  return {
    privateKey,
    publicKey: createPublicKey(privateKey)
      .export({ type: "spki", format: "der" })
      .toString("base64url"),
  };
}

/** One P-256 key per client install. A desktop has no secure element, so this is a private file. */
export async function readOrCreateDeviceKey(path: string): Promise<DeviceKey> {
  try {
    return toDeviceKey(createPrivateKey(await readFile(path, "utf8")));
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw new Error("The saved device key could not be read", { cause: error });
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  // Write the key in full under a private name first: a racing process must never read a
  // half-written file, and link() publishes it only if no other key got there first.
  const staged = `${path}.${randomUUID()}.tmp`;
  const file = await open(staged, "wx", 0o600);
  try {
    await file.writeFile(privateKey.export({ type: "pkcs8", format: "pem" }));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(staged, path);
  } catch (error) {
    // Another process won the race, so its key is the install's key.
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
      throw error;
    return toDeviceKey(createPrivateKey(await readFile(path, "utf8")));
  } finally {
    await unlink(staged);
  }
  return toDeviceKey(privateKey);
}
