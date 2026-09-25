// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test } from "vitest";
// @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
import { devAnnotationContext } from "./dev-annotate.js";

const hadNavigator = "navigator" in globalThis;
const originalNavigator = hadNavigator ? globalThis.navigator : undefined;

afterEach(() => {
  if (hadNavigator) {
    // @ts-expect-error — test-only global setup.
    globalThis.navigator = originalNavigator;
  } else {
    // @ts-expect-error — test-only global setup.
    delete globalThis.navigator;
  }
});

describe("devAnnotationContext", () => {
  test("tags the filing platform and keeps the label", () => {
    // @ts-expect-error — test-only global setup.
    delete globalThis.navigator;
    expect(devAnnotationContext("Document doc-1")).toEqual({
      platform: "portal",
      label: "Document doc-1",
    });
  });

  test("omits an empty label but keeps the platform", () => {
    // @ts-expect-error — test-only global setup.
    delete globalThis.navigator;
    const context = devAnnotationContext("");
    expect(context.platform).toBe("portal");
    expect("label" in context).toBe(false);
  });

  test("includes the browser user agent when available", () => {
    // @ts-expect-error — test-only global setup.
    globalThis.navigator = { userAgent: "TestBrowser/1.0" };
    expect(devAnnotationContext("x").userAgent).toBe("TestBrowser/1.0");
  });

  test("omits the user agent outside a browser", () => {
    // @ts-expect-error — test-only global setup.
    delete globalThis.navigator;
    expect("userAgent" in devAnnotationContext("x")).toBe(false);
  });

  test("tolerates an undefined label", () => {
    // @ts-expect-error — test-only global setup.
    delete globalThis.navigator;
    const context = devAnnotationContext(undefined);
    expect(context.platform).toBe("portal");
    expect("label" in context).toBe(false);
  });

  test("omits an empty or non-string user agent", () => {
    // @ts-expect-error — test-only global setup.
    globalThis.navigator = { userAgent: "" };
    expect("userAgent" in devAnnotationContext("x")).toBe(false);
    // @ts-expect-error — test-only global setup.
    globalThis.navigator = { userAgent: 42 };
    expect("userAgent" in devAnnotationContext("x")).toBe(false);
  });
});
