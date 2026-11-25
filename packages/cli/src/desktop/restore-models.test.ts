// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { CAPABILITY_ROLES } from "@omnesis/core";
import { omnesisConfigSchema } from "@omnesis/config";
import { pauseDesktopRestoreModels, desktopRestoreModelsPaused } from "./restore-models.js";
import { desktopProfile } from "./environment.js";
import {
  readDesktopRestoreReview,
  pauseDesktopRestoreProcessing,
  desktopRestoreDeletionPaused,
} from "./restore-review.js";

test("explicitly disables every capability while retaining target backend connections and secret references", () => {
  const config = omnesisConfigSchema.parse({
    inference: {
      allowRemoteInference: true,
      backends: {
        scripted: {
          type: "http",
          url: "http://127.0.0.1:17601",
          apiKeySecret: "config-secret:invented-reference",
        },
      },
      assignments: { agent: "scripted/invented-model", embedder: "scripted/invented-embedder" },
    },
  });
  const result = pauseDesktopRestoreModels(config);
  expect(Object.keys(result.inference!.assignments!).sort()).toEqual([...CAPABILITY_ROLES].sort());
  expect(CAPABILITY_ROLES.every((role) => result.inference!.assignments![role] === null)).toBe(
    true,
  );
  expect(result.inference!.backends).toEqual(config.inference!.backends);
  expect(result.inference!.allowRemoteInference).toBe(true);
  expect(config.inference!.assignments!.agent).toBe("scripted/invented-model");
  expect(desktopRestoreModelsPaused(result)).toBe(true);
  expect(desktopRestoreModelsPaused({ inference: { assignments: { agent: null } } })).toBe(false);
});
test("pauses only automatic personal-history deletion and preserves its original parameters for sealed review", () => {
  const config = omnesisConfigSchema.parse({
    activityRetention: { maxAge: "14d" },
    dataRetention: { maxAge: "2y" },
    gateway: {
      storage: {
        maxDiskUsedPercent: 95,
        retention: [{ sourceId: "invented:one", maxAgeDays: 365 }],
      },
    },
    brain: { transcriptRetention: "3d" },
  });
  const result = pauseDesktopRestoreProcessing(config);
  expect(result.config.activityRetention).toEqual({});
  expect(result.config.gateway!.storage!.retention).toEqual([]);
  expect(result.config.gateway!.storage!.maxDiskUsedPercent).toBe(95);
  expect(result.config.brain!.transcriptRetention).toBe("3d");
  expect(result.config.dataRetention).toEqual({ maxAge: "2y" });
  expect(result.review).toMatchObject({
    activityRetention: { maxAge: "14d" },
    storageRetention: [{ sourceId: "invented:one", maxAgeDays: 365 }],
  });
  expect(desktopRestoreDeletionPaused(result.config)).toBe(true);
  expect(desktopRestoreDeletionPaused(config)).toBe(false);
});

test("optional previous-choice projection is bounded below the private bridge frame limit", async () => {
  const profile = desktopProfile("/invented/restore-review-home"),
    review = {
      version: 1,
      modelAssignments: { agent: "scripted/invented-model" },
      storageRetention: [{ sourceId: "invented:one", maxAgeDays: 365 }],
      activityRetention: { maxAge: "14d" },
    };
  const read = vi.fn(async () => JSON.stringify(review));
  expect(await readDesktopRestoreReview(profile, { read })).toEqual(review);
  expect(read.mock.calls[0]).toEqual([
    expect.stringContaining("desktop-restore-review.json"),
    { backend: "macos-keychain", service: profile.secretService, configDir: profile.configDir },
  ]);
  const large = {
    ...review,
    storageRetention: Array.from({ length: 1000 }, (_, i) => ({
      sourceId: `invented-${i}-`.padEnd(512, "x"),
      maxAgeDays: 365,
    })),
  };
  const serialized = JSON.stringify(large);
  expect(Buffer.byteLength(serialized)).toBeGreaterThan(512 * 1024);
  expect(await readDesktopRestoreReview(profile, { read: async () => serialized })).toBeUndefined();
  expect(serialized).toBe(JSON.stringify(large));
});
