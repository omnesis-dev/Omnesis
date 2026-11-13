// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Side-effect module: load `$OMNESIS_CONFIG_DIR/.env` into `process.env`
 * before anything else evaluates. Imported FIRST by `index.ts` — ahead of
 * `./utils.js`, which freezes `GATEWAY_URL` from `process.env` at import — so
 * a `.env`-provided `OMNESIS_GATEWAY_URL` / `OMNESIS_TOKEN` is honoured.
 */
import { loadDotEnv } from "@omnesis/config";
import { bootstrapCliGatewayTransport } from "./trust-preflight.js";

loadDotEnv();
if (typeof process.umask === "function") process.umask(0o077);

if (
  process.env.OMNESIS_CLOUD_RELAY_ENABLED === "1" &&
  !process.env.OMNESIS_GATEWAY_URL &&
  (process.env.OMNESIS_CLOUD_RELAY_DEVICE_FILE || !process.env.OMNESIS_TOKEN)
) {
  await bootstrapCliGatewayTransport(process.argv.slice(2), async () => {
    await (
      await import("@omnesis/cloud-relay/bootstrap")
    ).initializePairedDeviceTransport(process.env, {}, process.argv.slice(2));
  });
}
