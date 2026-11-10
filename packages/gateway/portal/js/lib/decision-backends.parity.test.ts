// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The portal has no build step, so it keeps its own copies of the decision
// backend name rule and the preset URL filling. These checks pin the copies
// to the config schema's and core's originals.

import { describe, expect, it } from "vitest";
import { RESERVED_DECISION_BACKEND_NAMES as CONFIG_RESERVED } from "@omnesis/config";
import { DECISION_PROVIDER_PRESETS, decisionUrlPlaceholders as coreUrlPlaceholders, fillDecisionPresetUrl } from "@omnesis/core";
import {
  RESERVED_DECISION_BACKEND_NAMES,
  decisionUrlPlaceholders,
  fillDecisionUrl,
  // @ts-expect-error — portal modules are plain JS.
} from "./decision-backends.js";

describe("decision backend helpers match the config schema and core", () => {
  it("reserves the same backend names as the config schema", () => {
    expect([...RESERVED_DECISION_BACKEND_NAMES].sort()).toEqual([...CONFIG_RESERVED].sort());
  });

  it("fills every preset's URL the way core does", () => {
    const values = ["0123456789abcdef", "my resource/with space", "a&b?c#d"];
    for (const preset of DECISION_PROVIDER_PRESETS) {
      for (const value of values) {
        const params = Object.fromEntries((preset.urlParams ?? []).map((p) => [p.key, value]));
        expect(fillDecisionUrl(preset, params), preset.id).toEqual({ url: fillDecisionPresetUrl(preset, params) });
      }
    }
  });

  it("refuses the same missing values as core", () => {
    for (const preset of DECISION_PROVIDER_PRESETS.filter((p) => p.urlParams?.length)) {
      expect(() => fillDecisionPresetUrl(preset, {})).toThrow();
      expect(fillDecisionUrl(preset, {}).error, preset.id).toBeTruthy();
    }
  });

  it("finds the same placeholders as core", () => {
    for (const url of ["https://{account}.example.com/{model-id}/run", "https://api.example.com/v1", "{a}{b}"]) {
      expect(decisionUrlPlaceholders(url)).toEqual(coreUrlPlaceholders(url));
    }
  });
});
