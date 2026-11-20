// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as core from "@omnesis/core";
import { describe, expect, test, vi } from "vitest";
import * as reaper from "./subprocess-reaper.js";
import {
  assertSyntheticGatewayVisibility,
  syntheticGatewayEnv,
  SyntheticE2EHarness,
  type SyntheticGatewayMode,
} from "./synth-harness.js";
import type { ChildProcess } from "node:child_process";

describe("SyntheticE2EHarness bootstrap reader ownership", () => {
  test.each(
    [undefined, new Error("invented reader cleanup failure")].flatMap((cleanupFailure) =>
      (["destroy", "crash-restart"] as const).map((operation) => ({ cleanupFailure, operation })),
    ),
  )(
    "retains independent reader uncertainty and refuses retry or fixture deletion during $operation",
    async ({ cleanupFailure, operation }) => {
      const root = mkdtempSync(join(tmpdir(), "invented-reader-hold-"));
      const failure = new Error("invented outer failure", {
        cause: Object.assign(new Error("invented reader failure"), { cleanupFailure }),
      });
      const read = vi.spyOn(core, "readSecretTextFile").mockRejectedValue(failure);
      const independentlyJoinedGateway = {} as ChildProcess;
      const stop = vi.spyOn(reaper, "killSubprocessGroup").mockResolvedValue();
      const harness = Object.assign(Object.create(SyntheticE2EHarness.prototype), {
        configDir: root,
        tempDir: root,
        devices: [],
        gatewayProcess: independentlyJoinedGateway,
      }) as SyntheticE2EHarness;
      const bootstrap = harness as unknown as { readGatewayToken(path: string): Promise<string> };
      try {
        await expect(bootstrap.readGatewayToken(join(root, "token"))).rejects.toBe(failure);
        await expect(bootstrap.readGatewayToken(join(root, "token"))).rejects.toBe(failure);
        expect(read).toHaveBeenCalledTimes(1);
        if (operation === "crash-restart") {
          await expect(harness.restartGateway({ signal: "SIGKILL" })).rejects.toBe(failure);
          expect(stop).toHaveBeenLastCalledWith(independentlyJoinedGateway, {
            initialSignal: "SIGKILL",
          });
          expect(existsSync(root)).toBe(true);
        }
        await expect(harness.destroy()).rejects.toBe(failure);
        expect(stop).toHaveBeenLastCalledWith(independentlyJoinedGateway, {
          initialSignal: "SIGTERM",
        });
        expect(stop).toHaveBeenCalledTimes(operation === "crash-restart" ? 2 : 1);
        expect(existsSync(root)).toBe(true);
      } finally {
        read.mockRestore();
        stop.mockRestore();
        // The mocked producer created no helper; only this owned fixture exists.
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

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

describe("SyntheticE2EHarness.pushDocuments", () => {
  test.each([
    { result: { rejectedSourceIds: ["fixture:source"] }, message: "lost its source write epoch" },
    {
      result: { rejected: [{ sourceId: "fixture:source", reason: "removed" }] },
      message: "fixture:source (removed)",
    },
    {
      result: { rejected: [{ sourceId: "fixture:source", reason: "paused" }] },
      message: "fixture:source (paused)",
    },
  ])("exposes rejected fixture writes: $message", async ({ result, message }) => {
    const harness = Object.create(SyntheticE2EHarness.prototype) as SyntheticE2EHarness;
    const gateway = vi
      .spyOn(harness, "gatewayJson")
      .mockResolvedValueOnce({ wipeEpoch: 7 })
      .mockResolvedValueOnce(result);
    await expect(
      harness.pushDocuments([
        { sourceId: "fixture:source", externalId: "one" },
        { sourceId: "fixture:source", externalId: "two" },
      ]),
    ).rejects.toThrow(message);
    expect(gateway).toHaveBeenCalledTimes(2);
    expect(gateway.mock.calls[0]?.[0]).toBe("/sync-state/fixture%3Asource");
    const body = JSON.parse(gateway.mock.calls[1]?.[1]?.body as string);
    expect(body.writeEpochs).toEqual({ "fixture:source": 7 });
    expect(body.documents).toHaveLength(2);
  });
  test("keeps intentional document tombstone suppression successful", async () => {
    const harness = Object.create(SyntheticE2EHarness.prototype) as SyntheticE2EHarness;
    vi.spyOn(harness, "gatewayJson")
      .mockResolvedValueOnce({ wipeEpoch: 7 })
      .mockResolvedValueOnce({ ingested: 0, suppressed: ["tombstoned-document"] });
    await expect(harness.pushDocument({ sourceId: "fixture:source" })).resolves.toBeUndefined();
  });
});
