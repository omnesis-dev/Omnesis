// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { telemetryStatus } from "./telemetry.js";

describe("portal telemetry preferences", () => {
  const production = {
    env: { OMNESIS_RUNTIME_MODE: "production" },
    entryPath: "/opt/omnesis/gateway.js",
  };

  test("defaults enabled in production and acknowledgement survives preferences", () => {
    expect(telemetryStatus({}, production)).toMatchObject({ enabled: true, acknowledged: false });
    expect(
      telemetryStatus({ telemetry: { enabled: true, acknowledged: true } }, production),
    ).toMatchObject({ enabled: true, acknowledged: true });
    expect(
      telemetryStatus({ telemetry: { enabled: false, acknowledged: false } }, production),
    ).toMatchObject({ enabled: false, configuredEnabled: false });
  });

  test.each(["off", "false", "0", "no", " OFF "])(
    "environment %s wins over enabled config",
    (value) => {
      expect(
        telemetryStatus(
          { telemetry: { enabled: true } },
          {
            ...production,
            env: { ...production.env, OMNESIS_TELEMETRY: value },
          },
        ),
      ).toMatchObject({ enabled: false, configuredEnabled: true, forcedDisabled: true });
    },
  );

  test("tests and development never receive a telemetry notice", () => {
    for (const env of [
      {},
      { OMNESIS_RUNTIME_MODE: "development" },
      { ...production.env, VITEST: "true" },
    ]) {
      expect(
        telemetryStatus({ telemetry: { enabled: true } }, { ...production, env }),
      ).toMatchObject({ enabled: false, runtimeAllowed: false });
    }
  });
});
