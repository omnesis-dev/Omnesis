// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { CAPABILITY_ROLES } from "@omnesis/core";
import { omnesisConfigSchema, type OmnesisConfig } from "@omnesis/config";

/** Keep this Mac's connections while preventing any inference on newly imported data. */
export function pauseDesktopRestoreModels(config: OmnesisConfig): OmnesisConfig {
  return omnesisConfigSchema.parse({
    ...config,
    inference: {
      ...config.inference,
      assignments: Object.fromEntries(CAPABILITY_ROLES.map((role) => [role, null])),
      ...(config.inference?.recordings?.selfVoice === "match"
        ? { recordings: { ...config.inference.recordings, selfVoice: "off" } }
        : {}),
    },
  });
}
export function desktopRestoreModelsPaused(config: unknown): boolean {
  const parsed = omnesisConfigSchema.safeParse(config);
  if (!parsed.success) return false;
  return (
    CAPABILITY_ROLES.every((role) => parsed.data.inference?.assignments?.[role] === null) &&
    (parsed.data.inference?.recordings?.selfVoice ?? "off") === "off"
  );
}
