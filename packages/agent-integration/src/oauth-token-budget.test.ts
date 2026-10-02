// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The OAuth token budgets three runtimes have to agree on.
 *
 * A refresh rotates its token as the gateway answers, and the gateway answers
 * behind its single writer thread. A client that gives up before the answer
 * repeats the request once, and the gateway answers that repeat with the pair
 * it already issued for as long as its replay window lasts. If the request
 * budget, the repeat and the window stop fitting together, a slow gateway
 * turns a routine refresh into an interactive approval. So the budget is
 * declared once in `@omnesis/types`, restated by the two runtimes that cannot
 * import it, and the relationships that make it safe are asserted here.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { OAUTH_REFRESH_REPLAY_WINDOW_MS, OAUTH_TOKEN_REQUEST_TIMEOUT_MS } from "@omnesis/types";

import { DEFAULT_GATEWAY_TIMEOUT_MS, OAUTH_TOKEN_TIMEOUT_MS } from "./http.js";
import { REFRESH_LOCK_STALE_MS, REFRESH_LOCK_TIMEOUT_MS } from "./oauth.js";

const ADAPTER = join(dirname(fileURLToPath(import.meta.url)), "..", "hermes", "adapter.py");

function pythonSeconds(name: string): number {
  const match = new RegExp(`^${name} = ([0-9.]+)$`, "m").exec(readFileSync(ADAPTER, "utf8"));
  if (!match) throw new Error(`the Hermes adapter declares no ${name}`);
  return Number(match[1]) * 1_000;
}

describe("the OAuth token budget contract", () => {
  it("is restated by the plugin and the Hermes adapter", () => {
    expect(OAUTH_TOKEN_TIMEOUT_MS).toBe(OAUTH_TOKEN_REQUEST_TIMEOUT_MS);
    expect(pythonSeconds("OAUTH_TOKEN_TIMEOUT_SECONDS")).toBe(OAUTH_TOKEN_REQUEST_TIMEOUT_MS);
  });

  it("outlasts a write stall the ordinary request budget would not", () => {
    // A restarted gateway was seen holding its writer for about 40 seconds.
    expect(OAUTH_TOKEN_REQUEST_TIMEOUT_MS).toBeGreaterThan(DEFAULT_GATEWAY_TIMEOUT_MS);
    expect(OAUTH_TOKEN_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(45_000);
  });

  it("lands every repeat inside the gateway's replay window", () => {
    // The repeat is sent at most one budget after a request that cannot have
    // rotated before it was sent, and is waited for at most one more.
    expect(OAUTH_REFRESH_REPLAY_WINDOW_MS).toBeGreaterThanOrEqual(
      2 * OAUTH_TOKEN_REQUEST_TIMEOUT_MS,
    );
  });

  it("lets a lock waiter outlast the holder, and never reclaims a live holder's lease", () => {
    // A holder may refresh, repeat and re-issue, each on the token budget.
    const holderWorstCase = 3 * OAUTH_TOKEN_REQUEST_TIMEOUT_MS;
    for (const [timeout, stale] of [
      [REFRESH_LOCK_TIMEOUT_MS, REFRESH_LOCK_STALE_MS],
      [
        pythonSeconds("OAUTH_REFRESH_LOCK_TIMEOUT_SECONDS"),
        pythonSeconds("OAUTH_REFRESH_LOCK_STALE_SECONDS"),
      ],
    ] as const) {
      expect(timeout).toBeGreaterThan(holderWorstCase);
      expect(stale).toBeGreaterThan(timeout);
    }
    expect(pythonSeconds("OAUTH_REFRESH_LOCK_TIMEOUT_SECONDS")).toBe(REFRESH_LOCK_TIMEOUT_MS);
    expect(pythonSeconds("OAUTH_REFRESH_LOCK_STALE_SECONDS")).toBe(REFRESH_LOCK_STALE_MS);
  });
});
