// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { authorizeAccountDesktop, listAccountGateways } from "@omnesis/cloud-relay";
import type { DesktopEnrollmentUI, DesktopGatewayChoice } from "./enrollment.js";

export type DesktopHomes =
  { kind: "no-home" } | { kind: "homes"; homes: readonly DesktopGatewayChoice[] };

/**
 * Account sign-in discovers home computers without creating a gateway or device credential.
 * The discovery nonce cannot be reused for enrollment, which needs its own device-key binding.
 * An unavailable directory throws; only a validated empty response offers first-home setup.
 */
export async function discoverDesktopHomes(
  options: {
    relayUrl: string;
    name: string;
    signal: AbortSignal;
    ui: Pick<DesktopEnrollmentUI, "openBrowser" | "connectCode">;
  },
  dependencies: {
    authorize?: typeof authorizeAccountDesktop;
    list?: typeof listAccountGateways;
  } = {},
): Promise<DesktopHomes> {
  const relay = new URL(options.relayUrl);
  if (
    relay.protocol !== "https:" ||
    relay.username ||
    relay.password ||
    relay.search ||
    relay.hash ||
    relay.pathname !== "/"
  )
    throw new Error("Account discovery requires an HTTPS relay origin");
  options.signal.throwIfAborted();
  const authorization = await (dependencies.authorize ?? authorizeAccountDesktop)(
    {
      relayUrl: relay.origin,
      name: options.name,
      kind: "cli",
      nonce: randomBytes(32).toString("base64url"),
      signal: options.signal,
      onConnectCode: (code) => {
        options.signal.throwIfAborted();
        options.ui.connectCode(code);
      },
    },
    { openBrowser: (url) => options.ui.openBrowser(url, options.signal) },
  );
  options.signal.throwIfAborted();
  if (authorization.expiresAt * 1000 <= Date.now()) throw new Error("Account sign-in expired");
  const homes = await (dependencies.list ?? listAccountGateways)({
    relay,
    token: authorization.discoveryToken,
    signal: options.signal,
  });
  options.signal.throwIfAborted();
  if (authorization.expiresAt * 1000 <= Date.now()) throw new Error("Account sign-in expired");
  return homes.length === 0 ? { kind: "no-home" } : { kind: "homes", homes };
}
