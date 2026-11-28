// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { z } from "zod";
import type { DesktopProfile } from "./environment.js";
import type { DesktopEnrollmentRole } from "./enrollment.js";
export const removalParams = z.object({ eraseData: z.boolean().optional() }).strict();
export const removeParams = removalParams
  .extend({ confirmationId: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const prepareParams = z
  .object({ mode: z.enum(["home", "joined"]), name: z.string().trim().min(1).max(80).optional() })
  .strict();
export const discoveryParams = z
  .object({
    intent: z.enum(["existing", "create"]).optional(),
    termsAccepted: z.boolean().optional(),
    invite: z.string().max(2048).optional(),
  })
  .strict();
export const healthSchema = z.object({ status: z.literal("ok") });

export function desktopSecretOptions(profile: DesktopProfile) {
  return {
    configDir: profile.configDir,
    service: profile.secretService,
    backend: "macos-keychain" as const,
  };
}
export function desktopPairPath(profile: DesktopProfile, role: DesktopEnrollmentRole): string {
  return join(
    profile.configDir,
    "cloud-relay",
    `${role === "interactive" ? "cli" : "collector"}-device.json`,
  );
}
