// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `@omnesis/core/doctor` — the shared Omnesis health check.
 *
 * The CLI and gateway fold gateway-host data, while a paired collector folds
 * evidence from its own host in response to a device command. Every producer
 * runs the same pure `evaluateDoctor()` with an explicit target, so gateway-
 * only concerns are N/A on a collector rather than warnings invented from
 * missing gateway-shaped data.
 *
 * The narrow wire-shape mirrors live behind this subpath rather than the
 * package root: they are deliberately partial views of specific gateway
 * responses, and several of their names (`SourceEntry`, `DeviceEntry`)
 * would collide with the richer domain types the root barrel exports.
 */

export { evaluateDoctor, PROCESS_VITALS_WINDOW_SECONDS } from "../doctor/checks.js";
export { collectSecurityData } from "../doctor/security.js";
export type { CollectSecurityOptions, SecurityCommandRunner } from "../doctor/security.js";
export {
  collectSecurityDataInWorker,
  SECURITY_SCAN_TIMEOUT_MS,
} from "../doctor/security-worker.js";
export type { CollectSecurityDataInWorkerOptions } from "../doctor/security-worker.js";
export {
  doctorReportSchema,
  MAX_DOCTOR_CHECKS,
  MAX_DOCTOR_CHECK_ID_LENGTH,
  MAX_DOCTOR_SECTION_LENGTH,
  MAX_DOCTOR_MESSAGE_LENGTH,
  MAX_DOCTOR_HINT_LENGTH,
} from "../doctor/schema.js";

export type {
  CheckStatus,
  DoctorTarget,
  DoctorCheck,
  DoctorReport,
  DoctorData,
  DoctorLocalStore,
  SecurityData,
  SecurityDiskEncryptionStatus,
  SecurityGatewayIsolation,
  SecurityKeyringData,
  SecurityPermissionEntry,
  SecurityRecoveryEscrowStatus,
  SecurityServiceDirective,
  SecurityServiceUnit,
  WhoAmIResult,
  ConfigResult,
  ConfigStatusResult,
  DeviceEntry,
  SourceEntry,
  SyncStatusEntry,
  ModelsResult,
  SystemInfoResult,
  IndexStatsResult,
  SweepsResult,
  DiskUsageSnapshot,
  DiskUsageStore,
  OverallStatusResult,
  ProcessVitalsResult,
} from "../doctor/types.js";
