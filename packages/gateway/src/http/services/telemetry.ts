// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { telemetryForcedOff, telemetryRuntimeAllowed } from "../../telemetry/policy.js";
import type { OmnesisConfig } from "@omnesis/config";

/** Only preferences and reporting availability are exposed; the local secret stays private. */
export function telemetryStatus(
  config: OmnesisConfig,
  options: { env?: NodeJS.ProcessEnv; entryPath?: string } = {},
) {
  const forcedDisabled = telemetryForcedOff(options.env);
  const runtimeAllowed = telemetryRuntimeAllowed(options);
  return {
    enabled: config.telemetry?.enabled !== false && !forcedDisabled && runtimeAllowed,
    configuredEnabled: config.telemetry?.enabled !== false,
    acknowledged: config.telemetry?.acknowledged === true,
    noticeShown: config.telemetry?.noticeShown === true,
    forcedDisabled,
    runtimeAllowed,
  };
}
