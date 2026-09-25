// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { normalizeCaptureUrl, hostOf, preferCanonicalUrl } from "./normalize.js";

describe("normalizeCaptureUrl", () => {
  const cases: Array<[string, string, string]> = [
    [
      "drops an anchor-like fragment (no slash)",
      "https://example.com/article#comments",
      "https://example.com/article",
    ],
    [
      "preserves a slash-bearing fragment (SPA hash-route identity, matching core)",
      "https://example.com/app#/route/123",
      "https://example.com/app#/route/123",
    ],
    [
      "strips utm_* tracking params",
      "https://example.com/post?utm_source=newsletter&utm_medium=email&id=42",
      "https://example.com/post?id=42",
    ],
    [
      "strips fbclid / gclid / mc_eid / igshid",
      "https://example.com/x?fbclid=abc&gclid=def&mc_eid=ghi&igshid=jkl&page=2",
      "https://example.com/x?page=2",
    ],
    [
      "strips the bare ref param (union set keeps core's ref)",
      "https://example.com/x?ref=hn&id=9",
      "https://example.com/x?id=9",
    ],
    [
      "preserves meaningful query params and sorts them",
      "https://example.com/search?q=widgets&page=2",
      "https://example.com/search?page=2&q=widgets",
    ],
    [
      "preserves a lone meaningful SPA query param",
      "https://app.example.com/board?id=xyz",
      "https://app.example.com/board?id=xyz",
    ],
    [
      "lowercases the host, preserves path case",
      "https://Example.COM/MixedCasePath",
      "https://example.com/MixedCasePath",
    ],
    [
      "normalizes a non-root trailing slash",
      "https://example.com/docs/getting-started/",
      "https://example.com/docs/getting-started",
    ],
    ["keeps the root path slash", "https://example.com/", "https://example.com/"],
    [
      "leaves a clean URL untouched",
      "https://example.com/clean/path",
      "https://example.com/clean/path",
    ],
  ];

  it.each(cases)("%s", (_label, input, expected) => {
    expect(normalizeCaptureUrl(input)).toBe(expected);
  });

  it("returns non-http(s) URLs unchanged", () => {
    expect(normalizeCaptureUrl("chrome://extensions")).toBe("chrome://extensions");
    expect(normalizeCaptureUrl("about:blank")).toBe("about:blank");
  });

  it("returns unparseable input unchanged", () => {
    expect(normalizeCaptureUrl("not a url")).toBe("not a url");
  });

  it("strips userinfo before a URL can enter capture storage", () => {
    expect(normalizeCaptureUrl("https://user:password@example.com/article")).toBe(
      "https://example.com/article",
    );
  });

  it("two normalizations of the same logical page collide", () => {
    const a = normalizeCaptureUrl("https://example.com/p?utm_source=x&id=7#top");
    const b = normalizeCaptureUrl("https://EXAMPLE.com/p?id=7&fbclid=zzz");
    expect(a).toBe(b);
  });

  it("two genuinely different pages do not collide", () => {
    const a = normalizeCaptureUrl("https://example.com/p?id=7");
    const b = normalizeCaptureUrl("https://example.com/p?id=8");
    expect(a).not.toBe(b);
  });
});

describe("hostOf", () => {
  it("returns the lowercased host", () => {
    expect(hostOf("https://App.Example.COM/x")).toBe("app.example.com");
  });
  it("returns empty string for unparseable input", () => {
    expect(hostOf("garbage")).toBe("");
  });
});

describe("preferCanonicalUrl", () => {
  it("adopts a more-specific same-origin canonical over a transient root URL", () => {
    // The ChatGPT pathology: address bar at the bare root while a conversation
    // is shown; the canonical names the real per-conversation identity.
    expect(preferCanonicalUrl("https://chatgpt.com/", "https://chatgpt.com/c/abc-123")).toBe(
      "https://chatgpt.com/c/abc-123",
    );
  });

  it("resolves a relative canonical against the live URL", () => {
    expect(preferCanonicalUrl("https://chatgpt.com/", "/c/abc-123")).toBe(
      "https://chatgpt.com/c/abc-123",
    );
  });

  it("does NOT let a canonical generalise a specific page (homepage-collapse guard)", () => {
    // A site that points rel=canonical at its homepage on every page must not
    // collapse distinct articles onto one document.
    expect(
      preferCanonicalUrl("https://blog.example.com/posts/42", "https://blog.example.com/"),
    ).toBe("https://blog.example.com/posts/42");
  });

  it("does NOT adopt a shallower same-origin canonical (section-collapse guard)", () => {
    expect(
      preferCanonicalUrl(
        "https://shop.example.com/products/shoes",
        "https://shop.example.com/products",
      ),
    ).toBe("https://shop.example.com/products/shoes");
  });

  it("rejects a cross-origin canonical", () => {
    expect(preferCanonicalUrl("https://example.com/", "https://evil.example.net/c/1")).toBe(
      "https://example.com/",
    );
  });

  it("rejects an HTTPS-to-HTTP canonical downgrade", () => {
    expect(
      preferCanonicalUrl("https://example.com/articles/old", "http://example.com/articles/new"),
    ).toBe("https://example.com/articles/old");
  });

  it("rejects a canonical on another port", () => {
    expect(
      preferCanonicalUrl(
        "https://example.com/articles/old",
        "https://example.com:8443/articles/new",
      ),
    ).toBe("https://example.com/articles/old");
  });

  it("rejects a non-http(s) canonical", () => {
    expect(preferCanonicalUrl("https://example.com/x", "javascript:void(0)")).toBe(
      "https://example.com/x",
    );
  });

  it("rejects a canonical containing userinfo", () => {
    expect(
      preferCanonicalUrl(
        "https://example.com/articles/old",
        "https://user:password@example.com/articles/new",
      ),
    ).toBe("https://example.com/articles/old");
  });

  it("returns the live URL when there is no canonical", () => {
    expect(preferCanonicalUrl("https://example.com/x", null)).toBe("https://example.com/x");
    expect(preferCanonicalUrl("https://example.com/x", undefined)).toBe("https://example.com/x");
    expect(preferCanonicalUrl("https://example.com/x", "")).toBe("https://example.com/x");
  });

  it("adopts an equal-depth canonical (e.g. a slug canonicalization)", () => {
    expect(
      preferCanonicalUrl("https://example.com/a/old-slug", "https://example.com/a/new-slug"),
    ).toBe("https://example.com/a/new-slug");
  });
});
