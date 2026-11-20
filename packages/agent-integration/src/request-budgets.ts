// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Socket budget for an ordinary gateway call — a read, or a write the gateway
 * settles in one transaction. Operations that run an agent turn behind the
 * request are far slower than this and pass their own budget instead.
 */
export const DEFAULT_GATEWAY_TIMEOUT_MS = 20_000;

/**
 * Socket budget for a request to the OAuth token endpoint, and for the
 * management-token re-issue that stands in for a refresh.
 *
 * Each is a write on the gateway's single writer thread, so it waits behind
 * whatever that thread is doing — tens of seconds while a restarted gateway
 * rebuilds an index — and a refresh that gives up first loses the answer to a
 * rotation the gateway goes on to make. Restated from `@omnesis/types`
 * (`OAUTH_TOKEN_REQUEST_TIMEOUT_MS`), which this published runtime cannot
 * import; `oauth-token-budget.test.ts` holds the two together.
 */
export const OAUTH_TOKEN_TIMEOUT_MS = 55_000;
