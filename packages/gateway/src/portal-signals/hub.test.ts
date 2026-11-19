// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { PortalSignals, PortalSignalsFull } from "./hub.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("PortalSignals", () => {
  test("each listener hears a topic once per tick however often it was published", async () => {
    const signals = new PortalSignals();
    const a = vi.fn();
    const b = vi.fn();
    signals.subscribe(a);
    signals.subscribe(b);
    signals.publish("devices");
    signals.publish("devices");
    signals.publish("access");
    expect(a).not.toHaveBeenCalled();
    await tick();
    expect(a.mock.calls).toEqual([["devices"], ["access"]]);
    expect(b.mock.calls).toEqual([["devices"], ["access"]]);
    signals.publish("devices");
    await tick();
    expect(a).toHaveBeenCalledTimes(3);
  });

  test("an unsubscribed listener hears nothing more, and one failing listener spares the rest", async () => {
    const signals = new PortalSignals();
    const failing = vi.fn(() => {
      throw new Error("socket gone");
    });
    const kept = vi.fn();
    const gone = vi.fn();
    signals.subscribe(failing);
    signals.subscribe(kept);
    signals.subscribe(gone)();
    signals.publish("answers");
    await tick();
    expect(failing).toHaveBeenCalledWith("answers");
    expect(kept).toHaveBeenCalledWith("answers");
    expect(gone).not.toHaveBeenCalled();
  });

  test("refuses a listener past its limit, and makes room when one leaves", () => {
    const signals = new PortalSignals({ maxListeners: 2 });
    const first = signals.subscribe(() => {});
    signals.subscribe(() => {});
    expect(signals.hasRoom()).toBe(false);
    expect(() => signals.subscribe(() => {})).toThrow(PortalSignalsFull);
    first();
    expect(signals.hasRoom()).toBe(true);
  });
});
