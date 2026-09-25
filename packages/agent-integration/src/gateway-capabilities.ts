// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the gateway on the other end can actually do.
 *
 * `GET /health` is public because a harness has to ask before it holds any
 * token — the CLI reads it before it redeems a one-time pairing code, and the
 * installed plugin reads it again on every start. Both need the same two
 * facts, so both read them through here.
 */

import { PinnedGatewayHttpClient } from "./http.js";
import type { TlsTrust } from "./tls.js";

export interface GatewayCapabilities {
  /** Product version, for the drift warning. Absent on a gateway too old to say. */
  version?: string;
  /** Whether Watch management and Watch-reaction delivery are available. */
  subscriptions: boolean;
  /** Privacy-policy contract revision the Watch surfaces speak. */
  watchPrivacyPolicy?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Interpret one `/health` body.
 *
 * Throws rather than guessing when the body is not an Omnesis health
 * response. Something else answering on that URL — a proxy, a captive portal,
 * a load balancer's own error page — must not be read as "this gateway has no
 * capabilities", because a caller would persist that and quietly drop the
 * tools it decides by. Not being able to tell and being told "no" are
 * different answers, and only one of them is safe to act on.
 */
export function parseGatewayCapabilities(health: unknown): GatewayCapabilities {
  if (!isPlainObject(health) || typeof health.status !== "string") {
    throw new Error("the gateway did not return an Omnesis health response");
  }
  const capabilities = isPlainObject(health.capabilities) ? health.capabilities : null;
  const compat = isPlainObject(health.compat) ? health.compat : null;
  return {
    ...(typeof health.version === "string" ? { version: health.version } : {}),
    // A gateway that predates the capability names no capabilities at all. On
    // one of those, experimental mode was the whole gate, so it is the honest
    // answer to the same question.
    subscriptions: capabilities
      ? capabilities.subscriptions === true
      : health.experimental === true,
    ...(typeof compat?.watchPrivacyPolicy === "number"
      ? { watchPrivacyPolicy: compat.watchPrivacyPolicy }
      : {}),
  };
}

export async function readGatewayCapabilities(
  gatewayUrl: string,
  tls?: TlsTrust,
  timeoutMs?: number,
): Promise<GatewayCapabilities> {
  const health = await new PinnedGatewayHttpClient(gatewayUrl, "", tls).requestJson(
    "GET",
    "/health",
    undefined,
    undefined,
    timeoutMs === undefined ? undefined : { timeoutMs },
  );
  return parseGatewayCapabilities(health);
}
