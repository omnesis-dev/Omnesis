// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Declarations these descriptors make about the web, asserted through the
 * machinery that consumes them rather than by restating the literals: the
 * canonicalizers are exercised through the real registry, and the owned domains
 * through the same host match the browser-capture source performs.
 */

import { describe, test, expect } from "vitest";
import { buildCanonicalizerRegistry, hostIsOwned, normalizeUrl } from "@omnesis/core";
import outlookProvider from "./index.js";

const registry = buildCanonicalizerRegistry(
  outlookProvider.sources
    .map((s) => s.urlCanonicalizer)
    .filter((spec): spec is NonNullable<typeof spec> => Boolean(spec)),
);

const ownedDomains = outlookProvider.sources.flatMap((s) => s.ownedWebDomains ?? []);

describe("Outlook Calendar URLs are left alone", () => {
  test("an event URL passes through unrewritten", () => {
    // No canonicalizer: `source_url` is the link a client follows, so an
    // invented canonical shape would hand out a dead one. Only the generic
    // normalization applies.
    const url = "https://outlook.live.com/calendar/0/view/week?itemid=AAMkAGI2TGuLAAA%3D";
    expect(normalizeUrl(url, registry)).toBe(url);
  });
});

describe("OneDrive URL canonicalization", () => {
  test("the drive id and share markers fall away, the item id decides", () => {
    const canonical = "https://onedrive.live.com/?id=01ABCDEF";
    const variants = [
      "https://onedrive.live.com/?id=01ABCDEF&cid=A1B2C3",
      "https://onedrive.live.com/?cid=A1B2C3&id=01ABCDEF",
      "https://onedrive.live.com/?id=01ABCDEF&cid=A1B2C3&e=xyz789&migratedtospo=true",
    ];
    for (const variant of variants) {
      expect(normalizeUrl(variant, registry), variant).toBe(canonical);
    }
  });

  test("a 1drv.ms short link is left alone", () => {
    // It carries an opaque token rather than the item id, so only Microsoft can
    // say what it points at. Rewriting it would assert an identity we cannot check.
    const url = "https://1drv.ms/w/s!AmVeryOpaqueToken";
    expect(normalizeUrl(url, registry)).toBe(url);
  });
});

describe("owned web domains", () => {
  test("the consumer Outlook and OneDrive web apps are claimed", () => {
    for (const host of ["outlook.live.com", "onedrive.live.com"]) {
      expect(hostIsOwned(host, ownedDomains), host).toBe(true);
    }
  });

  test("a host no Microsoft source can ingest is not claimed", () => {
    // Claiming a site these sources do not cover would make the browser-capture
    // source skip pages nothing else records. The work-mailbox hosts are the
    // sharp case: sign-in goes to the consumer authority, so a mailbox on
    // `outlook.office.com` never reaches this index however the URL looks.
    for (const host of [
      "outlook.office.com",
      "outlook.office365.com",
      "1drv.ms",
      "teams.microsoft.com",
      "www.microsoft.com",
      "live.com",
    ]) {
      expect(hostIsOwned(host, ownedDomains), host).toBe(false);
    }
  });
});
