// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import {
  assertSyntheticGatewayVisibility,
  syntheticGatewayEnv,
  SyntheticE2EHarness,
  type SyntheticGatewayMode,
} from "./synth-harness.js";

describe("SyntheticE2EHarness gateway mode", () => {
  test.each<
    [SyntheticGatewayMode, { OMNESIS_SYNTHETIC: "0" | "1"; OMNESIS_EXPERIMENTAL: "0" | "1" }]
  >([
    ["stable", { OMNESIS_SYNTHETIC: "0", OMNESIS_EXPERIMENTAL: "0" }],
    ["experimental", { OMNESIS_SYNTHETIC: "0", OMNESIS_EXPERIMENTAL: "1" }],
    ["synthetic", { OMNESIS_SYNTHETIC: "1", OMNESIS_EXPERIMENTAL: "0" }],
    ["synthetic-experimental", { OMNESIS_SYNTHETIC: "1", OMNESIS_EXPERIMENTAL: "1" }],
  ])("makes %s authoritative over ambient feature gates", (gatewayMode, expected) => {
    const base = {
      OMNESIS_SYNTHETIC: "ambient-synthetic",
      OMNESIS_EXPERIMENTAL: "ambient-experimental",
      KEEP_ME: "yes",
    };

    expect(syntheticGatewayEnv(base, gatewayMode)).toMatchObject({ ...expected, KEEP_ME: "yes" });
    expect(base).toMatchObject({
      OMNESIS_SYNTHETIC: "ambient-synthetic",
      OMNESIS_EXPERIMENTAL: "ambient-experimental",
    });
  });

  test("rejects a missing or unknown mode before the harness allocates state", () => {
    expect(() => Reflect.construct(SyntheticE2EHarness, [])).toThrow(
      /requires an explicit gatewayMode.*cannot inherit feature gates implicitly/s,
    );
    expect(() => Reflect.construct(SyntheticE2EHarness, [{ gatewayMode: "ambient" }])).toThrow(
      /requires an explicit gatewayMode.*got ambient/s,
    );
  });

  test.each(["OMNESIS_SYNTHETIC", "OMNESIS_EXPERIMENTAL"])(
    "rejects %s in extraGatewayEnv",
    (key) => {
      expect(() =>
        Reflect.construct(SyntheticE2EHarness, [
          { gatewayMode: "stable", extraGatewayEnv: { [key]: "1" } },
        ]),
      ).toThrow(`extraGatewayEnv cannot set ${key}; use gatewayMode instead`);
    },
  );

  test("points a health mismatch at the harness environment", () => {
    expect(() => assertSyntheticGatewayVisibility("stable", true)).toThrow(
      /Expected stable gateway.*OMNESIS_SYNTHETIC=0.*OMNESIS_EXPERIMENTAL=0.*health\.experimental=true.*check the harness environment, not the product/s,
    );
  });
});

describe("SyntheticE2EHarness.syncAllSources", () => {
  test("starts every registered source concurrently with the full-universe default budget", async () => {
    const harness = Object.create(SyntheticE2EHarness.prototype) as SyntheticE2EHarness;
    vi.spyOn(harness, "getSourceIds").mockReturnValue(["source:a", "source:b"]);

    const pendingResolvers: Array<() => void> = [];
    const trigger = vi.spyOn(harness, "triggerSyncAndWait").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          pendingResolvers.push(resolve);
        }),
    );

    const syncing = harness.syncAllSources();

    expect(trigger).toHaveBeenCalledTimes(2);
    expect(trigger).toHaveBeenNthCalledWith(1, "source:a", 90_000);
    expect(trigger).toHaveBeenNthCalledWith(2, "source:b", 90_000);
    expect(pendingResolvers).toHaveLength(2);

    for (const resolve of pendingResolvers) resolve();
    await syncing;
  });
});
