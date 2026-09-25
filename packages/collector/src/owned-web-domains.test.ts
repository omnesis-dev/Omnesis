// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Owned-web-domains contract tests (#791).
 *
 * Two concerns:
 *  1. Structural — a web-app source must not silently forget to declare
 *     `ownedWebDomains`. We enumerate the in-tree source definitions and
 *     assert the known web-app sources each declare a non-empty list of
 *     valid bare hostnames. This is the "a web-app source can't silently
 *     forget to declare" guard; the oracle is a curated set of source IDs
 *     that have a browsable web app, not a brittle snapshot.
 *  2. Aggregation — `collectOwnedWebDomains` unions every definition's
 *     declarations, trims/lowercases, and de-duplicates.
 */

import { describe, expect, test } from "vitest";
import { collectOwnedWebDomains } from "./source-manager.js";
import type { SourceOrProviderDefinition } from "@omnesis/source-sdk";

/** Flatten a definition (single source or multi-source provider) to its
 *  `{ id, ownedWebDomains }` entries. */
function ownedDomainEntries(
  def: SourceOrProviderDefinition,
): Array<{ id: string; ownedWebDomains: string[] | undefined }> {
  if (def.type === "provider") {
    return def.sources.map((s) => ({ id: s.id, ownedWebDomains: s.ownedWebDomains }));
  }
  return [{ id: def.id, ownedWebDomains: def.ownedWebDomains }];
}

// A bare lowercase hostname: labels of [a-z0-9-] joined by dots, no scheme,
// port, path, or whitespace. The skip helper (`hostIsOwned`) compares against
// `URL.hostname`, which is exactly this shape.
const BARE_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

describe("ownedWebDomains: web-app sources declare the contract (#791)", () => {
  test("known web-app sources each declare a non-empty ownedWebDomains list", async () => {
    const { allDefinitions } = await import("./source-descriptors.js");
    expect(allDefinitions.length).toBeGreaterThan(0);

    const byId = new Map<string, string[] | undefined>();
    for (const def of allDefinitions) {
      for (const entry of ownedDomainEntries(def)) byId.set(entry.id, entry.ownedWebDomains);
    }

    // Sources with a browsable web app whose pages the browser-capture source
    // would otherwise double-ingest. Each MUST declare its own hosts.
    const webAppSourceIds = [
      "gmail",
      "google-calendar",
      "google-drive",
      "notion-pages",
      "onedrive",
      "outlook-email",
      "whatsapp-messages",
    ];

    for (const id of webAppSourceIds) {
      const domains = byId.get(id);
      expect(domains, `source '${id}' must be loaded to assert its ownedWebDomains`).toBeDefined();
      expect(
        (domains ?? []).length,
        `web-app source '${id}' must declare a non-empty ownedWebDomains`,
      ).toBeGreaterThan(0);
    }
  });

  test("every declared owned domain is a valid bare hostname", async () => {
    const { allDefinitions } = await import("./source-descriptors.js");
    for (const def of allDefinitions) {
      for (const { id, ownedWebDomains } of ownedDomainEntries(def)) {
        for (const host of ownedWebDomains ?? []) {
          expect(
            BARE_HOST.test(host),
            `source '${id}' declares an invalid ownedWebDomains host '${host}' — use a bare lowercase hostname (no scheme/port/path)`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("collectOwnedWebDomains aggregation (#791)", () => {
  test("unions declarations across single and multi-source definitions, sorted", () => {
    const defs = [
      { type: "source", id: "alpha", ownedWebDomains: ["alpha.example.com"] },
      {
        type: "provider",
        provider: { id: "beta", name: "Beta" },
        sources: [
          { id: "beta-one", ownedWebDomains: ["one.example.org"] },
          { id: "beta-two", ownedWebDomains: ["two.example.org"] },
        ],
      },
    ] as unknown as SourceOrProviderDefinition[];

    expect(collectOwnedWebDomains(defs)).toEqual([
      "alpha.example.com",
      "one.example.org",
      "two.example.org",
    ]);
  });

  test("trims, lowercases, and de-duplicates across sources", () => {
    const defs = [
      { type: "source", id: "a", ownedWebDomains: ["  Shared.Example.com "] },
      { type: "source", id: "b", ownedWebDomains: ["shared.example.com", "other.example.com"] },
    ] as unknown as SourceOrProviderDefinition[];

    expect(collectOwnedWebDomains(defs)).toEqual(["other.example.com", "shared.example.com"]);
  });

  test("a definition with no ownedWebDomains contributes nothing", () => {
    const defs = [
      { type: "source", id: "a" },
      { type: "source", id: "b", ownedWebDomains: ["b.example.com"] },
    ] as unknown as SourceOrProviderDefinition[];

    expect(collectOwnedWebDomains(defs)).toEqual(["b.example.com"]);
  });

  test("the real in-tree registry yields the expected vendor hosts", async () => {
    const { allDefinitions } = await import("./source-descriptors.js");
    const union = collectOwnedWebDomains(allDefinitions);
    for (const host of [
      "mail.google.com",
      "calendar.google.com",
      "drive.google.com",
      "docs.google.com",
      "notion.so",
      "web.whatsapp.com",
    ]) {
      expect(union, `expected the aggregated set to contain ${host}`).toContain(host);
    }
  });
});
