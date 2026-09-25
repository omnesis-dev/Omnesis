// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { WEB_PAGE_SOURCE_ID, webPageEdgeTarget } from "./edge-declaration.js";
import { normalizeUrl, urlToExternalId } from "./url-utils.js";

describe("webPageEdgeTarget (#895)", () => {
  it("addresses the canonical `web` entity by SHA256(normalizeUrl(url))", () => {
    const url = "https://example.com/article";
    const ref = webPageEdgeTarget(url);
    expect(ref.kind).toBe("external");
    if (ref.kind !== "external") throw new Error("unreachable");
    expect(ref.sourceId).toBe(WEB_PAGE_SOURCE_ID);
    expect(ref.sourceId).toBe("web");
    // Matches the extension's page identity: the SHA-256 of the
    // canonically normalized URL.
    expect(ref.sourceDocumentId).toBe(urlToExternalId(normalizeUrl(url)));
  });

  it("collapses tracking-param / trailing-slash variants onto one target", () => {
    const a = webPageEdgeTarget("https://example.com/post/?utm_source=news");
    const b = webPageEdgeTarget("https://example.com/post");
    expect(a.kind).toBe("external");
    expect(b.kind).toBe("external");
    if (a.kind !== "external" || b.kind !== "external") throw new Error("unreachable");
    // A bookmark of `…/post/?utm_source=…` and a visit to `…/post` resolve to
    // the SAME `web` row — exactly the dedup the unified dataset relies on.
    expect(a.sourceDocumentId).toBe(b.sourceDocumentId);
  });

  it("keeps genuinely-distinct pages on distinct targets", () => {
    const a = webPageEdgeTarget("https://example.com/a");
    const b = webPageEdgeTarget("https://example.com/b");
    if (a.kind !== "external" || b.kind !== "external") throw new Error("unreachable");
    expect(a.sourceDocumentId).not.toBe(b.sourceDocumentId);
  });

  it("WEB_PAGE_SOURCE_ID is the canonical `web` source id", () => {
    // Gateway metadata and producers share this constant so declared edges
    // resolve to the rows the extension writes.
    expect(WEB_PAGE_SOURCE_ID).toBe("web");
  });
});
