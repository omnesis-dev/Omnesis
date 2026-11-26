// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { z } from "zod";
import { CAPABILITY_ROLES, readSecretTextFile, type CapabilityRole } from "@omnesis/core";
import { omnesisConfigSchema, type OmnesisConfig } from "@omnesis/config";
import { pauseDesktopRestoreModels } from "./restore-models.js";
import type { DesktopProfile } from "./environment.js";

export const DESKTOP_RESTORE_REVIEW_FILE = "desktop-restore-review.json";
/** Original policy parameters remain sealed for review, rather than running on restored history. */
export function pauseDesktopRestoreProcessing(
  config: OmnesisConfig,
  recordings = 0,
): {
  config: OmnesisConfig;
  review: DesktopRestoreReview;
} {
  const review: DesktopRestoreReview = {
    version: 1,
    modelAssignments: config.inference?.assignments ?? {},
    storageRetention: config.gateway?.storage?.retention ?? [],
    activityRetention: config.activityRetention ?? {},
  };
  return {
    review,
    config: pauseDesktopRestoreModels(
      omnesisConfigSchema.parse({
        ...config,
        activityRetention: {},
        ...(recordings > 0
          ? {
              inference: {
                ...config.inference,
                recordings: { ...config.inference?.recordings, restoreReviewRequired: true },
              },
            }
          : {}),
        gateway: { ...config.gateway, storage: { ...config.gateway?.storage, retention: [] } },
      }),
    ),
  };
}
export function desktopRestoreDeletionPaused(config: unknown): boolean {
  const parsed = omnesisConfigSchema.safeParse(config);
  if (!parsed.success) return false;
  return (
    parsed.data.activityRetention?.maxAge === undefined &&
    (parsed.data.gateway?.storage?.retention?.length ?? 0) === 0
  );
}

export interface DesktopRestoreReview {
  version: 1;
  modelAssignments: Partial<Record<CapabilityRole, string | null>>;
  storageRetention: Array<{ sourceId: string; maxAgeDays: number }>;
  activityRetention: { maxAge?: string };
}
export async function readDesktopRestoreReview(
  profile: DesktopProfile,
  dependencies: { read?: typeof readSecretTextFile } = {},
): Promise<DesktopRestoreReview | undefined> {
  const raw = await (dependencies.read ?? readSecretTextFile)(
    join(profile.configDir, DESKTOP_RESTORE_REVIEW_FILE),
    {
      backend: "macos-keychain",
      service: profile.secretService,
      configDir: profile.configDir,
    },
  );
  if (raw === null) return undefined;
  if (Buffer.byteLength(raw) > 1024 * 1024)
    throw new Error("The saved restore review is too large");
  const data = z
    .object({
      version: z.literal(1),
      modelAssignments: z.record(z.string(), z.union([z.string().max(4096), z.null()])),
      storageRetention: z.unknown(),
      activityRetention: z.unknown(),
    })
    .strict()
    .parse(JSON.parse(raw));
  if (
    Object.keys(data.modelAssignments).some(
      (role) => !CAPABILITY_ROLES.some((known) => known === role),
    )
  )
    throw new Error("The saved model review is not supported");
  const config = omnesisConfigSchema.parse({
    inference: { assignments: data.modelAssignments },
    gateway: { storage: { retention: data.storageRetention } },
    activityRetention: data.activityRetention,
  });
  const result: DesktopRestoreReview = {
    version: 1,
    modelAssignments: config.inference?.assignments ?? {},
    storageRetention: config.gateway?.storage?.retention ?? [],
    activityRetention: config.activityRetention ?? {},
  };
  return Buffer.byteLength(JSON.stringify(result)) <= 512 * 1024 ? result : undefined;
}

/** Config digest still binds the complete review; legacy intents without recording counts remain compatible. */
export function desktopRestoreRecordingsPaused(config: unknown, recordings: number): boolean {
  const parsed = omnesisConfigSchema.safeParse(config);
  return (
    parsed.success &&
    (recordings === 0 || parsed.data.inference?.recordings?.restoreReviewRequired === true)
  );
}
