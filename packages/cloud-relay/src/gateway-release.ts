// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { ACCOUNT_BROWSER_PATH } from "./account-browser-contract.js";
import { GatewayUnregistered, type registerGatewayKey } from "./gateway-key-client.js";
import { relayOrigin } from "./network.js";

/**
 * A gateway its owner disconnected, kept until the relay has dropped it too: where its identity
 * and certificate are, so it can still prove to the relay that it is the one asking.
 */
export const gatewayReleaseSchema = z
  .object({
    version: z.literal(1),
    relayUrl: z.string().max(2048),
    gatewayId: z.string().uuid(),
    publicOrigin: z.string().max(2048),
    sessionFile: z.string().max(4096),
    ownerKeyFile: z.string().max(4096).optional(),
    certificateFile: z.string().max(4096),
    privateKeyFile: z.string().max(4096),
    createdAt: z.number().int().positive(),
  })
  .strict();
export type GatewayRelease = z.infer<typeof gatewayReleaseSchema>;

/** How long a disconnected gateway keeps asking a relay that never answers. */
export const GATEWAY_RELEASE_DAYS = 30;

/**
 * Asks the relay to remove this gateway from its account and drop its registration. Resolves once
 * the relay no longer has it, including when it had already forgotten it; rejects to be retried.
 */
export async function releaseGateway(
  record: GatewayRelease,
  options: { register: typeof registerGatewayKey; fetch?: typeof fetch; signal: AbortSignal },
): Promise<void> {
  let session;
  try {
    session = await options.register({
      relayUrl: record.relayUrl,
      gatewayId: record.gatewayId,
      publicOrigin: record.publicOrigin,
      sessionFile: record.sessionFile,
      ownerKeyFile: record.ownerKeyFile,
      certificateFile: record.certificateFile,
      privateKeyFile: record.privateKeyFile,
      fetch: options.fetch,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof GatewayUnregistered) return;
    throw error;
  }
  const response = await (options.fetch ?? fetch)(
    new URL(ACCOUNT_BROWSER_PATH + "/unlink", relayOrigin(record.relayUrl)),
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]),
      headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
      body: "{}",
    },
  );
  if (!response.ok) throw new Error("The relay did not release this gateway");
}
