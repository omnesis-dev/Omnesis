// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { detectDocumentIngestionContext } from "./phone-region.js";

describe("detectDocumentIngestionContext", () => {
  test("uses macOS AppleLocale ahead of a conflicting daemon locale", () => {
    expect(
      detectDocumentIngestionContext({
        platform: "darwin",
        env: { LANG: "en_US.UTF-8" },
        runtimeLocale: () => "en-US",
        readMacOsLocale: () => "en_GB",
      }),
    ).toEqual({ locale: "en-GB", phoneRegion: "GB", phoneRegionSource: "os" });
  });

  test("accepts Apple locale modifiers and quoted defaults output", () => {
    const detected = detectDocumentIngestionContext({
      platform: "darwin",
      env: {},
      runtimeLocale: () => "en-US",
      readMacOsLocale: () => '"fr_FR@calendar=gregorian"\n',
    });
    expect(detected).toMatchObject({ locale: "fr-FR", phoneRegion: "FR", phoneRegionSource: "os" });
  });

  test("uses LC_TELEPHONE before the general Linux locale", () => {
    const detected = detectDocumentIngestionContext({
      platform: "linux",
      env: { LC_TELEPHONE: "fr_FR.UTF-8", LANG: "en_US.UTF-8" },
      runtimeLocale: () => "en-US",
    });
    expect(detected).toMatchObject({ phoneRegion: "FR", phoneRegionSource: "environment" });
  });

  test("supports an explicit headless-host override", () => {
    const detected = detectDocumentIngestionContext({
      platform: "linux",
      env: { OMNESIS_PHONE_REGION: "gb", LANG: "en_US.UTF-8" },
      runtimeLocale: () => "en-US",
    });
    expect(detected).toMatchObject({ phoneRegion: "GB", phoneRegionSource: "override" });
  });

  test("ignores invalid overrides and falls through safely", () => {
    const detected = detectDocumentIngestionContext({
      platform: "linux",
      env: { OMNESIS_PHONE_REGION: "ZZ", LANG: "C" },
      runtimeLocale: () => "en-CA",
    });
    expect(detected).toMatchObject({ phoneRegion: "CA", phoneRegionSource: "runtime" });
  });

  test("uses a deterministic final fallback when no region exists", () => {
    expect(
      detectDocumentIngestionContext({
        platform: "linux",
        env: { LANG: "C" },
        runtimeLocale: () => "en",
      }),
    ).toEqual({ locale: "en", phoneRegion: "US", phoneRegionSource: "fallback" });
  });
});
