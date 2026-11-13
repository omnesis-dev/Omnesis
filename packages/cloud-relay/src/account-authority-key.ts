// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { constants } from "node:fs";
import { mkdir, open, link, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createPrivateKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { atomicWriteFile } from "@omnesis/core";
import { AccountEnrollmentAuthority } from "./account-enrollment-proof.js";

/** The account attestation key is independent of gateway keys and of the relay session root. */
export async function loadAccountEnrollmentAuthority(
  origin: string,
  path: string,
): Promise<AccountEnrollmentAuthority> {
  let material: string;
  try {
    material = await readKey(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const key = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
    try {
      await atomicWriteFile(temporary, key, { mode: 0o600 });
      try {
        await link(temporary, path);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
    material = await readKey(path);
  }
  return new AccountEnrollmentAuthority(origin, createPrivateKey(material));
}

async function readKey(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 16_384 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Account authority key must be a private regular file");
    const bytes = Buffer.alloc(16_385);
    const result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > 16_384) throw new Error("Account authority key is too large");
    return bytes.subarray(0, result.bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
