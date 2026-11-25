// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import {
  createWidgetHost,
  rendererPath,
  widgetOrigin,
  widgetPolicy,
} from "./native-widget-host.js";

const nonce = "ab".repeat(32);
type WidgetCallbacks = {
  payload: Record<string, string>;
  onResult: (token: string, metadata?: object) => void;
  onExit: () => void;
  onError: (error: string) => void;
};
function fixture(
  open = vi.fn<(args: WidgetCallbacks) => Promise<() => void>>(async () => () => {}),
) {
  const send = vi.fn();
  const appendChild = vi.fn();
  const status = { textContent: "" };
  const fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ renderers: { invented: "/portal/widget-renderers/invented/module.js" } }),
  }));
  const load = vi.fn(async () => ({ open }));
  const host = createWidgetHost({
    document: { createElement: () => ({}), head: { appendChild }, getElementById: () => status },
    fetch,
    load,
    send,
  });
  return { host, fetch, load, open, send, appendChild };
}

describe("native widget host", () => {
  it("allows only declared secure origins and exact public renderer assets", () => {
    for (const value of [
      "*",
      "data:",
      "https://example.com; script-src *",
      "http://example.com",
      "https://name:secret@example.com",
      "https://example.com/path",
      "https://example.com:99999",
    ]) {
      expect(widgetOrigin(value)).toBeNull();
    }
    expect(widgetOrigin("https://*.example.com")).toBe("https://*.example.com");
    expect(widgetOrigin("wss://example.com")).toBeNull();
    expect(widgetOrigin("wss://example.com", true)).toBe("wss://example.com");
    expect(() => rendererPath("invented", { invented: "/admin/config" })).toThrow();
    expect(() => rendererPath("../admin", {})).toThrow();
    expect(widgetPolicy({ script: ["https://sdk.example.com", "*"] })).toContain(
      "script-src 'self' https://sdk.example.com",
    );
  });

  it("loads generic provider code without cookies and forwards repeated bounded typed results", async () => {
    const f = fixture();
    await f.host.start({
      nonce,
      kind: "invented",
      payload: { session: "fictional-session" },
      origins: {},
    });
    expect(f.fetch).toHaveBeenCalledWith("/portal/widget-renderers.json", {
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
    expect(f.load).toHaveBeenCalledWith("/portal/widget-renderers/invented/module.js");
    const callbacks = f.open.mock.calls[0]![0] as unknown as {
      onResult: (token: string, metadata?: object) => void;
      onExit: () => void;
      onError: (error: string) => void;
    };
    callbacks.onResult("fixture-token-1", { account: "fictional-1" });
    callbacks.onResult("fixture-token-2");
    expect(f.send.mock.calls.map(([event]) => event.type)).toEqual(["result", "result"]);
    expect(f.send.mock.calls[1]![0]).toEqual({
      nonce,
      type: "result",
      token: "fixture-token-2",
      metadata: {},
    });
    callbacks.onError("secret upstream message");
    expect(f.send).toHaveBeenLastCalledWith({ nonce, type: "error" });
    expect(JSON.stringify(f.send.mock.calls)).not.toContain("secret upstream message");
  });

  it("refuses invalid configuration and oversized callbacks without echoing their contents", async () => {
    const f = fixture();
    await f.host.start({ nonce, kind: "invented", payload: {} });
    const callbacks = f.open.mock.calls[0]![0] as unknown as {
      onResult: (token: string, metadata?: object) => void;
    };
    callbacks.onResult("private-value".repeat(2000));
    callbacks.onResult("fixture", { oversized: "s".repeat(65536) });
    callbacks.onResult("é".repeat(9000));
    callbacks.onResult("fixture", () => {});
    callbacks.onResult("fixture", { toJSON: () => undefined });
    expect(f.send.mock.calls).toEqual(Array.from({ length: 5 }, () => [{ nonce, type: "error" }]));
    const invalid = fixture();
    await invalid.host.start({ nonce, kind: "../admin/config", payload: {} });
    expect(invalid.load).not.toHaveBeenCalled();
  });

  it("cleans up when cancellation happens during async provider setup and ignores late callbacks", async () => {
    let finish!: (cleanup: () => void) => void;
    let callbacks: { onResult: (token: string) => void } | undefined;
    const cleanup = vi.fn();
    const f = fixture(
      vi.fn((args) => {
        callbacks = args;
        return new Promise<() => void>((resolve) => {
          finish = resolve;
        });
      }),
    );
    const starting = f.host.start({ nonce, kind: "invented", payload: {} });
    await vi.waitFor(() => expect(f.open).toHaveBeenCalled());
    f.host.stop();
    callbacks?.onResult("late-secret-token");
    finish(cleanup);
    await starting;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
  });
});
