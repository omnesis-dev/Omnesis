// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { CAPABILITY_METADATA, CAPABILITY_ROLES } from "@omnesis/core";
// @ts-expect-error — portal is plain JS, no .d.ts ships alongside.
import { hasCapabilityGlyph } from "../portal/js/components/capability-icon.js";

// Drift guard: every capability's `icon` slug (declared in core's
// CAPABILITY_METADATA) must have a real glyph in the portal's CapabilityIcon
// component. Without this, adding a capability with a new icon slug — or
// renaming one — silently falls back to the neutral dot in the card grid.
describe("capability icon coverage", () => {
  it("every CAPABILITY_METADATA icon slug has a portal glyph", () => {
    for (const role of CAPABILITY_ROLES) {
      const slug = CAPABILITY_METADATA[role].icon;
      expect(hasCapabilityGlyph(slug), `${role} → "${slug}"`).toBe(true);
    }
  });
});
