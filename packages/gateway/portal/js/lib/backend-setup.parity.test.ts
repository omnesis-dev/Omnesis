// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The portal has no build step, so it keeps its own copy of the preset
// decision URL filling. These checks pin the copy to core's original.

import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS, decisionUrlPlaceholders as coreUrlPlaceholders, fillDecisionPresetUrl } from "@omnesis/core";
import {
  decisionUrlPlaceholders,
  fillDecisionUrl,
  // @ts-expect-error — portal modules are plain JS.
} from "./backend-setup.js";

const withDecisions = PROVIDER_PRESETS.filter((preset) => preset.decision);

describe("backend setup helpers match core", () => {
  it("fills every preset's decision URL the way core does", () => {
    const values = ["0123456789abcdef", "my resource/with space", "a&b?c#d"];
    for (const preset of withDecisions) {
      for (const value of values) {
        const params = Object.fromEntries((preset.decision?.urlParams ?? []).map((p) => [p.key, value]));
        expect(fillDecisionUrl(preset.decision, params), preset.id).toEqual({ url: fillDecisionPresetUrl(preset, params) });
      }
    }
  });

  it("refuses the same missing values as core", () => {
    const parameterised = withDecisions.filter((p) => p.decision?.urlParams?.length);
    expect(parameterised.length).toBeGreaterThan(0);
    for (const preset of parameterised) {
      expect(() => fillDecisionPresetUrl(preset, {})).toThrow();
      expect(fillDecisionUrl(preset.decision, {}).error, preset.id).toBeTruthy();
    }
  });

  it("finds the same placeholders as core", () => {
    for (const url of ["https://{account}.example.com/{model-id}/run", "https://api.example.com/v1", "{a}{b}"]) {
      expect(decisionUrlPlaceholders(url)).toEqual(coreUrlPlaceholders(url));
    }
  });
});
