// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { DEFAULT_CONFIG_DIR } from "@omnesis/core";
import { installationRelayUrl } from "./installation-relay.js";

/** Installed desktop application ID, independently released with Omnesis; absent until deployment is configured. */
export const DEFAULT_GOOGLE_DESKTOP_CLIENT_ID: string | undefined = undefined;
export class CloudClientSetupError extends Error {
  constructor(readonly code: "GOOGLE_DESKTOP_UNAVAILABLE" | "CLOUD_CLIENT_TOKEN_COLLISION") {
    super(
      code === "GOOGLE_DESKTOP_UNAVAILABLE"
        ? "Google sign-in is unavailable in this installation; ask its administrator to configure the desktop OAuth client, or use QR/manual pairing"
        : "An existing device credential would be replaced; use a separate OMNESIS_CONFIG_DIR for this pairing",
    );
  }
}
/** Pure local defaults: no discovery response can select an OAuth audience or a credential destination. */
export function cloudClientDefaults(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const configDir = env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
  if (!configDir.trim()) throw new Error("Client configuration directory is invalid");
  const kind = env.OMNESIS_CLOUD_RELAY_DEVICE_KIND ?? "cli";
  const base = join(configDir, "cloud-relay");
  return {
    ...env,
    OMNESIS_CONFIG_DIR: configDir,
    OMNESIS_CLOUD_RELAY_URL: env.OMNESIS_CLOUD_RELAY_URL ?? installationRelayUrl(env),
    OMNESIS_CLOUD_RELAY_SESSION_FILE:
      env.OMNESIS_CLOUD_RELAY_SESSION_FILE ?? join(base, "client-session.json"),
    OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE:
      env.OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE ?? join(base, "google-client.json"),
    OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_CLIENT_ID:
      env.OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_CLIENT_ID ?? DEFAULT_GOOGLE_DESKTOP_CLIENT_ID,
    OMNESIS_CLOUD_RELAY_DEVICE_KIND: kind,
    OMNESIS_CLOUD_RELAY_DEVICE_NAME:
      env.OMNESIS_CLOUD_RELAY_DEVICE_NAME ??
      (kind === "collector" ? "Omnesis collector" : "Omnesis CLI"),
    OMNESIS_CLOUD_RELAY_DEVICE_FILE:
      env.OMNESIS_CLOUD_RELAY_DEVICE_FILE ?? join(base, `${kind}-device.json`),
  };
}
export function requireGoogleDesktopClient(env: NodeJS.ProcessEnv): void {
  if (!env.OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_CLIENT_ID?.trim())
    throw new CloudClientSetupError("GOOGLE_DESKTOP_UNAVAILABLE");
}
