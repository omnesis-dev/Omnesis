// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — browser-only presentation modules.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentReplayContext } from "./replay.js";
import { createAgentToolRenderer } from "./tools.js";
import { setSourceMeta, sourceIconUrl } from "../../lib/format.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); setSourceMeta({}); });

describe("offline tool presentation", () => {
  it("seeks results backwards without starting wall-clock dismiss timers", async () => {
    const { window } = parseHTML('<html><body><main></main></body></html>');
    vi.stubGlobal("window", window); vi.stubGlobal("document", window.document);
    vi.useFakeTimers();
    const host = document.querySelector("main");
    const tools = createAgentToolRenderer();
    const part = { kind: "tool", tool: "fetch_document", toolCallId: "read", result: { kind: "document", ref: { title: "Example document" }, document: { content: "First line\nSecond line" } } };
    async function seek(timeMs) {
      await act(() => render(h(AgentReplayContext.Provider, { value: { timeMs, tools: { read: { startAtMs: 0, resultAtMs: 500, dismissAtMs: 2500 } } } }, tools.renderToolPart(part, "read", () => {})), host));
    }
    await seek(1000); const earlier = host.innerHTML;
    await seek(3000); expect(host.querySelector(".agent-ephemeral")).toBeNull();
    await seek(1000); expect(host.innerHTML).toBe(earlier);
    await act(() => { vi.advanceTimersByTime(10000); });
    expect(host.innerHTML).toBe(earlier);
    await act(() => render(null, host));
  });
  it("retains the live dismiss callback and clears timers on unmount", async () => {
    const { window } = parseHTML('<html><body><main></main></body></html>');
    vi.stubGlobal("window", window); vi.stubGlobal("document", window.document); vi.useFakeTimers();
    const host = document.querySelector("main"), dispatch = vi.fn();
    const tools = createAgentToolRenderer();
    const part = { kind: "tool", tool: "fetch_document", toolCallId: "live-read", result: { kind: "document", ref: { title: "Example" }, document: { content: "One line" } } };
    await act(() => render(tools.renderToolPart(part, "live-read", dispatch), host));
    await act(() => { vi.advanceTimersByTime(800); });
    expect(host.querySelector(".is-dismissed")).not.toBeNull();
    await act(() => { vi.advanceTimersByTime(300); });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ kind: "ephemeral-tail-flush", toolCallId: "live-read" });
    expect(host.querySelector(".agent-ephemeral")).toBeNull();
    await act(() => render(null, host));
    expect(vi.getTimerCount()).toBe(0);
    dispatch.mockClear();
    await act(() => render(tools.renderToolPart(part, "live-read", dispatch), host));
    await act(() => render(null, host));
    await act(() => { vi.advanceTimersByTime(2000); });
    expect(dispatch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("waits for the SQL phase before revealing an early result", async () => {
    const { window } = parseHTML('<html><body><main></main></body></html>');
    vi.stubGlobal("window", window); vi.stubGlobal("document", window.document);
    const host = document.querySelector("main"), tools = createAgentToolRenderer();
    const part = { kind: "tool", tool: "run_sql", toolCallId: "sql", args: { sql: "SELECT 1" }, result: { kind: "sql.rows", columns: ["value"], rows: [[1]] } };
    async function seek(timeMs, resultAtMs) {
      await act(() => render(h(AgentReplayContext.Provider, { value: { timeMs, tools: { sql: { startAtMs: 0, resultAtMs, dismissAtMs: 2500 } } } }, tools.renderToolPart(part, "sql", () => {})), host));
      return host.querySelector(".agent-ephemeral-sql-rowblock .agent-ephemeral-stack").style.transform;
    }
    expect(await seek(175, 0)).toBe("translateY(18px)");
    expect(await seek(700, 0)).toBe("translateY(0px)");
    expect(await seek(900, 1000)).toBe("translateY(18px)");
    expect(await seek(1350, 1000)).toBe("translateY(0px)");
    await act(() => render(null, host));
  });
  it("accepts local source icons and rejects external or executable URLs", () => {
    const entries = { "example:one": { icon: "/portal/example.png", label: "Example" }, bad: { icon: "javascript:alert(1)" }, remote: "https://example.invalid/icon.png" };
    setSourceMeta(entries); entries["example:one"].icon = "/changed.png";
    expect(sourceIconUrl("example:one")).toBe("/portal/example.png");
    expect(sourceIconUrl("bad")).toBeNull();
    expect(sourceIconUrl("remote")).toBeNull();
  });
});
