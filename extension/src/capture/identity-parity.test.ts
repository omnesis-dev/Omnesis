// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { normalizeUrl, urlToExternalId } from "@omnesis/core";
import { normalizeCaptureUrl } from "./normalize.js";

/**
 * Browser-extension and shared-core URL identity parity.
 *
 * A web page's identity in the Web Pages dataset is
 * `external_id = SHA256(normalizeUrl(url))`. The shared core computes it via
 * `urlToExternalId(normalizeUrl(url))`; the browser extension computes its
 * capture key via `normalizeCaptureUrl`. If the two
 * paths normalize a URL differently, the SAME page lands under two identities
 * and never dedups — the core bug this epic fixes.
 *
 * This is the regression net for the canonicalizer unification: it asserts the
 * extension's `normalizeCaptureUrl` produces the byte-identical normalized
 * string the shared `normalizeUrl` does, across a judged URL table that
 * covers exactly the divergence axes an audit flagged — tracking-param
 * stripping (including the bare `ref` that the old extension mirror dropped),
 * slash-bearing-fragment handling, anchor-fragment stripping, trailing slashes,
 * param ordering, host case, and a sampling of the union click-id params. It
 * also asserts the resulting SHA-256 `external_id` matches, since that is what
 * actually keys the upsert.
 *
 * All fixtures use RFC-reserved domains (example.com / example.org).
 */

// Each row is a single raw URL fed to BOTH paths; the test asserts they agree.
const JUDGED_URLS: ReadonlyArray<readonly [label: string, url: string]> = [
  ["bare clean url", "https://example.com/clean/path"],
  ["root slash kept", "https://example.com/"],
  ["non-root trailing slash stripped", "https://example.com/docs/getting-started/"],
  ["host case folded, path case kept", "https://Example.COM/MixedCasePath"],
  ["utm params stripped", "https://example.com/post?utm_source=nl&utm_medium=email&id=42"],
  ["bare ref stripped (the divergence the audit named)", "https://example.com/x?ref=hn&id=9"],
  ["click-id union params stripped", "https://example.com/y?fbclid=a&gclid=b&igshid=c&page=2"],
  ["ms/yandex/ga click-ids stripped", "https://example.com/z?msclkid=a&yclid=b&_ga=c&q=widgets"],
  ["param order sorted", "https://example.com/search?q=widgets&page=2&id=7"],
  ["anchor-like fragment dropped", "https://example.com/article#comments"],
  ["slash-bearing fragment preserved", "https://example.com/app#/route/123"],
  ["lone meaningful SPA param preserved", "https://app.example.org/board?id=xyz"],
  ["www preserved (not stripped)", "https://www.example.com/a"],
  ["explicit non-default port preserved", "https://example.com:8443/svc"],
];

describe("browser extension == shared core external_id parity", () => {
  it.each(JUDGED_URLS)("normalizes identically: %s", (_label, url) => {
    const coreNormalized = normalizeUrl(url);
    const extensionNormalized = normalizeCaptureUrl(url);
    expect(extensionNormalized).toBe(coreNormalized);
  });

  it.each(JUDGED_URLS)("derives the identical external_id: %s", (_label, url) => {
    const coreId = urlToExternalId(normalizeUrl(url));
    const extensionId = urlToExternalId(normalizeCaptureUrl(url));
    expect(extensionId).toBe(coreId);
  });

  it("two genuinely different pages keep distinct ids on both paths", () => {
    const a = urlToExternalId(normalizeCaptureUrl("https://example.com/p?id=7"));
    const b = urlToExternalId(normalizeUrl("https://example.com/p?id=8"));
    expect(a).not.toBe(b);
  });

  it("the same page reached with vs without ?ref dedups (the bug fix)", () => {
    const withRef = urlToExternalId(normalizeCaptureUrl("https://example.com/post?ref=hn"));
    const withoutRef = urlToExternalId(normalizeUrl("https://example.com/post"));
    expect(withRef).toBe(withoutRef);
  });
});
