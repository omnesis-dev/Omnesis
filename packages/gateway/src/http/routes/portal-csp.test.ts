// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test } from "vitest";
import { buildPortalCsp } from "./portal.js";
import { resetWidgetOrigins, setWidgetOrigins } from "../../widget-origins.js";

/**
 * The portal CSP must fold in the external widget-vendor origins a source
 * DECLARES via its descriptor's `widgetOrigins` — and ONLY those — so a
 * `link-widget` source's hosted widget can load its SDK + iframe in the
 * browser. These assertions are generic: they exercise the aggregation through
 * an INVENTED fixture source, never hardcoding a real source's origins, so the
 * mechanism stays source-agnostic.
 */
describe("portal CSP widget-origin aggregation (#918)", () => {
  // A representative inline-script hash (the importmap hash the real portal
  // emits). The exact value is irrelevant here — we only assert how the widget
  // origins compose around it.
  const HASHES = ["'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='"];

  afterEach(() => {
    resetWidgetOrigins();
  });

  test("with NO declared origins the policy stays strictly self-hosted", () => {
    resetWidgetOrigins();
    const csp = buildPortalCsp(HASHES);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain(`script-src 'self' ${HASHES[0]}`);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-src 'self'");
    // No third-party origin leaks into any fetch directive.
    expect(csp).not.toMatch(/https?:\/\//);
  });

  test("declared origins widen exactly the matching fetch directives", () => {
    // Invented widget vendor — not any real source's origins.
    setWidgetOrigins({
      script: ["https://cdn.examplewidget.test"],
      frame: ["https://cdn.examplewidget.test", "https://*.examplewidget.test"],
      connect: ["https://api.examplewidget.test"],
    });
    const csp = buildPortalCsp(HASHES);

    const directive = (name: string): string =>
      csp
        .split(";")
        .map((d) => d.trim())
        .find((d) => d.startsWith(`${name} `)) ?? "";

    // script-src keeps 'self' + the inline-script hash AND gains the SDK origin.
    expect(directive("script-src")).toContain("'self'");
    expect(directive("script-src")).toContain(HASHES[0]);
    expect(directive("script-src")).toContain("https://cdn.examplewidget.test");

    // frame-src + connect-src gain only their declared origins.
    expect(directive("frame-src")).toContain("'self'");
    expect(directive("frame-src")).toContain("https://cdn.examplewidget.test");
    expect(directive("frame-src")).toContain("https://*.examplewidget.test");
    expect(directive("connect-src")).toContain("'self'");
    expect(directive("connect-src")).toContain("https://api.examplewidget.test");

    // Cross-contamination guard: an origin declared only for `connect` must NOT
    // appear in `script-src`, and vice-versa.
    expect(directive("script-src")).not.toContain("api.examplewidget.test");
    expect(directive("connect-src")).not.toContain("cdn.examplewidget.test");

    // Directives the source declared nothing for stay untouched.
    expect(directive("img-src")).toBe("img-src 'self' data: blob:");
    expect(directive("style-src")).toBe("style-src 'self' 'unsafe-inline'");
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
  });

  test("origins are de-duplicated and sorted across the aggregate", () => {
    setWidgetOrigins({
      script: ["https://b.example.test", "https://a.example.test", "https://b.example.test"],
      frame: [],
      connect: [],
    });
    const csp = buildPortalCsp(HASHES);
    const scriptSrc =
      csp
        .split(";")
        .map((d) => d.trim())
        .find((d) => d.startsWith("script-src ")) ?? "";
    // sorted, no duplicate
    expect(scriptSrc).toMatch(/https:\/\/a\.example\.test https:\/\/b\.example\.test/);
    expect(scriptSrc.match(/b\.example\.test/g)?.length).toBe(1);
  });
});
