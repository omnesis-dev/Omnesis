// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import type { DesktopCollectorRestartResult } from "./collector-restart.js";
import type { DesktopRetentionCommand } from "./coordinator-retention.js";
import type { DesktopRecoveryCleanupResult } from "./coordinator-retention-cleanup.js";
import type { DesktopRecoveryCopiesCatalog } from "./snapshot-retention-catalog.js";
import type { DesktopFreshInstallCommand } from "./coordinator-fresh-install.js";
import type { DesktopFreshInstallPreview, DesktopFreshInstallResult } from "./fresh-install.js";
import type { DesktopConnection } from "./gateway-access.js";
import type { DesktopSearchModel } from "./search-model.js";
import type { DesktopRetirement } from "./retirement.js";
import type { DesktopRecoveryImportOutcome } from "./recovery-import.js";
import type { DesktopRecoveryStatus, DesktopRecoveryDraft } from "./recovery.js";
import type { DesktopRemovalPlan, DesktopRemovalResult } from "./removal.js";
import type { DesktopProtocolRequest } from "./protocol.js";
import type { DesktopRestoreCommand, DesktopRestoreReply } from "./restore-contract.js";
import type { DesktopUpdateCommand, DesktopUpdateResult } from "./update-controller.js";
import type { DesktopRemoteRoute } from "./remote-route.js";

export interface DesktopStorageAdmission {
  state: "ready" | "checking" | "blocked" | "unavailable";
  message: string;
  /** Server measurement expiry, Unix milliseconds; never retain ready past it. */
  validUntil?: number;
}

const storageTimestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
const storageStatusSchema = z.object({
  storagePressure: z.object({
    state: z.enum(["normal", "warning", "blocked", "unknown"]),
    measuredAt: storageTimestamp.nullable(),
    validUntil: storageTimestamp,
    policy: z.object({ measurementMaxAgeMs: z.number().int().positive().safe() }),
  }),
});

/** Home and gateway share a clock; preserve the server's admission policy and expiry. */
export function desktopStorageAdmission(value: unknown, now = Date.now()): DesktopStorageAdmission {
  const unavailable: DesktopStorageAdmission = {
    state: "unavailable",
    message: "Storage capacity cannot be verified. Open Settings → Storage to check again.",
  };
  const parsed = storageStatusSchema.safeParse(value);
  if (!parsed.success || !Number.isSafeInteger(now)) return unavailable;
  const pressure = parsed.data.storagePressure;
  if (pressure.measuredAt === null)
    return pressure.state === "unknown" && pressure.validUntil === 0
      ? { state: "checking", message: "Your library's storage capacity is being checked." }
      : unavailable;
  if (
    pressure.measuredAt > now ||
    pressure.validUntil !== pressure.measuredAt + pressure.policy.measurementMaxAgeMs ||
    now >= pressure.validUntil ||
    pressure.state === "unknown"
  )
    return unavailable;
  if (pressure.state === "blocked")
    return {
      state: "blocked",
      validUntil: pressure.validUntil,
      message:
        "New information is paused to protect storage. Open Settings → Storage. Search remains available.",
    };
  return {
    state: "ready",
    validUntil: pressure.validUntil,
    message:
      pressure.state === "warning"
        ? "Storage is running low. Review Settings → Storage; collection can continue."
        : "Storage has room for new information.",
  };
}

export interface DesktopState {
  /** Opaque owned-install generation identity; pairing repair does not change it. */
  installationId?: string;
  homeName?: string;
  phase: "welcome" | "accountRequired" | "chooseHome" | "preparing" | "ready" | "waiting" | "error";
  mode?: "home" | "joined";
  message?: string;
  connection?: DesktopConnection & { deviceId?: string; collectorDeviceId?: string };
  encrypted?: boolean;
  signup?: { policy?: "invite" | "open"; acmeTermsUrl?: string };
  searchModel?: DesktopSearchModel;
  /** Authoritative home-library growth admission; does not gate existing reads. */
  storageAdmission?: DesktopStorageAdmission;
  /** Home secure remote-route evidence, independent of linkage and optional assistant connections. */
  remoteRoute?: DesktopRemoteRoute;
  retired?: true;
  retirement?: Pick<DesktopRetirement, "mode" | "phase">;
}
export type DesktopStateCommand = Exclude<
  DesktopProtocolRequest["command"],
  | "restartCollector"
  | "removePreview"
  | "remove"
  | "recoveryImport"
  | "recoveryStatus"
  | "recoveryPrepare"
  | "recoveryCommit"
  | "recoveryCancel"
  | DesktopUpdateCommand
  | DesktopFreshInstallCommand
  | DesktopRestoreCommand
  | DesktopRetentionCommand
>;
export type DesktopCoordinatorResult =
  | DesktopState
  | DesktopCollectorRestartResult
  | DesktopFreshInstallPreview
  | DesktopFreshInstallResult
  | DesktopRestoreReply
  | DesktopUpdateResult
  | DesktopRecoveryCopiesCatalog
  | DesktopRecoveryCleanupResult
  | DesktopRemovalPlan
  | DesktopRemovalResult
  | DesktopRecoveryImportOutcome
  | DesktopRecoveryStatus
  | DesktopRecoveryDraft
  | { saved: true }
  | { cancelled: true };
