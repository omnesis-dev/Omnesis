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
import { bindingOrigin, gatewayBindingNonce } from "./gateway-binding.js";
import { relayOrigin } from "./network.js";
import { pairAccountDevice } from "./account-device-pairing.js";
import { pairGoogleDevice } from "./google-device-pairing.js";
import { formatPairingCode } from "./device-enrollment.js";

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
    throw new Error("Device pairing requires an interactive terminal for key comparison");
  process.stdout.write(
    `Gateway: ${value.gatewayUrl}\nCompare ${value.verificationCode} on the gateway or an already paired device.\n`,
  );
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (
      formatPairingCode(
        await terminal.question("Code shown on the trusted device: ", { signal }),
      ) === value.verificationCode
    );
  } finally {
    terminal.close();
  }
}

type PairingCommandDependencies = {
  pair?: (
    options: Parameters<typeof pairGoogleDevice>[0] & {
      selectGateway: typeof chooseGateway;
      deviceKeyFile: string;
      onConnectCode(value: { connectUrl: string; connectShortUrl?: string; code: string }): void;
      awaitApproval(value: { gatewayUrl: string; verificationCode: string }): void;
    },
  ) => ReturnType<typeof pairGoogleDevice>;
  confirm?: typeof confirmGatewayCode;
  selectGateway?: typeof chooseGateway;
};
/** Account browser sign-in supports Google and passkeys without installing an OAuth desktop secret. */
export async function runAccountDevicePairing(
  env: NodeJS.ProcessEnv,
  dependencies: {
    pair?: typeof pairAccountDevice;
    confirm?: typeof confirmGatewayCode;
    selectGateway?: typeof chooseGateway;
  } = {},
): Promise<void> {
  return runDevicePairing(
    env,
    { ...dependencies, pair: dependencies.pair ?? pairAccountDevice },
    true,
  );
}
/** Legacy Google-only enrollment remains available to installations using the earlier directory. */
export async function runGoogleDevicePairing(
  env: NodeJS.ProcessEnv,
  dependencies: PairingCommandDependencies = {},
): Promise<void> {
  return runDevicePairing(env, dependencies, false);
}
async function runDevicePairing(
  env: NodeJS.ProcessEnv,
  dependencies: PairingCommandDependencies,
  account: boolean,
): Promise<void> {
  env = cloudClientDefaults(env);
  if (!account) requireGoogleDesktopClient(env);
  const config = z
    .object({
      OMNESIS_CLOUD_RELAY_URL: z.string().min(1),
      OMNESIS_CLOUD_RELAY_SESSION_FILE: z.string().min(1),
      OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_CLIENT_ID: z.string().min(1).optional(),
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
  const clientSecret =
    !account && config.OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_SECRET_FILE
      ? await readGoogleDesktopSecret(
          config.OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_SECRET_FILE,
          config.OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_CLIENT_ID!,
        )
      : undefined;
  const result = await (dependencies.pair ?? pairGoogleDevice)({
    relayUrl: config.OMNESIS_CLOUD_RELAY_URL,
    sessionFile: config.OMNESIS_CLOUD_RELAY_SESSION_FILE,
    clientId: config.OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_CLIENT_ID ?? "",
    clientSecret,
    kind: config.OMNESIS_CLOUD_RELAY_DEVICE_KIND,
    name: config.OMNESIS_CLOUD_RELAY_DEVICE_NAME,
    deviceKeyFile: `${config.OMNESIS_CLOUD_RELAY_DEVICE_FILE}.key`,
    onConnectCode: ({ connectUrl, connectShortUrl, code }) =>
      process.stderr.write(
        `Sign in to your Omnesis account to connect this ${config.OMNESIS_CLOUD_RELAY_DEVICE_KIND}. If no browser opens, visit ${connectShortUrl ?? connectUrl} on any device and enter ${code}\n` +
          `Signing in on another device needs your approval on your phone or another paired device; this ${config.OMNESIS_CLOUD_RELAY_DEVICE_KIND} then shows a code to check there, and continues once you approve.\n`,
      ),
    confirm: dependencies.confirm ?? confirmGatewayCode,
    awaitApproval: ({ gatewayUrl, verificationCode }) =>
      process.stderr.write(
        `Gateway: ${gatewayUrl}\n` +
          `Approve this ${config.OMNESIS_CLOUD_RELAY_DEVICE_KIND} on your phone or another paired device, under Devices → Pairing requests. Check that it shows this code: ${verificationCode}\n` +
          `Waiting for approval…\n`,
      ),
    selectGateway:
      dependencies.selectGateway ??
      ((choices, signal) =>
        chooseGateway(choices, signal, env.OMNESIS_CLOUD_RELAY_TARGET_GATEWAY_ID)),
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
export function publishCliToken(token: string, configDir: string): void {
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

/** An explicit target supports unattended enrollment without choosing an arbitrary account gateway. */
export async function chooseGateway(
  choices: readonly import("./gateway-directory.js").GatewayChoice[],
  signal: AbortSignal,
  target?: string,
): Promise<string> {
  signal.throwIfAborted();
  if (target !== undefined) {
    if (!choices.some((choice) => choice.gatewayId === target))
      throw new Error("Configured gateway is not connected to your Omnesis account");
    return target;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Choose a gateway interactively or set OMNESIS_CLOUD_RELAY_TARGET_GATEWAY_ID");
  process.stdout.write(
    "Choose the gateway to pair with:\n" +
      choices
        .map(
          (choice, index) =>
            `${index + 1}. ${(choice.displayName ?? new URL(choice.publicOrigin).hostname).replace(/[\p{Cc}\p{Cf}]/gu, " ")} — ${bindingOrigin(choice.publicOrigin).origin}`,
        )
        .join("\n") +
      "\n",
  );
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await terminal.question("Gateway number: ", { signal })).trim();
    const selected = /^[1-9][0-9]*$/.test(answer) ? choices[Number(answer) - 1] : undefined;
    if (!selected) throw new Error("Choose one of the listed gateways");
    return selected.gatewayId;
  } finally {
    terminal.close();
  }
}
