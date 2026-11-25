// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DesktopConnection } from "./gateway-access.js";
import type { DesktopSearchModel } from "./search-model.js";
import type { DesktopRetirement } from "./retirement.js";
import type { DesktopRecoveryImportOutcome } from "./recovery-import.js";
import type { DesktopRecoveryStatus, DesktopRecoveryDraft } from "./recovery.js";
import type { DesktopRemovalPlan, DesktopRemovalResult } from "./removal.js";
import type { DesktopProtocolRequest } from "./protocol.js";
import type { DesktopUpdateCommand, DesktopUpdateResult } from "./update-controller.js";

export interface DesktopState {
  homeName?: string;
  phase: "welcome" | "accountRequired" | "chooseHome" | "preparing" | "ready" | "waiting" | "error";
  mode?: "home" | "joined";
  message?: string;
  connection?: DesktopConnection & { deviceId?: string; collectorDeviceId?: string };
  encrypted?: boolean;
  signup?: { policy?: "invite" | "open"; acmeTermsUrl?: string };
  searchModel?: DesktopSearchModel;
  retired?: true;
  retirement?: Pick<DesktopRetirement, "mode" | "phase">;
}
export type DesktopStateCommand = Exclude<
  DesktopProtocolRequest["command"],
  | "removePreview"
  | "remove"
  | "recoveryImport"
  | "recoveryStatus"
  | "recoveryPrepare"
  | "recoveryCommit"
  | "recoveryCancel"
  | DesktopUpdateCommand
>;
export type DesktopCoordinatorResult =
  | DesktopState
  | DesktopUpdateResult
  | DesktopRemovalPlan
  | DesktopRemovalResult
  | DesktopRecoveryImportOutcome
  | DesktopRecoveryStatus
  | DesktopRecoveryDraft
  | { saved: true }
  | { cancelled: true };
