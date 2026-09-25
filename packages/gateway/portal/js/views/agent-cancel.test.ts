// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";

import {
  AgentActionError,
  agentRequestIsCurrent,
  requestAgentCancel,
  settleAgentTerminal,
} from "./agent.js";

describe("AgentActionError", () => {
  it("renders an alert and exposes a dismiss action", async () => {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><div id='host'></div></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    const host = parsed.document.querySelector("#host") as unknown as HTMLElement;
    try {
      const onDismiss = vi.fn();
      await act(async () => {
        render(
          h(AgentActionError, { message: "Stop failed. Connection interrupted", onDismiss }),
          host,
        );
      });

      expect(host.querySelector('[role="alert"]')?.textContent).toContain("Stop failed");
      const button = host.querySelector('button[aria-label="Dismiss stop error"]');
      expect(button).not.toBeNull();
      await act(async () =>
        button?.dispatchEvent(new parsed.window.Event("click", { bubbles: true })),
      );
      expect(onDismiss).toHaveBeenCalledOnce();
      render(null, host);
    } finally {
      globalThis.document = originalDocument;
      globalThis.window = originalWindow;
    }
  });
});

describe("agentRequestIsCurrent", () => {
  it("rejects a delayed result after another same-session operation wins", () => {
    expect(agentRequestIsCurrent(3, 4, "session-1", "session-1")).toBe(false);
  });

  it("rejects a delayed result after switching conversations", () => {
    expect(agentRequestIsCurrent(3, 3, "session-1", "session-2")).toBe(false);
  });

  it("accepts only the operation that still owns the active session", () => {
    expect(agentRequestIsCurrent(4, 4, "session-1", "session-1")).toBe(true);
  });

  it("keeps a send acknowledgment current when its terminal arrives first", () => {
    const sendGeneration = 4;
    const sendGenerationRef = { current: sendGeneration };
    const cancelGenerationRef = { current: 7 };

    settleAgentTerminal(cancelGenerationRef);

    expect(cancelGenerationRef.current).toBe(8);
    expect(
      agentRequestIsCurrent(
        sendGeneration,
        sendGenerationRef.current,
        "session-1",
        "session-1",
      ),
    ).toBe(true);
  });
});

describe("requestAgentCancel", () => {
  it("resolves only after the gateway confirms cancellation", async () => {
    const cancel = vi.fn().mockResolvedValue({ ok: true });

    await expect(requestAgentCancel({ cancel }, "session-1")).resolves.toEqual({ ok: true });
    expect(cancel).toHaveBeenCalledWith("session-1");
  });

  it("rejects an unconfirmed cancellation response", async () => {
    const cancel = vi.fn().mockResolvedValue({ ok: false });

    await expect(requestAgentCancel({ cancel }, "session-1")).rejects.toThrow(
      "The gateway did not confirm the stop request.",
    );
  });

  it("preserves a transport failure for the caller to surface", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("Connection interrupted"));

    await expect(requestAgentCancel({ cancel }, "session-1")).rejects.toThrow(
      "Connection interrupted",
    );
  });
});
