// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { browserUrlIdentity, type UrlCanonicalizerSpec } from "./url-normalize.js";

describe("browserUrlIdentity", () => {
  const spec: UrlCanonicalizerSpec = {
    hosts: ["app.example.org"],
    // Document canonicalizers must never execute during browser matching.
    rules: [{ match: "(a+)+$", replacement: "https://example.org" }],
    browserIdentity: {
      part: "fragment",
      format: "hex-segment",
      pathPrefix: "/workspace/",
      requiredQuery: ["account"],
    },
  };
  const original = "https://app.example.org/workspace/0/?account=one%40example.org#inbox/abcdef";

  test("matches declared routes while retaining account, protocol and port", () => {
    const identity = browserUrlIdentity(original, spec);
    expect(browserUrlIdentity(original.replace("0/", "1/").replace("inbox", "all"), spec)).toBe(
      identity,
    );
    for (const other of [
      original.replace("one%40", "two%40"),
      original.replace("https:", "http:"),
      original.replace("app.example.org", "app.example.org:8443"),
    ])
      expect(browserUrlIdentity(other, spec)).not.toBe(identity);
  });

  test("ambiguous accounts and undeclared routes retain the entire URL", () => {
    for (const url of [
      original.replace("#", "&account=two%40example.org#"),
      original.replace("?account=one%40example.org", ""),
      original.replace("/workspace/", "/settings/"),
      original.replace("abcdef", "search-results"),
      original.replace("app.example.org", "other.example.org"),
      original.replace("https://", "https://user@example.org@"),
    ])
      expect(browserUrlIdentity(url, spec)).toBe(new URL(url).href);
  });

  test("declared identities cannot collide with an unrelated exact URL", () => {
    const crafted = "https://app.example.org/#hex-segment/abcdef?account=one%40example.org";
    expect(browserUrlIdentity(original, spec)).not.toBe(browserUrlIdentity(crafted, spec));
    expect(browserUrlIdentity(crafted, spec)).toBe(crafted);
  });

  test("legacy metadata never executes arbitrary patterns or erases SPA state", () => {
    const legacy = { ...spec, browserIdentity: undefined };
    const url = `https://app.example.org/${"a".repeat(100)}!?account=one#selected`;
    expect(browserUrlIdentity(url, legacy)).toBe(url);
    expect(browserUrlIdentity(url)).toBe(url);
    expect(browserUrlIdentity("mobilenotes://note/abcdef", spec)).toBe("mobilenotes://note/abcdef");
  });

  test("canonical host aliases require an explicit declaration", () => {
    const url = "https://app.example.org/heading-abcdef0123456789abcdef0123456789";
    const identitySpec: UrlCanonicalizerSpec = {
      hosts: ["app.example.org", "www.example.org"],
      rules: [],
      browserIdentity: { part: "path", format: "uuid-suffix", canonicalHost: "www.example.org" },
    };
    expect(browserUrlIdentity(url, identitySpec)).toBe(
      browserUrlIdentity(url.replace("app.", "www."), identitySpec),
    );
    expect(browserUrlIdentity(url, { ...identitySpec, hosts: ["app.example.org"] })).toBe(url);
  });
});
