// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
import { getWidgetRenderer, resetWidgetRendererLoaderForTests } from "./widget-renderers.js";

describe("widget-renderers dynamic loader", () => {
  afterEach(() => {
    resetWidgetRendererLoaderForTests();
    vi.unstubAllGlobals();
  });

  test("returns null for a non-string / missing kind", () => {
    expect(getWidgetRenderer(undefined)).toBeNull();
    expect(getWidgetRenderer(null)).toBeNull();
    expect(getWidgetRenderer(42)).toBeNull();
  });

  test("loads a renderer from the gateway manifest by opaque kind", async () => {
    const moduleUrl =
      "data:text/javascript," +
      encodeURIComponent(
        "export function open({ payload, onResult }) { onResult(payload.token, { ok: true }); return () => {}; }",
      );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ renderers: { "demo-widget": moduleUrl } }),
      })),
    );

    const renderer = getWidgetRenderer("demo-widget");
    expect(typeof renderer).toBe("function");

    const onResult = vi.fn();
    const cleanup = await renderer({
      payload: { token: "tok-demo" },
      onResult,
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    expect(onResult).toHaveBeenCalledWith("tok-demo", { ok: true });
    expect(typeof cleanup).toBe("function");
    expect(fetch).toHaveBeenCalledWith("/portal/widget-renderers.json", {
      credentials: "same-origin",
    });
  });

  test("reports a missing registration asynchronously", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ renderers: {} }),
      })),
    );

    const onError = vi.fn();
    const renderer = getWidgetRenderer("future-widget");
    await renderer({ payload: {}, onResult: vi.fn(), onExit: vi.fn(), onError });

    expect(onError).toHaveBeenCalledWith(
      "This client can't render the future-widget sign-in widget.",
    );
  });

  test("refetches after an initially empty manifest", async () => {
    const moduleUrl =
      "data:text/javascript," +
      encodeURIComponent(
        "export function open({ payload, onResult }) { onResult(payload.token, { retried: true }); return () => {}; }",
      );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ renderers: {} }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ renderers: { "demo-widget": moduleUrl } }),
        }),
    );

    const renderer = getWidgetRenderer("demo-widget");
    const onResult = vi.fn();
    const onError = vi.fn();
    await renderer({ payload: { token: "tok-retry" }, onResult, onExit: vi.fn(), onError });

    expect(onError).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith("tok-retry", { retried: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("reports dynamic import failures through onError", async () => {
    const badModuleUrl = "data:text/javascript," + encodeURIComponent("export function");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ renderers: { "broken-widget": badModuleUrl } }),
      })),
    );

    const renderer = getWidgetRenderer("broken-widget");
    const onError = vi.fn();
    const cleanup = await renderer({ payload: {}, onResult: vi.fn(), onExit: vi.fn(), onError });

    expect(onError).toHaveBeenCalledWith(
      "This client can't render the broken-widget sign-in widget.",
    );
    expect(typeof cleanup).toBe("function");
  });
});
