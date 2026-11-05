// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstatSync, linkSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import {
  ensurePrivateDirSync,
  writeSecretTextFileSync,
  writeCollectorTokenFile,
  readTokenFile,
  readCollectorTokenFile,
  secretFileScope,
} from "@omnesis/core";
import { z } from "zod";
import {
  cloudClientDefaults,
  requireGoogleDesktopClient,
  CloudClientSetupError,
} from "./client-defaults.js";
import { publicGatewayCertificateFile, publicGatewayOrigin } from "./gateway-certificate.js";
import { authorizeGoogleDesktop } from "./google-desktop.js";
import {
  saveGoogleCredentials,
  exchangeRelayIdentity,
  readGoogleDesktopSecret,
  savePrivateJson,
} from "./google-credentials.js";
import { accountId } from "./identity.js";
import { gatewayBindingNonce } from "./gateway-binding.js";
import { relayOrigin } from "./network.js";
import { pairGoogleDevice } from "./google-device-pairing.js";

const environment = z.object({
  OMNESIS_CLOUD_RELAY_URL: z.string().min(1),
  OMNESIS_CLOUD_RELAY_SESSION_FILE: z.string().min(1),
  OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE: z.string().min(1),
  OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_CLIENT_ID: z.string().min(1).max(512).optional(),
  OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID: z.string().min(1).max(512).optional(),
  OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_SECRET_FILE: z.string().min(1).optional(),
});

/** Explicit interactive commands. No network or browser activity occurs merely by importing this module. */
export async function runGoogleRelayLogin(
  command: "google-login" | "register-gateway",
  env: NodeJS.ProcessEnv,
  dependencies: { authorize?: typeof authorizeGoogleDesktop; fetch?: typeof fetch } = {},
): Promise<void> {
  env = cloudClientDefaults(env);
  if (command === "google-login") requireGoogleDesktopClient(env);
  const config = environment.parse(env);
  const relay = relayOrigin(config.OMNESIS_CLOUD_RELAY_URL);
  const gateway =
    command === "register-gateway"
      ? {
          gatewayId: z.string().uuid().parse(env.OMNESIS_CLOUD_RELAY_GATEWAY_ID),
          publicOrigin: publicGatewayOrigin(env),
          certificate: new X509Certificate(
            await readFile(publicGatewayCertificateFile(env)),
          ).toString(),
        }
      : undefined;
  const clientId = z
    .string()
    .min(1)
    .parse(
      gateway
        ? config.OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID
        : config.OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_CLIENT_ID,
    );
  let clientSecret: string | undefined;
  if (config.OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_SECRET_FILE) {
    clientSecret = await readGoogleDesktopSecret(
      config.OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_SECRET_FILE,
      clientId,
    );
  }
  const credentials = await (dependencies.authorize ?? authorizeGoogleDesktop)({
    clientId,
    clientSecret,
    nonce: gateway ? gatewayBindingNonce(gateway) : randomBytes(32).toString("base64url"),
    offline: true,
  });
  const session = await exchangeRelayIdentity({
    relayUrl: relay.href,
    idToken: credentials.idToken,
    expectedAccountId: accountId(credentials.identity),
    sessionFile: config.OMNESIS_CLOUD_RELAY_SESSION_FILE,
    fetch: dependencies.fetch,
  });
  if (gateway) {
    const response = await (dependencies.fetch ?? fetch)(new URL("/_relay/v2/gateway", relay), {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...gateway, identityToken: credentials.idToken }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status !== 204)
      throw new Error("Gateway registration refused; check hostname ownership and certificate");
  }
  await saveGoogleCredentials(
    config.OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE,
    clientId,
    credentials,
  );
}

export async function confirmGatewayCode(
  value: { gatewayUrl: string; verificationCode: string },
  signal?: AbortSignal,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Google pairing requires an interactive terminal for key comparison");
  process.stdout.write(
    `Gateway: ${value.gatewayUrl}\nCompare ${value.verificationCode} on the gateway or an already paired device.\n`,
  );
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (
      (await terminal.question("Code shown on the trusted device: ", { signal }))
        .trim()
        .toUpperCase() === value.verificationCode
    );
  } finally {
    terminal.close();
  }
}

/** The saved device credential is usable with the pinned loopback adapter by CLI or collector. */
export async function runGoogleDevicePairing(
  env: NodeJS.ProcessEnv,
  dependencies: {
    pair?: typeof pairGoogleDevice;
    confirm?: typeof confirmGatewayCode;
  } = {},
): Promise<void> {
  env = cloudClientDefaults(env);
  requireGoogleDesktopClient(env);
  const config = z
    .object({
      OMNESIS_CLOUD_RELAY_URL: z.string().min(1),
      OMNESIS_CLOUD_RELAY_SESSION_FILE: z.string().min(1),
      OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_CLIENT_ID: z.string().min(1),
      OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_SECRET_FILE: z.string().min(1).optional(),
      OMNESIS_CLOUD_RELAY_DEVICE_FILE: z.string().min(1),
      OMNESIS_CLOUD_RELAY_DEVICE_KIND: z.enum(["cli", "collector"]),
      OMNESIS_CLOUD_RELAY_DEVICE_NAME: z.string().trim().min(1).max(80),
      OMNESIS_CONFIG_DIR: z.string().min(1),
    })
    .parse(env);
  const configDir = config.OMNESIS_CONFIG_DIR;
  const activeToken = () =>
    config.OMNESIS_CLOUD_RELAY_DEVICE_KIND === "cli"
      ? readTokenFile(configDir)
      : readCollectorTokenFile(configDir);
  const before = activeToken();
  if (
    config.OMNESIS_CLOUD_RELAY_DEVICE_KIND === "cli" &&
    lstatSync(join(configDir, "token"), { throwIfNoEntry: false })
  )
    throw new CloudClientSetupError("CLOUD_CLIENT_TOKEN_COLLISION");
  const unchanged = () => {
    if (activeToken() !== before) throw new CloudClientSetupError("CLOUD_CLIENT_TOKEN_COLLISION");
  };
  const clientSecret = config.OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_SECRET_FILE
    ? await readGoogleDesktopSecret(
        config.OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_SECRET_FILE,
        config.OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_CLIENT_ID,
      )
    : undefined;
  const result = await (dependencies.pair ?? pairGoogleDevice)({
    relayUrl: config.OMNESIS_CLOUD_RELAY_URL,
    sessionFile: config.OMNESIS_CLOUD_RELAY_SESSION_FILE,
    clientId: config.OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_CLIENT_ID,
    clientSecret,
    kind: config.OMNESIS_CLOUD_RELAY_DEVICE_KIND,
    name: config.OMNESIS_CLOUD_RELAY_DEVICE_NAME,
    confirm: dependencies.confirm ?? confirmGatewayCode,
  });
  unchanged();
  await savePrivateJson(config.OMNESIS_CLOUD_RELAY_DEVICE_FILE, result);
  unchanged();
  if (result.kind === "collector") writeCollectorTokenFile(result.token, configDir);
  else {
    publishCliToken(result.token, configDir);
  }
}

/** Publish a fresh CLI credential without replacing a file created by another process. */
function publishCliToken(token: string, configDir: string): void {
  ensurePrivateDirSync(configDir);
  const target = join(configDir, "token");
  const staged = join(configDir, `.cloud-client-token-${randomUUID()}`);
  try {
    writeSecretTextFileSync(staged, token + "\n", {
      configDir,
      scope: secretFileScope(target, configDir),
    });
    try {
      linkSync(staged, target);
    } catch {
      // The original filesystem error can contain private paths; a failed exclusive publication never falls back to replacement.
      throw new CloudClientSetupError("CLOUD_CLIENT_TOKEN_COLLISION");
    }
  } finally {
    rmSync(staged, { force: true });
  }
}
