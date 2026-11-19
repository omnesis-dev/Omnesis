// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  atomicWriteFile,
  readSecretTextFile,
  writeSecretTextFile,
  secretFileScope,
} from "@omnesis/core";
import type { TlsPem } from "./service.js";

/** Renewal state that survives a restart, beside the material it describes. */
export interface LifecycleRecord {
  lastAttemptAt: string | null;
  lastError: string | null;
  lastRenewedAt: string | null;
  rotation: { previousFingerprintSha256: string; rotatedAt: string } | null;
}

const RECORD_FILE = "lifecycle.json";
const EMPTY_RECORD: LifecycleRecord = {
  lastAttemptAt: null,
  lastError: null,
  lastRenewedAt: null,
  rotation: null,
};

export async function readTlsPrivateKey(path: string, configDir: string): Promise<string> {
  const key = await readSecretTextFile(path, { configDir });
  if (key === null) throw new Error("The TLS private key is missing.");
  return key;
}

/** Each Windows leaf is protected before bytes; the lifecycle restores a failed pair. */
export async function writeTlsMaterial(
  certPath: string,
  keyPath: string,
  material: TlsPem,
  configDir: string,
): Promise<void> {
  if (process.platform === "win32") {
    await mkdir(dirname(certPath), { recursive: true, mode: 0o700 });
    await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
    await writeSecretTextFile(keyPath, material.key, { configDir });
    await atomicWriteFile(certPath, material.cert, { mode: 0o600 });
    return;
  }
  mkdirSync(dirname(certPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  const suffix = `.renew-${process.pid}`;
  const certTmp = `${certPath}${suffix}`;
  const keyTmp = `${keyPath}${suffix}`;
  try {
    writeFileSync(certTmp, material.cert, { mode: 0o600 });
    let previous: string | null = null;
    try {
      previous = readFileSync(keyPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeSecretTextFile(
      keyTmp,
      material.key,
      {
        configDir,
        scope: secretFileScope(keyPath, configDir),
      },
      previous,
    );
    renameSync(keyTmp, keyPath);
    renameSync(certTmp, certPath);
  } finally {
    rmSync(certTmp, { force: true });
    rmSync(keyTmp, { force: true });
  }
}

export function readLifecycleRecord(tlsDir: string): LifecycleRecord {
  const path = join(tlsDir, RECORD_FILE);
  if (!existsSync(path)) return { ...EMPTY_RECORD };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<LifecycleRecord>;
    return {
      lastAttemptAt: typeof raw.lastAttemptAt === "string" ? raw.lastAttemptAt : null,
      lastError: typeof raw.lastError === "string" ? raw.lastError : null,
      lastRenewedAt: typeof raw.lastRenewedAt === "string" ? raw.lastRenewedAt : null,
      rotation:
        raw.rotation &&
        typeof raw.rotation.previousFingerprintSha256 === "string" &&
        typeof raw.rotation.rotatedAt === "string"
          ? {
              previousFingerprintSha256: raw.rotation.previousFingerprintSha256,
              rotatedAt: raw.rotation.rotatedAt,
            }
          : null,
    };
  } catch {
    return { ...EMPTY_RECORD };
  }
}

export async function writeLifecycleRecord(tlsDir: string, record: LifecycleRecord): Promise<void> {
  const path = join(tlsDir, RECORD_FILE);
  const body = `${JSON.stringify(record, null, 2)}\n`;
  if (process.platform === "win32") {
    await atomicWriteFile(path, body, { mode: 0o600, ensureDir: true });
  } else {
    mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, path);
  }
}
