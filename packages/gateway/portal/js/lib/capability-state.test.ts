// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
// @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
import { isEnabled, isConfigured, capabilityCardState } from "./capability-state.js";

describe("capability-state", () => {
  it("treats a null/undefined assignment as off", () => {
    expect(isEnabled(undefined)).toBe(false);
    expect(isConfigured(null)).toBe(false);
    expect(capabilityCardState(undefined)).toBe("off");
  });

  it("disabled / unresolved are off (not configured)", () => {
    for (const kind of ["disabled", "unresolved"]) {
      expect(isEnabled({ kind })).toBe(false);
      expect(isConfigured({ kind })).toBe(false);
      expect(capabilityCardState({ kind })).toBe("off");
    }
  });

  it("replay is always enabled, regardless of availability", () => {
    expect(isEnabled({ kind: "replay" })).toBe(true);
    expect(capabilityCardState({ kind: "replay" })).toBe("on");
  });

  it("a configured-but-unavailable assignment warns (needs attention)", () => {
    const a = { kind: "local", available: false };
    expect(isEnabled(a)).toBe(false);
    expect(isConfigured(a)).toBe(true);
    expect(capabilityCardState(a)).toBe("warn");
  });

  it("a resolved and available assignment is on", () => {
    const a = { kind: "http", available: true };
    expect(isEnabled(a)).toBe(true);
    expect(isConfigured(a)).toBe(true);
    expect(capabilityCardState(a)).toBe("on");
  });
});
