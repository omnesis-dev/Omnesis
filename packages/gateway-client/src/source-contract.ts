// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { assertGatewaySourceContract } from "@omnesis/core";

/** No cache: a gateway can be replaced while a collector remains running. */
export async function requireGatewaySourceContract(gatewayUrl: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${gatewayUrl}/health`, {
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch (err) {
    // This check runs before every gateway request, so its failures are the
    // ones an operator is most likely to meet — and `fetch()` rejects with a
    // bare `TypeError: fetch failed` whose stack holds only undici internals.
    // Unnamed, it reads as though the source's own upstream stopped answering.
    throw new Error("Gateway source-contract check (GET /health) failed", { cause: err });
  }
  if (!response.ok) {
    throw new Error(
      `Cannot verify gateway source contract: health returned HTTP ${response.status}`,
    );
  }
  assertGatewaySourceContract(await response.json());
}
