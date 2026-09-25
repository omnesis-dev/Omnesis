// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `@omnesis/gateway-client` — the HTTP + WebSocket implementation of the
 * gateway transport.
 *
 * {@link HttpGatewayClient} implements the `GatewayClient` contract from
 * `@omnesis/source-sdk` over REST: document upserts, sync-state, search,
 * analytics, and the admin registry mirror, with retry + 503-backpressure
 * handling. {@link GatewayWsClient} dials the gateway's `/device/ws`
 * channel, identifies via `hello`, and bridges events/commands both ways
 * with exponential-backoff reconnect.
 *
 * Extracted from `@omnesis/collector` so any off-host consumer can talk to
 * the gateway without pulling the whole sync engine. The `GatewayClient`
 * interface itself ships from `@omnesis/source-sdk`.
 *
 * Re-exports are explicit by design: vite/vitest does not follow
 * `export *` across workspace-package boundaries, so every
 * symbol consumed across the package edge is named here.
 */

export { HttpGatewayClient } from "./http-gateway-client.js";
export { GatewayWsClient } from "./gateway-ws-client.js";
export { requireGatewaySourceContract } from "./source-contract.js";
export {
  AnswerHttpClient,
  AnswerHttpError,
  InvalidAnswerResponseError,
  parseAnswerResponse,
} from "./answer-client.js";
export type {
  AnswerHttpClientOptions,
  AnswerRequestOptions,
  SubmitAnswerInput,
} from "./answer-client.js";
export { DEFAULT_MAX_BACKPRESSURE_WAITS, DEFAULT_UPSERT_CHUNK } from "./tunables.js";
