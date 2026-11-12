// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { z } from "zod";
import { pinnedGatewayJson, type GatewayTlsTarget } from "./google-device-pairing.js";
import type { DirectCandidate } from "./direct-path.js";

/** A verified route must authenticate the same approved device even if cloud discovery is disabled. */
export async function probeGatewayDevice(
  options: {
    gateway: GatewayTlsTarget;
    deviceId: string;
    token: string;
    candidate?: DirectCandidate;
    connectHost?: string;
    candidates: DirectCandidate[];
    tlsSpkiFingerprint?: string;
    signal: AbortSignal;
  },
  json: typeof pinnedGatewayJson = pinnedGatewayJson,
): Promise<DirectCandidate[]> {
  z.object({ deviceId: z.literal(options.deviceId) }).parse(
    await json(
      options.gateway,
      "/whoami",
      undefined,
      options.signal,
      options.candidate?.address ?? options.connectHost,
      {
        token: options.token,
        connectPort: options.candidate?.port,
        tlsSpkiFingerprint: options.tlsSpkiFingerprint,
      },
    ),
  );
  return options.candidates;
}
