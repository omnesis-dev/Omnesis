// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { attachCaptureStatusListener } from "./content-status.js";

describe("capture status listener", () => {
  it("stops reporting an attached script after terminal teardown", () => {
    let listener:
      | ((message: unknown, sender: unknown, respond: (value: unknown) => void) => unknown)
      | undefined;
    const event = {
      addListener: vi.fn((candidate: typeof listener) => {
        listener = candidate;
      }),
      removeListener: vi.fn((candidate: typeof listener) => {
        if (listener === candidate) listener = undefined;
      }),
    };
    const respond = vi.fn();
    const detach = attachCaptureStatusListener(
      () => ({ state: "excluded" }),
      event as unknown as Parameters<typeof attachCaptureStatusListener>[1],
    );

    listener?.({ type: "capture-status" }, {}, respond);
    expect(respond).toHaveBeenCalledWith({ state: "excluded" });

    detach();
    detach();
    expect(listener).toBeUndefined();
    expect(event.removeListener).toHaveBeenCalledOnce();
  });

  it("makes invalid-context listener removal idempotent and non-throwing", () => {
    const event = {
      addListener: vi.fn(),
      removeListener: vi.fn(() => {
        throw new Error("Extension context invalidated.");
      }),
    };
    const detach = attachCaptureStatusListener(() => ({ state: "watching" }), event);

    expect(() => detach()).not.toThrow();
    expect(() => detach()).not.toThrow();
    expect(event.removeListener).toHaveBeenCalledOnce();
  });
});
