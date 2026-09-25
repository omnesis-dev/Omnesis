// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The keepalive's arithmetic, and the one number it borrows.
 *
 * This package ships standalone into a harness host and imports nothing of the
 * gateway, so the refresh-token lifetime is restated here. Nothing at runtime
 * would notice the two drifting: the plugin would simply decide there was time
 * left on a ticket that had already expired, and the installation would go
 * quiet in exactly the way the keepalive exists to prevent. So the guard is a
 * test that reads the gateway's own declaration — the same shape as the
 * wake-contract parity guard over the Hermes adapter.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import {
  ASSUMED_REFRESH_TOKEN_LIFETIME_MS,
  REFRESH_KEEPALIVE_MARGIN_MS,
  refreshKeepaliveDue,
} from "./oauth-keepalive.js";

const GATEWAY_STORE_HELPERS = fileURLToPath(
  new URL("../../gateway/src/access/store-helpers.ts", import.meta.url),
);
const HERMES_ADAPTER = fileURLToPath(new URL("../hermes/adapter.py", import.meta.url));

const DAY_MS = 24 * 60 * 60_000;

describe("the refresh-token lifetime as both sides state it", () => {
  test("matches the gateway's REFRESH_TOKEN_TTL_MS", () => {
    const source = readFileSync(GATEWAY_STORE_HELPERS, "utf8");
    const declaration = /^export const REFRESH_TOKEN_TTL_MS = (.+);$/m.exec(source);
    if (!declaration) throw new Error("the gateway declares no REFRESH_TOKEN_TTL_MS");
    // The declaration is a product of literals (`30 * 24 * 60 * 60_000`), so
    // read what it evaluates to rather than matching how it is spelled.
    expect(evaluateProduct(declaration[1]!)).toBe(ASSUMED_REFRESH_TOKEN_LIFETIME_MS);
  });

  test("matches the independently deployed Hermes adapter", () => {
    const source = readFileSync(HERMES_ADAPTER, "utf8");
    expect(readPythonProduct(source, "_OAUTH_REFRESH_TOKEN_LIFETIME_MS")).toBe(
      ASSUMED_REFRESH_TOKEN_LIFETIME_MS,
    );
    expect(readPythonProduct(source, "_OAUTH_REFRESH_MARGIN_MS")).toBe(REFRESH_KEEPALIVE_MARGIN_MS);
    expect(readPythonProduct(source, "_OAUTH_KEEPALIVE_INTERVAL_SECONDS") * 1_000).toBe(
      6 * 60 * 60_000,
    );
  });

  test("leaves a margin that is a real fraction of the lifetime", () => {
    expect(REFRESH_KEEPALIVE_MARGIN_MS).toBeLessThan(ASSUMED_REFRESH_TOKEN_LIFETIME_MS / 2);
    expect(REFRESH_KEEPALIVE_MARGIN_MS).toBeGreaterThan(DAY_MS);
  });
});

/** Multiply out a declaration written as a product of numeric literals. */
function evaluateProduct(expression: string): number {
  const terms = expression
    .replaceAll("_", "")
    .split("*")
    .map((term) => Number(term.trim()));
  if (terms.some((term) => !Number.isFinite(term))) {
    throw new Error(`cannot read the gateway's lifetime declaration: ${expression}`);
  }
  return terms.reduce((product, term) => product * term, 1);
}

function readPythonProduct(source: string, name: string): number {
  const declaration = new RegExp(`^${name} = (.+)$`, "m").exec(source);
  if (!declaration) throw new Error(`the Hermes adapter declares no ${name}`);
  return evaluateProduct(declaration[1]!);
}

describe("when the keepalive spends the refresh token", () => {
  const now = Date.UTC(2026, 0, 30);

  test("leaves a ticket alone while most of its life remains", () => {
    expect(refreshKeepaliveDue(now - DAY_MS, now)).toBe(false);
    expect(refreshKeepaliveDue(now - 22 * DAY_MS, now)).toBe(false);
  });

  test("spends it once it is inside the last week", () => {
    expect(refreshKeepaliveDue(now - 23 * DAY_MS, now)).toBe(true);
    expect(refreshKeepaliveDue(now - 29 * DAY_MS, now)).toBe(true);
  });

  test("spends one that has already expired, so recovery gets its chance", () => {
    expect(refreshKeepaliveDue(now - 40 * DAY_MS, now)).toBe(true);
  });

  test("treats a token of unknown age as due", () => {
    // A credential file written before the stamp existed. Refreshing one that
    // had life left costs a request; skipping one that did not costs the
    // installation its corpus access.
    expect(refreshKeepaliveDue(undefined, now)).toBe(true);
  });

  test("treats a stamp from the future as due rather than as time in hand", () => {
    expect(refreshKeepaliveDue(now + DAY_MS, now)).toBe(true);
  });

  test("honours an explicit lifetime and margin", () => {
    expect(refreshKeepaliveDue(now - 5 * DAY_MS, now, 10 * DAY_MS, 4 * DAY_MS)).toBe(false);
    expect(refreshKeepaliveDue(now - 6 * DAY_MS, now, 10 * DAY_MS, 4 * DAY_MS)).toBe(true);
  });
});
