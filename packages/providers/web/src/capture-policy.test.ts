// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEB_CAPTURE_RULES,
  isWebCapturePolicy,
  judgeCaptureUrl,
  normalizeCaptureDomain,
  pathHasSkippedSegment,
  pauseActive,
  pauseRemainingMs,
  type WebCapturePolicy,
} from "./capture-policy.js";

const NOW = 1_800_000_000_000;

function policy(overrides: Partial<WebCapturePolicy> = {}): WebCapturePolicy {
  return {
    updatedAt: "",
    pause: null,
    excludedDomains: [],
    ownedDomains: [],
    rules: DEFAULT_WEB_CAPTURE_RULES,
    removedPages: [],
    removedPagesTruncated: false,
    ...overrides,
  };
}

describe("normalizeCaptureDomain", () => {
  it("accepts a pasted URL, a bare host and a leading dot", () => {
    expect(normalizeCaptureDomain("https://www.Example.com/path?x=1")).toBe("www.example.com");
    expect(normalizeCaptureDomain("  Example.COM  ")).toBe("example.com");
    expect(normalizeCaptureDomain(".example.com.")).toBe("example.com");
  });
  it("rejects input without a usable host", () => {
    expect(normalizeCaptureDomain("")).toBe("");
    expect(normalizeCaptureDomain("localhost")).toBe("");
    expect(normalizeCaptureDomain("not a host")).toBe("");
    expect(normalizeCaptureDomain(`${"a".repeat(64)}.example.com`)).toBe("");
  });
  it("keeps a valid IPv4 literal and drops an invalid one", () => {
    expect(normalizeCaptureDomain("192.0.2.10")).toBe("192.0.2.10");
    expect(normalizeCaptureDomain("192.0.2.999")).toBe("");
  });
});

describe("pause", () => {
  it("treats null and a lapsed deadline as resumed", () => {
    expect(pauseActive(null, NOW)).toBe(false);
    expect(pauseActive({ until: NOW - 1 }, NOW)).toBe(false);
    expect(pauseRemainingMs({ until: NOW - 1 }, NOW)).toBeNull();
  });
  it("reports an indefinite pause and a timed remainder", () => {
    expect(pauseActive({ until: null }, NOW)).toBe(true);
    expect(pauseRemainingMs({ until: null }, NOW)).toBeNull();
    expect(pauseRemainingMs({ until: NOW + 90_000 }, NOW)).toBe(90_000);
  });
});

describe("pathHasSkippedSegment", () => {
  it("matches whole segments only, case-insensitively, after decoding", () => {
    const segments = ["login", "checkout"];
    expect(pathHasSkippedSegment("/account/Login", segments)).toBe(true);
    expect(pathHasSkippedSegment("/shop/check%6fut/step-2", segments)).toBe(true);
    expect(pathHasSkippedSegment("/blog/login-tips-for-admins", segments)).toBe(false);
    expect(pathHasSkippedSegment("/", segments)).toBe(false);
    expect(pathHasSkippedSegment("/login", [])).toBe(false);
  });
});

describe("judgeCaptureUrl", () => {
  const context = { gatewayHost: "gateway.example.ts.net", now: NOW };

  it("allows an ordinary page under an empty policy", () => {
    expect(judgeCaptureUrl(policy(), "https://blog.example.org/post/1", context)).toEqual({
      allowed: true,
    });
  });
  it("refuses the gateway's own host and its subdomains", () => {
    expect(
      judgeCaptureUrl(policy(), "https://gateway.example.ts.net:7600/portal", context),
    ).toEqual({
      allowed: false,
      reason: "gateway-host",
    });
  });
  it("refuses excluded and owned domains, subdomains included", () => {
    const p = policy({ excludedDomains: ["bank.example"], ownedDomains: ["notes.example"] });
    expect(judgeCaptureUrl(p, "https://online.bank.example/x", context).allowed).toBe(false);
    expect(judgeCaptureUrl(p, "https://notes.example/page", context)).toEqual({
      allowed: false,
      reason: "owned-domain",
    });
    expect(judgeCaptureUrl(p, "https://evilbank.example/x", context).allowed).toBe(true);
  });
  it("refuses authentication and payment paths by the built-in rules", () => {
    expect(judgeCaptureUrl(policy(), "https://shop.example/checkout", context)).toEqual({
      allowed: false,
      reason: "skipped-path",
    });
    expect(judgeCaptureUrl(policy(), "https://shop.example/catalog", context).allowed).toBe(true);
  });
  it("refuses everything while paused, and nothing once the pause lapsed", () => {
    expect(
      judgeCaptureUrl(policy({ pause: { until: null } }), "https://a.example/", context),
    ).toEqual({ allowed: false, reason: "paused" });
    expect(
      judgeCaptureUrl(policy({ pause: { until: NOW - 1 } }), "https://a.example/", context).allowed,
    ).toBe(true);
  });
  it("refuses a page the user removed for good when its id is known", () => {
    const p = policy({ removedPages: ["abc"] });
    expect(judgeCaptureUrl(p, "https://a.example/", { ...context, externalId: "abc" })).toEqual({
      allowed: false,
      reason: "removed-page",
    });
    expect(judgeCaptureUrl(p, "https://a.example/", context).allowed).toBe(true);
  });
  it("refuses an unparseable URL", () => {
    expect(judgeCaptureUrl(policy(), "not a url", context)).toEqual({
      allowed: false,
      reason: "invalid-url",
    });
  });
});

describe("isWebCapturePolicy", () => {
  it("accepts the wire shape and rejects a malformed one", () => {
    expect(isWebCapturePolicy(policy())).toBe(true);
    expect(isWebCapturePolicy(policy({ pause: { until: null } }))).toBe(true);
    expect(isWebCapturePolicy({ ...policy(), excludedDomains: [1] })).toBe(false);
    expect(isWebCapturePolicy({ ...policy(), rules: {} })).toBe(false);
    expect(isWebCapturePolicy({ ...policy(), pause: { until: "soon" } })).toBe(false);
    expect(isWebCapturePolicy(null)).toBe(false);
  });
});
