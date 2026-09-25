// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { PROVIDER_BRANDS } from "@omnesis/core";
import { PORTAL_PROVIDER_BRANDS } from "../portal/js/components/provider-brands-data.js";

// The portal keeps fallback labels for runtimes without a Models.dev logo.
// This guard catches label/identity drift without relying on bundled assets.
describe("provider brand fallback core ↔ portal drift guard", () => {
  it("covers the same brand IDs and labels", () => {
    expect(new Set(Object.keys(PORTAL_PROVIDER_BRANDS))).toEqual(
      new Set(Object.keys(PROVIDER_BRANDS)),
    );
    for (const [id, core] of Object.entries(PROVIDER_BRANDS)) {
      const portal = PORTAL_PROVIDER_BRANDS[id as keyof typeof PORTAL_PROVIDER_BRANDS];
      expect(portal?.id).toBe(core.id);
      expect(portal?.label).toBe(core.label);
    }
  });
});
