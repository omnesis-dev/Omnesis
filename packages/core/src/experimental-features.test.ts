// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEV_MODE_ENV_VAR,
  EXPERIMENTAL_ENV_VAR,
  devModeEnabled,
  experimentalEnabled,
  experimentalVisible,
} from "./experimental-features.js";

describe("experimentalEnabled", () => {
  const original = process.env[EXPERIMENTAL_ENV_VAR];
  const originalSynth = process.env.OMNESIS_SYNTHETIC;

  beforeEach(() => {
    delete process.env[EXPERIMENTAL_ENV_VAR];
    delete process.env.OMNESIS_SYNTHETIC;
  });
  afterEach(() => {
    if (original === undefined) delete process.env[EXPERIMENTAL_ENV_VAR];
    else process.env[EXPERIMENTAL_ENV_VAR] = original;
    if (originalSynth === undefined) delete process.env.OMNESIS_SYNTHETIC;
    else process.env.OMNESIS_SYNTHETIC = originalSynth;
  });

  it("is off when the env var is unset or empty", () => {
    expect(experimentalEnabled()).toBe(false);
    process.env[EXPERIMENTAL_ENV_VAR] = "";
    expect(experimentalEnabled()).toBe(false);
    process.env[EXPERIMENTAL_ENV_VAR] = "   ";
    expect(experimentalEnabled()).toBe(false);
  });

  it("is on for the on-sentinels", () => {
    for (const v of ["1", "true", "TRUE", "all", "All", "*", "yes", "on", " On "]) {
      process.env[EXPERIMENTAL_ENV_VAR] = v;
      expect(experimentalEnabled(), v).toBe(true);
    }
  });

  it("is off for explicit negations and unrecognized values", () => {
    for (const v of ["0", "false", "FALSE", "off", "no", "none", "triggers", "1,2", "maybe"]) {
      process.env[EXPERIMENTAL_ENV_VAR] = v;
      expect(experimentalEnabled(), v).toBe(false);
    }
  });

  it("reads the env var fresh on every call (no caching)", () => {
    expect(experimentalEnabled()).toBe(false);
    process.env[EXPERIMENTAL_ENV_VAR] = "1";
    expect(experimentalEnabled()).toBe(true);
    delete process.env[EXPERIMENTAL_ENV_VAR];
    expect(experimentalEnabled()).toBe(false);
  });
});

describe("experimentalVisible", () => {
  const original = process.env[EXPERIMENTAL_ENV_VAR];
  const originalSynth = process.env.OMNESIS_SYNTHETIC;

  beforeEach(() => {
    delete process.env[EXPERIMENTAL_ENV_VAR];
    delete process.env.OMNESIS_SYNTHETIC;
  });
  afterEach(() => {
    if (original === undefined) delete process.env[EXPERIMENTAL_ENV_VAR];
    else process.env[EXPERIMENTAL_ENV_VAR] = original;
    if (originalSynth === undefined) delete process.env.OMNESIS_SYNTHETIC;
    else process.env.OMNESIS_SYNTHETIC = originalSynth;
  });

  it("is true when experimental mode is on", () => {
    process.env[EXPERIMENTAL_ENV_VAR] = "1";
    expect(experimentalVisible()).toBe(true);
  });

  it("is true under synthetic mode even when experimental mode is off", () => {
    process.env.OMNESIS_SYNTHETIC = "1";
    expect(experimentalEnabled()).toBe(false);
    expect(experimentalVisible()).toBe(true);
  });

  it("is false when both are off", () => {
    expect(experimentalVisible()).toBe(false);
  });
});

describe("devModeEnabled", () => {
  const original = process.env[DEV_MODE_ENV_VAR];

  beforeEach(() => {
    delete process.env[DEV_MODE_ENV_VAR];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[DEV_MODE_ENV_VAR];
    else process.env[DEV_MODE_ENV_VAR] = original;
  });

  it("is off when the env var is unset or empty", () => {
    expect(devModeEnabled()).toBe(false);
    process.env[DEV_MODE_ENV_VAR] = "   ";
    expect(devModeEnabled()).toBe(false);
  });

  it("is on for the on-sentinels and off for negations", () => {
    for (const v of ["1", "true", "on", "yes"]) {
      process.env[DEV_MODE_ENV_VAR] = v;
      expect(devModeEnabled(), v).toBe(true);
    }
    for (const v of ["0", "false", "off", "maybe"]) {
      process.env[DEV_MODE_ENV_VAR] = v;
      expect(devModeEnabled(), v).toBe(false);
    }
  });

  it("is independent of experimental / synthetic mode", () => {
    process.env[EXPERIMENTAL_ENV_VAR] = "1";
    process.env.OMNESIS_SYNTHETIC = "1";
    try {
      expect(devModeEnabled()).toBe(false);
    } finally {
      delete process.env[EXPERIMENTAL_ENV_VAR];
      delete process.env.OMNESIS_SYNTHETIC;
    }
  });

  it("reads the env var fresh on every call (no caching)", () => {
    expect(devModeEnabled()).toBe(false);
    process.env[DEV_MODE_ENV_VAR] = "1";
    expect(devModeEnabled()).toBe(true);
    delete process.env[DEV_MODE_ENV_VAR];
    expect(devModeEnabled()).toBe(false);
  });
});
