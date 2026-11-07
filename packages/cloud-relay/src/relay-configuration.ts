// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { readBoundedJson } from "./google-credentials.js";
import { bindingOrigin } from "./gateway-binding.js";
import { relayOrigin } from "./network.js";

const configurationSchema = z
  .object({
    protocol: z.literal(2),
    gatewayId: z.string().uuid(),
    publicOrigin: z.string().max(2048).optional(),
    managedDomain: z.string().max(253).optional(),
    invitationRequired: z.boolean(),
    dnsChallenges: z.boolean(),
  })
  .strict();
export type RelayPublicConfiguration = z.infer<typeof configurationSchema>;

/** Only bounded public routing metadata is requested; no identity key, invitation or account token leaves preparation. */
export async function relayPublicConfiguration(
  url: string,
  gatewayId: string,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<RelayPublicConfiguration> {
  const target = new URL("/_relay/v2/config", relayOrigin(url));
  target.searchParams.set("gatewayId", z.string().uuid().parse(gatewayId));
  const response = await transport(target, {
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (!response.ok) throw new Error("Relay configuration is unavailable");
  const value = configurationSchema.parse(await readBoundedJson(response));
  if (value.gatewayId !== gatewayId.toLowerCase())
    throw new Error("Relay configuration changed the gateway identity");
  if (value.publicOrigin) bindingOrigin(value.publicOrigin);
  return value;
}
