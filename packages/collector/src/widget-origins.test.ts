// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Widget-origins aggregation tests (#918).
 *
 * Two concerns:
 *  1. Aggregation — `collectWidgetOrigins` unions every definition's declared
 *     `widgetOrigins` per CSP fetch directive, trims, de-duplicates, and sorts.
 *     The gateway folds this union into the portal CSP so a `link-widget`
 *     source's hosted widget (its vendor SDK + iframe) can load in the browser.
 *  2. Real registry — a `link-widget` source must actually declare the origins
 *     its widget needs, and they must flow through the GENERIC aggregation. The
 *     assertion reads the in-tree definitions; it never special-cases a source
 *     name in the aggregation path itself.
 */

import { describe, expect, test } from "vitest";
import { collectWidgetOrigins, collectWidgetRenderers } from "./source-manager.js";
import type { SourceOrProviderDefinition } from "@omnesis/source-sdk";

describe("collectWidgetOrigins aggregation (#918)", () => {
  test("unions declarations across single and multi-source definitions, per directive", () => {
    const defs = [
      {
        type: "source",
        id: "alpha",
        widgetOrigins: {
          script: ["https://cdn.alpha.test"],
          frame: ["https://*.alpha.test"],
          connect: ["https://api.alpha.test"],
        },
      },
      {
        type: "provider",
        provider: { id: "beta", name: "Beta" },
        // Provider-level: the widget SDK is shared across the provider's sources.
        widgetOrigins: {
          script: ["https://cdn.beta.test"],
          frame: ["https://cdn.beta.test"],
          connect: ["https://api.beta.test"],
        },
        sources: [{ id: "beta-one" }, { id: "beta-two" }],
      },
    ] as unknown as SourceOrProviderDefinition[];

    expect(collectWidgetOrigins(defs)).toEqual({
      script: ["https://cdn.alpha.test", "https://cdn.beta.test"],
      frame: ["https://*.alpha.test", "https://cdn.beta.test"],
      connect: ["https://api.alpha.test", "https://api.beta.test"],
    });
  });

  test("trims and de-duplicates within and across directives", () => {
    const defs = [
      {
        type: "source",
        id: "a",
        widgetOrigins: { script: ["  https://cdn.x.test "], frame: [], connect: [] },
      },
      {
        type: "source",
        id: "b",
        widgetOrigins: { script: ["https://cdn.x.test"], frame: [], connect: [] },
      },
    ] as unknown as SourceOrProviderDefinition[];

    expect(collectWidgetOrigins(defs)).toEqual({
      script: ["https://cdn.x.test"],
      frame: [],
      connect: [],
    });
  });

  test("a definition with no widgetOrigins contributes nothing — empty when none declare", () => {
    const defs = [
      { type: "source", id: "a" },
      { type: "source", id: "b" },
    ] as unknown as SourceOrProviderDefinition[];

    expect(collectWidgetOrigins(defs)).toEqual({ script: [], frame: [], connect: [] });
  });

  test("the real in-tree registry: whatever it declares is a usable CSP origin", async () => {
    const { allDefinitions } = await import("./source-descriptors.js");
    const agg = collectWidgetOrigins(allDefinitions);

    // No in-tree source embeds a vendor widget, so the aggregate over the real
    // registry is empty; the fixture tests above cover the aggregation itself.
    // Asserting the emptiness keeps this honest — the loop below would pass
    // vacuously otherwise, and the next source to declare origins should bring
    // a reader back here.
    expect(agg).toEqual({ script: [], frame: [], connect: [] });

    // Every aggregated entry is a well-formed CSP origin source expression
    // (scheme + host, optional leading *. wildcard, no path) — the same shape
    // the gateway's `widgetOriginsBody` schema validates at the boundary.
    const CSP_ORIGIN =
      /^https?:\/\/(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d+)?$/i;
    for (const list of [agg.script, agg.frame, agg.connect]) {
      for (const origin of list) {
        expect(CSP_ORIGIN.test(origin), `invalid CSP origin '${origin}'`).toBe(true);
      }
    }
  });
});

describe("collectWidgetRenderers aggregation (#984)", () => {
  test("unions provider-owned renderer modules by opaque kind", () => {
    const defs = [
      {
        type: "source",
        id: "alpha",
        widgetRenderer: {
          kind: "alpha-widget",
          modulePath: "/providers/alpha/portal/widget.js",
        },
      },
      {
        type: "provider",
        provider: { id: "beta", name: "Beta" },
        widgetRenderer: {
          kind: "beta-widget",
          modulePath: "/providers/beta/portal/widget.js",
        },
        sources: [{ id: "beta-one" }, { id: "beta-two" }],
      },
    ] as unknown as SourceOrProviderDefinition[];

    expect(collectWidgetRenderers(defs)).toEqual([
      { kind: "alpha-widget", modulePath: "/providers/alpha/portal/widget.js" },
      { kind: "beta-widget", modulePath: "/providers/beta/portal/widget.js" },
    ]);
  });

  test("drops incomplete declarations and rejects conflicting duplicate kinds", () => {
    const incomplete = [
      { type: "source", id: "a", widgetRenderer: { kind: "a", modulePath: "  " } },
      { type: "source", id: "b" },
    ] as unknown as SourceOrProviderDefinition[];
    expect(collectWidgetRenderers(incomplete)).toEqual([]);

    const conflicting = [
      { type: "source", id: "a", widgetRenderer: { kind: "same", modulePath: "/one.js" } },
      { type: "source", id: "b", widgetRenderer: { kind: "same", modulePath: "/two.js" } },
    ] as unknown as SourceOrProviderDefinition[];
    expect(() => collectWidgetRenderers(conflicting)).toThrow(/Conflicting widget renderer/);
  });
});
