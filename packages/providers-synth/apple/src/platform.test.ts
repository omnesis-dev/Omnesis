// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import synthApple from "./index.js";

describe("synth apple — cross-platform on the wire", () => {
  it("clears supportedPlatforms inherited from the real Apple provider", () => {
    // The synth provider spreads `...rest` from the real Apple provider,
    // which declares `supportedPlatforms: ["darwin"]`. The synth file must
    // explicitly override that back to `undefined` so the synth e2e
    // descriptors are advertised on any host (Linux CI runners included).
    expect(synthApple.supportedPlatforms).toBeUndefined();
  });
});
