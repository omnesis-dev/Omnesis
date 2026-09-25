// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { validateRecordCitationContract } from "@omnesis/source-sdk";
import { pageVisitsSchema } from "./schemas.js";
import definition from "./index.js";

describe("Web Pages provider definition", () => {
  test("is a source with the `web` identity", () => {
    expect(definition.type).toBe("source");
    expect(definition.id).toBe("web");
    expect(definition.name).toBe("Web Pages");
    expect(definition.provider?.id).toBe("web");
    expect(definition.provider?.name).toBe("Web");
  });

  test("declares the 'web pages' unit noun (display 'Web Pages')", () => {
    expect(definition.unitName).toBe("web pages");
    // The display name is the human-readable tile label.
    expect(definition.name).toBe("Web Pages");
  });

  test("headline count is its documents, not the page_visits analytics log", () => {
    // Without this the count heuristic prefers the small analytics row count
    // and the source reads as "N visits" instead of its real page total.
    expect(definition.primaryCount).toBe("documents");
  });

  test("nothing on this host runs it, and it declares no factory", () => {
    // The extension pushes content straight to the gateway. The stub factory
    // that used to satisfy the contract returned an empty page forever; saying
    // so outright is what removes it.
    expect(definition.execution).toBe("external");
    expect(definition.create).toBeUndefined();
    expect(definition.singleInstance).toBe(true);
  });

  test("is gateway-hosted — owned + advertised by the gateway, not a collector", () => {
    // No collector syncs web, so the gateway advertises this descriptor and
    // seeds its display identity; collectors exclude it from what they
    // advertise. See SourceDescriptor.gatewayHosted.
    expect(definition.gatewayHosted).toBe(true);
  });

  test("is the graph hub for web-page documents (urlHub)", () => {
    expect(definition.urlHub).toBe(true);
  });

  test("is a fallback URL representation, independently of traversal-hub behavior", () => {
    expect(definition.urlTargetRole).toBe("fallback");
  });

  test("carries a default search prior that downweights bulk web pages", () => {
    expect(definition.defaultSourcePrior).toBe(-0.04);
  });

  test("is NOT experimental — inert until an extension pairs", () => {
    expect(definition.experimental).toBeFalsy();
  });

  test("owns no web domains (it captures the long tail, covers nothing)", () => {
    expect(definition.ownedWebDomains).toBeUndefined();
  });

  test("renders generically — has an icon with colour + an inline SVG glyph", () => {
    expect(definition.icon).toBeDefined();
    expect(definition.icon!.color).toBeDefined();
    expect(definition.icon!.sfSymbol).toBeDefined();
    expect(definition.icon!.imageDataUri).toMatch(/^data:image\/svg\+xml/);
  });

  test("declares the page_visits analytics schema (re-homed under `web`)", () => {
    expect(definition.analyticsSchemas).toBeDefined();
    expect(definition.analyticsSchemas!.map((s) => s.tableName)).toContain("page_visits");
  });
});

describe("page_visits analytics schema", () => {
  test("declares semanticTimeColumn = visited_at", () => {
    expect(pageVisitsSchema.semanticTimeColumn).toBe("visited_at");
  });

  test("declares the brief's columns", () => {
    const cols = pageVisitsSchema.columns.map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining(["url", "domain", "title", "visited_at", "dwell_ms"]),
    );
    const dwell = pageVisitsSchema.columns.find((c) => c.name === "dwell_ms")!;
    expect(dwell.type).toBe("INTEGER");
    const visitedAt = pageVisitsSchema.columns.find((c) => c.name === "visited_at")!;
    expect(visitedAt.type).toBe("TIMESTAMPTZ");
  });

  test("is keyed by (url, visited_at) so repeat visits are distinct rows", () => {
    expect(pageVisitsSchema.primaryKey).toEqual(["url", "visited_at"]);
  });

  test("satisfies the record-citation contract", () => {
    expect(() =>
      validateRecordCitationContract([pageVisitsSchema], "web/page_visits"),
    ).not.toThrow();
  });
});
