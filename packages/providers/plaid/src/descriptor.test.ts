// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import plaid, { plaidIcon } from "./index.js";

/**
 * Plaid serves the whole sign-in page (hosted sign-in), so the add is a URL the
 * user opens. Nothing is embedded, so the descriptor declares no widget
 * renderer and needs no CSP origins — and the bank's own OAuth redirect never
 * has to come back to Omnesis.
 */
describe("Plaid descriptor declares a hosted sign-in contract", () => {
  test("the add is URL-based, with no embedded widget to render or allow-list", () => {
    expect(plaid.authType).toBe("oauth");
    expect(plaid.widgetOrigins).toBeUndefined();
    expect(plaid.widgetRenderer).toBeUndefined();
  });

  test("the source is gated until it has been exercised against real banks", () => {
    expect(plaid.experimental).toBe(true);
  });

  test("credentials are the operator's own Plaid app, collected once", () => {
    expect(plaid.credentials?.fileKey).toBe("plaid");
    expect(plaid.credentials?.perAccount).toBeFalsy();
    expect(plaid.credentials?.fields.map((f) => f.name)).toEqual([
      "client_id",
      "secret",
      "environment",
      "countries",
    ]);
    // The secret must never be echoed back to a client.
    expect(plaid.credentials?.fields.find((f) => f.name === "secret")?.secret).toBe(true);
  });
});

describe("Plaid icon ships a bundled, renderable image", () => {
  test("descriptor source exposes the icon with an SVG data URI", () => {
    const src = plaid.sources.find((s) => s.id === "plaid");
    expect(src?.icon).toBe(plaidIcon);
    // Daily balance/holdings rows must not swamp the transaction headline count.
    expect(src?.primaryCount).toBe("documents");
  });

  test("plaidIcon carries an inline SVG data URI (no CDN fetch)", () => {
    expect(plaidIcon.imageDataUri).toMatch(/^data:image\/svg\+xml;base64,/);
    const svg = Buffer.from(
      plaidIcon.imageDataUri!.replace(/^data:image\/svg\+xml;base64,/, ""),
      "base64",
    ).toString("utf8");
    expect(svg).toContain("<svg");
    // The brand mark and the black tile are both present.
    expect(svg).toContain('fill="#111111"');
    expect(svg).toContain('fill="#FFFFFF"');
  });

  test("still declares the SF Symbol fallback for system-glyph surfaces", () => {
    expect(plaidIcon.sfSymbol).toBe("building.columns");
    // The accent pair is the black mark's tint and a dimmed wash — not the
    // tile's white glyph, which would vanish as a chrome tint on light surfaces.
    expect(plaidIcon.color).toBe("#111111");
    expect(plaidIcon.bgColor).toBe("#2E2E31");
  });
});
