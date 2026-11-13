// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync } from "node:fs";
import { cloudRelayEnabled } from "@omnesis/core";

/** Start only for explicitly configured paired native components, before URL constants freeze. */
export async function initializePairedDeviceTransport(
  env: NodeJS.ProcessEnv,
  dependencies: {
    start?: (
      env: NodeJS.ProcessEnv,
    ) => Promise<{ url: string; gatewayUrl: string; close(): Promise<void> }>;
    onExit?: (close: () => void) => void;
    findDefault?: typeof defaultCloudDeviceFile;
  } = {},
  args: readonly string[] = [],
  component: "cli" | "collector" = "cli",
): Promise<void> {
  const terminator = args.indexOf("--");
  if (
    args
      .slice(0, terminator < 0 ? undefined : terminator)
      .some((value) => ["--help", "-h", "--version", "-V"].includes(value)) ||
    args[0] === "help"
  )
    return;
  if (!cloudRelayEnabled(env) || env.OMNESIS_GATEWAY_URL || env.OMNESIS_GATEWAY_REQUEST_URL) return;
  const deviceFile =
    env.OMNESIS_CLOUD_RELAY_DEVICE_FILE ??
    (await (dependencies.findDefault ?? defaultCloudDeviceFile)(env, component));
  if (!deviceFile) return;
  const transport = await (dependencies.start ?? start)({
    ...env,
    OMNESIS_CLOUD_RELAY_DEVICE_FILE: deviceFile,
    OMNESIS_CLOUD_RELAY_CLIENT_PORT: "0",
    OMNESIS_CLOUD_RELAY_CLIENT_UNREF: "1",
  });
  env.OMNESIS_CLOUD_RELAY_DEVICE_FILE = deviceFile;
  env.OMNESIS_GATEWAY_URL = transport.gatewayUrl;
  env.OMNESIS_GATEWAY_REQUEST_URL = transport.url;
  (dependencies.onExit ?? onExit)(() => {
    void transport.close().catch(() => {});
  });
}
async function start(
  env: NodeJS.ProcessEnv,
): Promise<{ url: string; gatewayUrl: string; close(): Promise<void> }> {
  const { runRelayCommand } = await import("./runtime.js");
  const transport = await runRelayCommand("client", env);
  if (!transport?.gatewayUrl) {
    await transport?.close();
    throw new Error("Paired gateway transport did not start");
  }
  return { ...transport, gatewayUrl: transport.gatewayUrl };
}
function onExit(close: () => void): void {
  process.once("beforeExit", close);
}

/** The paired transport's endpoint. The variable means nothing without the cloud relay opt-in. */
export function pairedGatewayRequestUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return cloudRelayEnabled(env) ? env.OMNESIS_GATEWAY_REQUEST_URL : undefined;
}

/** Internal transport endpoints never become the logical gateway identity or a portal URL. */
export function pairedLogicalGatewayUrl(url: string, env: NodeJS.ProcessEnv = process.env): string {
  return url === pairedGatewayRequestUrl(env) && env.OMNESIS_GATEWAY_URL
    ? env.OMNESIS_GATEWAY_URL
    : url;
}

/** Existing manual authority supersedes a stale automatic bundle; explicit advanced bundle paths keep their existing behavior. */
export async function defaultCloudDeviceFile(
  env: NodeJS.ProcessEnv,
  component: "cli" | "collector",
): Promise<string | undefined> {
  if (
    !cloudRelayEnabled(env) ||
    env.OMNESIS_GATEWAY_URL ||
    env.OMNESIS_GATEWAY_REQUEST_URL ||
    env.OMNESIS_TOKEN
  )
    return undefined;
  const { cloudClientDefaults } = await import("./client-defaults.js");
  const config = cloudClientDefaults({ ...env, OMNESIS_CLOUD_RELAY_DEVICE_KIND: component });
  const path = config.OMNESIS_CLOUD_RELAY_DEVICE_FILE!;
  if (!existsSync(path)) return undefined;
  const { readTokenFile, readCollectorTokenFile } = await import("@omnesis/core");
  const token =
    component === "cli"
      ? readTokenFile(config.OMNESIS_CONFIG_DIR)
      : readCollectorTokenFile(config.OMNESIS_CONFIG_DIR);
  if (!token) return undefined;
  const { readPrivateJson } = await import("./google-credentials.js");
  const saved = await readPrivateJson(path);
  return saved &&
    typeof saved === "object" &&
    "kind" in saved &&
    saved.kind === component &&
    "token" in saved &&
    saved.token === token
    ? path
    : undefined;
}
