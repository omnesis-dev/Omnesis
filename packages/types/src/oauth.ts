// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The time budgets an integration's OAuth token requests and the gateway's
 * refresh-token rotation have to agree on.
 *
 * Here for the same reason the subscription-management budget is: more
 * runtimes depend on them than can import the gateway. The TypeScript plugin
 * and the Hermes adapter restate the request budget, and
 * `oauth-token-budget.test.ts` beside the plugin holds both restatements and
 * the gateway's replay window to the relationship below.
 */

/**
 * The socket budget for one request to the token endpoint, and for the
 * management-token re-issue that stands in for it.
 *
 * Each of those is a write on the gateway's single writer thread, so its
 * latency is the writer's queue rather than the request's own work. A gateway
 * that has just restarted can hold that queue for tens of seconds while it
 * rebuilds an index and catches up on background work, and a refresh that
 * gives up first is the refresh whose answer is lost. The budget is sized to
 * outlast such a stall, not to ordinary request latency.
 */
export const OAUTH_TOKEN_REQUEST_TIMEOUT_MS = 55_000;

/**
 * How long, measured from a refresh token's rotation, the gateway answers a
 * repeat of the spent token from the same client with the token pair it
 * already issued.
 *
 * An integration repeats a refresh once when the first attempt got no answer.
 * The repeat is sent at most one request budget after the original, which
 * cannot have rotated before it was sent, and the client waits at most one
 * more budget for its answer. So every repeat whose answer the client is
 * still waiting for reaches the writer within two budgets of the rotation,
 * and the window must be at least that long.
 */
export const OAUTH_REFRESH_REPLAY_WINDOW_MS = 120_000;
