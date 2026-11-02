// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A Docker install built from a checkout (`install.sh --docker --build`)
 * records its images as `<checkout version>-local`, never as a published tag.
 * These pin what `omnesis update` then makes of it: the local build is not
 * the published release of the same version, so the update moves the install
 * onto the published images rather than reporting it already up to date.
 */

import { describe, expect, test } from "vitest";
import { assertImageTag, assessDockerApplyEvidence } from "./update/detect.js";

const PROJECT = "/home/maya/.config/omnesis";

describe("a locally built Docker install meets omnesis update", () => {
  test("its tag is one an image reference and the env file accept", () => {
    expect(() => assertImageTag("0.7.3-local")).not.toThrow();
  });

  // The gateway built from a 0.7.3 checkout answers /health with 0.7.3, the
  // version the published release carries too.
  test("is not up to date with the published release of its own version", () => {
    const evidence = assessDockerApplyEvidence(PROJECT, "0.7.3-local", "0.7.3", null, "0.7.3");
    expect(evidence.complete).toBe(false);
    expect(evidence.previousTag).toBe("0.7.3-local");
  });

  test("an update record of the local build does not make it the release either", () => {
    const record = JSON.stringify({
      version: 1,
      method: "docker",
      projectDir: PROJECT,
      phase: "complete",
      tag: "0.7.3-local",
    });
    expect(
      assessDockerApplyEvidence(PROJECT, "0.7.3-local", "0.7.3", record, "0.7.3").complete,
    ).toBe(false);
  });
});
