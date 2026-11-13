// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Side-effect module: load `$OMNESIS_CONFIG_DIR/.env` into `process.env`
 * before anything else evaluates. Imported FIRST by `main.ts` so the
 * module-scope `GATEWAY_URL` read (and any other import-time env reads) pick
 * up `OMNESIS_GATEWAY_URL` / `OMNESIS_TOKEN` from the file.
 */
import { loadDotEnv } from "@omnesis/config";

loadDotEnv();
if (typeof process.umask === "function") process.umask(0o077);

if (
  process.env.OMNESIS_CLOUD_RELAY_ENABLED === "1" &&
  !process.env.OMNESIS_GATEWAY_URL &&
  (process.env.OMNESIS_CLOUD_RELAY_DEVICE_FILE || !process.env.OMNESIS_TOKEN)
) {
  await (
    await import("@omnesis/cloud-relay/bootstrap")
  ).initializePairedDeviceTransport(process.env, {}, process.argv.slice(2), "collector");
}
