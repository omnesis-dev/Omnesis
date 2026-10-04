// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { initPanelDismiss } from "./panel-dismiss.js";

function panel(close = vi.fn().mockResolvedValue(undefined), beforeDismiss?: () => Promise<void>) {
  const { document, window } = parseHTML("<input id='query'><button>Result</button>");
  const fallback = vi.fn();
  const api = {
    windows: { getCurrent: vi.fn().mockResolvedValue({ id: 42 }) },
    sidePanel: { close },
  };
  initPanelDismiss(document as unknown as Document, api, fallback, beforeDismiss);
  const press = (key: string, options: { composing?: boolean; handled?: boolean } = {}) => {
    const event = new window.Event("keydown", { bubbles: true, cancelable: true });
    Object.assign(event, { key, isComposing: options.composing ?? false });
    if (options.handled) event.preventDefault();
    document.getElementById("query")!.dispatchEvent(event);
    return event;
  };
  return { api, fallback, press };
}

describe("native panel dismissal", () => {
  it("closes only the current window's panel when Escape is pressed in the query", async () => {
    const p = panel();
    expect(p.press("Escape").defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(p.api.sidePanel.close).toHaveBeenCalledWith({ windowId: 42 }));
    expect(p.fallback).not.toHaveBeenCalled();
  });

  it("leaves IME composition and Escape handled by an inner dialog alone", () => {
    const p = panel();
    p.press("Escape", { composing: true });
    p.press("Escape", { handled: true });
    p.press("Enter");
    expect(p.api.windows.getCurrent).not.toHaveBeenCalled();
    expect(p.fallback).not.toHaveBeenCalled();
  });

  it("coalesces repeated Escape presses while native closure is pending", async () => {
    let finish!: () => void;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const p = panel(close);
    p.press("Escape");
    p.press("Escape");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    finish();
  });

  it("waits for draft writes before closing and keeps the panel open when persistence fails", async () => {
    let finish!: () => void;
    const flush = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const p = panel(vi.fn().mockResolvedValue(undefined), flush);
    p.press("Escape");
    expect(p.api.sidePanel.close).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(p.api.sidePanel.close).toHaveBeenCalledOnce());
    const failed = panel(vi.fn().mockResolvedValue(undefined), async () => {
      throw new Error("Draft not persisted");
    });
    failed.press("Escape");
    await Promise.resolve();
    await Promise.resolve();
    expect(failed.api.sidePanel.close).not.toHaveBeenCalled();
    expect(failed.fallback).not.toHaveBeenCalled();
  });

  it("uses the extension window fallback on older Chrome versions", () => {
    const p = panel();
    Reflect.deleteProperty(p.api.sidePanel, "close");
    p.press("Escape");
    expect(p.fallback).toHaveBeenCalledOnce();
    expect(p.api.windows.getCurrent).not.toHaveBeenCalled();
  });

  it("falls back when Chrome refuses native closure", async () => {
    const p = panel(vi.fn().mockRejectedValue(new Error("Panel is already closed")));
    p.press("Escape");
    await vi.waitFor(() => expect(p.fallback).toHaveBeenCalledOnce());
  });
});
