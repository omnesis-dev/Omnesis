// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { widgetRenderersBody } from "./http/schemas/admin.js";
import {
  getWidgetRenderers,
  resetWidgetRenderers,
  resolveWidgetRendererModule,
  setWidgetRenderers,
  widgetRendererUrl,
} from "./widget-renderers.js";

describe("widget-renderers registry (#984)", () => {
  let tmp: string | null = null;

  function writeProviderRenderer(rel = "src/portal/renderer.js"): string {
    tmp = mkdtempSync(join(tmpdir(), "omnesis-widget-renderer-"));
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "@omnesis/provider-demo" }),
      "utf8",
    );
    const modulePath = join(tmp, rel);
    mkdirSync(dirname(modulePath), { recursive: true });
    writeFileSync(modulePath, "export function open() {}\n", "utf8");
    return modulePath;
  }

  afterEach(() => {
    resetWidgetRenderers();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  test("stores registered provider modules and resolves by opaque kind", () => {
    const modulePath = writeProviderRenderer();
    const canonical = realpathSync(modulePath);

    setWidgetRenderers([{ kind: "demo-widget", modulePath }]);

    expect(getWidgetRenderers()).toEqual([{ kind: "demo-widget", modulePath: canonical }]);
    expect(widgetRendererUrl("demo-widget")).toBe("/portal/widget-renderers/demo-widget/module.js");
    expect(resolveWidgetRendererModule("demo-widget")).toBe(canonical);
  });

  test("does not resolve unknown, invalid, or missing modules", () => {
    setWidgetRenderers([
      { kind: "demo-widget", modulePath: "/tmp/omnesis-missing-renderer.js" },
      { kind: "../escape", modulePath: "/tmp/ignored.js" },
    ]);

    expect(widgetRendererUrl("demo-widget")).toBeNull();
    expect(resolveWidgetRendererModule("demo-widget")).toBeNull();
    expect(widgetRendererUrl("../escape")).toBeNull();
    expect(resolveWidgetRendererModule("../escape")).toBeNull();
    expect(widgetRendererUrl("other-widget")).toBeNull();
  });

  test("drops absolute paths outside provider-owned portal module roots", () => {
    tmp = mkdtempSync(join(tmpdir(), "omnesis-widget-renderer-"));
    const arbitraryJs = join(tmp, "secret.js");
    writeFileSync(arbitraryJs, "export const secret = true;\n", "utf8");
    const providerConfig = join(tmp, "config.json");
    writeFileSync(providerConfig, "{}\n", "utf8");

    setWidgetRenderers([
      { kind: "arbitrary-js", modulePath: arbitraryJs },
      { kind: "provider-json", modulePath: providerConfig },
    ]);

    expect(getWidgetRenderers()).toEqual([]);
    expect(widgetRendererUrl("arbitrary-js")).toBeNull();
    expect(resolveWidgetRendererModule("arbitrary-js")).toBeNull();
  });
});

describe("widgetRenderersBody schema (#984)", () => {
  test("accepts opaque kinds and absolute module paths", () => {
    expect(
      widgetRenderersBody.parse({
        renderers: [{ kind: "demo-widget", modulePath: "/providers/demo/widget.js" }],
      }),
    ).toEqual({
      renderers: [{ kind: "demo-widget", modulePath: "/providers/demo/widget.js" }],
    });
  });

  test("defaults missing renderer list to empty", () => {
    expect(widgetRenderersBody.parse({})).toEqual({ renderers: [] });
  });

  test.each([
    ["path-like kind", "../demo"],
    ["empty kind", ""],
    ["space kind", "demo widget"],
  ])("rejects %s", (_why, kind) => {
    expect(() =>
      widgetRenderersBody.parse({ renderers: [{ kind, modulePath: "/providers/demo/widget.js" }] }),
    ).toThrow();
  });

  test("rejects relative module paths", () => {
    expect(() =>
      widgetRenderersBody.parse({
        renderers: [{ kind: "demo-widget", modulePath: "providers/demo/widget.js" }],
      }),
    ).toThrow();
  });

  test("rejects non-JavaScript module paths", () => {
    expect(() =>
      widgetRenderersBody.parse({
        renderers: [{ kind: "demo-widget", modulePath: "/providers/demo/secret.json" }],
      }),
    ).toThrow();
  });
});
