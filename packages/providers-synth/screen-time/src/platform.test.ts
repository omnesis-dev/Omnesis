// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import synthScreenTime from "./index.js";

describe("synth screen-time — cross-platform on the wire", () => {
  it("clears supportedPlatforms inherited from the real Screen Time provider", () => {
    // Real `defineStructuredSource` for Screen Time declares
    // `supportedPlatforms: ["darwin"]`. The synth file spreads `...rest`
    // from it, so the explicit override here keeps the synth descriptor
    // advertised on Linux/Windows CI hosts.
    expect(synthScreenTime.supportedPlatforms).toBeUndefined();
  });
});
