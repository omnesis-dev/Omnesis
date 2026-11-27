// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHmac, randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function telemetryPeriod(now: Date): string {
  return now.toISOString().slice(0, 7);
}

export function installationId(secret: string, period: string): string {
  if (!/^[a-f0-9]{64}$/.test(secret) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    throw new Error("Invalid telemetry identity state");
  }
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`omnesis-telemetry:v1:${period}`)
    .digest("hex");
}

/** Dedicated random secret; neither pairing nor account state participates. */
export async function loadTelemetrySecret(configDir: string): Promise<string> {
  const path = join(configDir, "telemetry-secret-v1");
  try {
    await writeFile(path, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const secret = (await readFile(path, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("Invalid telemetry secret");
  await chmod(path, 0o600);
  return secret;
}
