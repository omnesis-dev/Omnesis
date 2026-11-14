// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { readWindowsPrivateFile, writeWindowsPrivateFileAtomicStream } from "@omnesis/core";
import type { KeyObject } from "node:crypto";

export interface DeviceKey {
  publicKey: string;
  privateKey: KeyObject;
}

async function readDeviceKey(path: string): Promise<KeyObject> {
  return createPrivateKey(
    process.platform === "win32"
      ? await readWindowsPrivateFile(path, 65_536)
      : await readFile(path, "utf8"),
  );
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
    return toDeviceKey(await readDeviceKey(path));
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw new Error("The saved device key could not be read", { cause: error });
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const material = privateKey.export({ type: "pkcs8", format: "pem" });
  if (process.platform === "win32") {
    const bytes = Buffer.from(material);
    try {
      await writeWindowsPrivateFileAtomicStream(path, Readable.from([bytes]), bytes.byteLength, {
        replaceExisting: false,
        timeoutMs: 30_000,
      });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
        throw error;
    }
    return toDeviceKey(await readDeviceKey(path));
  }
  // Write the key in full under a private name first: a racing process must never read a
  // half-written file, and link() publishes it only if no other key got there first.
  const staged = `${path}.${randomUUID()}.tmp`;
  let stagedCreated = false;
  try {
    const file = await open(staged, "wx", 0o600);
    stagedCreated = true;
    try {
      await file.writeFile(material);
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
      return toDeviceKey(await readDeviceKey(path));
    }
  } finally {
    if (stagedCreated) await rm(staged, { force: true });
  }
  return toDeviceKey(privateKey);
}
