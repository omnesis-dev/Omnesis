// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Side-effect module: load `$OMNESIS_CONFIG_DIR/.env` into `process.env`
 * before anything else evaluates. Imported FIRST by `index.ts` — ahead of
 * `./utils.js`, which freezes `GATEWAY_URL` from `process.env` at import — so
 * a `.env`-provided `OMNESIS_GATEWAY_URL` / `OMNESIS_TOKEN` is honoured.
 */
import {
  DotEnvBootstrapError,
  loadBootstrapDotEnv,
  repairBootstrapDotEnvAccess,
} from "@omnesis/config/dotenv-bootstrap";
import { bootstrapCliGatewayTransport } from "./trust-preflight.js";

try {
  loadBootstrapDotEnv();
} catch (error) {
  const args = process.argv.slice(2);
  if (
    process.platform !== "win32" ||
    !(error instanceof DotEnvBootstrapError) ||
    args.length !== 2 ||
    args[0] !== "doctor" ||
    args[1] !== "--fix-permissions"
  ) {
    throw error;
  }
  // Bootstrap cannot trust even the variables needed to load the normal CLI.
  // This exact local repair path changes metadata and always ends this process.
  try {
    repairBootstrapDotEnvAccess(error);
  } catch {
    console.error(
      `Windows bootstrap permissions could not be repaired for ${error.path}. Review its ownership and access controls manually, then rerun doctor --fix-permissions. No .env contents were loaded.`,
    );
    process.exit(2);
  }
  console.error(
    `Repaired Windows access controls for the config directory and ${error.path}. Review the file, then rerun doctor --fix-permissions. No .env contents were loaded.`,
  );
  process.exit(2);
}
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
