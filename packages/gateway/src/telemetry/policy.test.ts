// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { telemetryForcedOff, telemetryRuntimeAllowed } from "./policy.js";
import { productionTelemetryTransport, isolatedTelemetryTestTransport } from "./service.js";

describe("production telemetry admission", () => {
  it.each([
    "https://telemetry.omnesis.app/v1/heartbeat",
    "http://telemetry.omnesis.app:80/v1/heartbeat",
    "http://127.0.0.1.example.com:80/v1/heartbeat",
    "http://user:password@127.0.0.1:1234/v1/heartbeat",
    "http://127.0.0.1:1234/other",
    "http://127.0.0.1:1234/v1/heartbeat?redirect=outside",
  ])("the isolated transport refuses nonlocal or ambiguous endpoints: %s", (endpoint) => {
    expect(
      isolatedTelemetryTestTransport({
        OMNESIS_RUNTIME_MODE: "test",
        OMNESIS_E2E_DISABLE_DEFAULT_RELAY: "1",
        OMNESIS_E2E_TELEMETRY_URL: endpoint,
      }),
    ).toBeUndefined();
  });

  it("the loopback test transport requires explicit test admission", () => {
    const env = {
      OMNESIS_RUNTIME_MODE: "test",
      OMNESIS_E2E_DISABLE_DEFAULT_RELAY: "1",
      OMNESIS_E2E_TELEMETRY_URL: "http://127.0.0.1:1234/v1/heartbeat",
    };
    expect(isolatedTelemetryTestTransport(env)).toBeDefined();
    expect(
      isolatedTelemetryTestTransport({ ...env, OMNESIS_RUNTIME_MODE: "production" }),
    ).toBeUndefined();
    expect(
      isolatedTelemetryTestTransport({ ...env, OMNESIS_E2E_DISABLE_DEFAULT_RELAY: undefined }),
    ).toBeUndefined();
  });
  it("requires an explicit production launch capability", () => {
    expect(telemetryRuntimeAllowed({ env: {} })).toBe(false);
    expect(
      telemetryRuntimeAllowed({
        env: { OMNESIS_RUNTIME_MODE: "production" },
        entryPath: "/opt/omnesis/src/index.ts",
      }),
    ).toBe(true);
  });

  it("cannot construct the production transport inside a test even with sanitized production env", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      expect(
        productionTelemetryTransport({
          OMNESIS_RUNTIME_MODE: "production",
          OMNESIS_TELEMETRY: "on",
        }),
      ).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { OMNESIS_RUNTIME_MODE: "test" },
    { OMNESIS_RUNTIME_MODE: "development" },
    { NODE_ENV: "test" },
    { NODE_ENV: "development" },
    { CI: "true" },
    { VITEST: "true" },
    { VITEST_WORKER_ID: "1" },
    { NODE_TEST_CONTEXT: "child-v8" },
    { OMNESIS_SYNTHETIC: "1" },
    { OMNESIS_SYNTHETIC: "true" },
    { OMNESIS_SYNTHETIC: "yes" },
    { OMNESIS_SYNTHETIC: "on" },
    { OMNESIS_DEMO: "1" },
    { OMNESIS_TEST_INSTANCE: "1" },
    { OMNESIS_E2E_DISABLE_RELEASE_CHECK: "1" },
  ])("never constructs a production transport for isolated runtime %j", (guard) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      expect(
        telemetryRuntimeAllowed({
          env: { OMNESIS_RUNTIME_MODE: "production", ...guard },
          entryPath: "/opt/omnesis/dist/index.js",
        }),
      ).toBe(false);
      expect(
        productionTelemetryTransport({
          OMNESIS_RUNTIME_MODE: "production",
          OMNESIS_TELEMETRY: "on",
          ...guard,
        }),
      ).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["off", "OFF", "false", "0", " no "])(
    "environment %s overrides enabled configuration",
    (value) => {
      expect(telemetryForcedOff({ OMNESIS_TELEMETRY: value })).toBe(true);
      expect(
        productionTelemetryTransport({
          OMNESIS_RUNTIME_MODE: "production",
          OMNESIS_TELEMETRY: value,
        }),
      ).toBeUndefined();
    },
  );
});
