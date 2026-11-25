// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";

export const desktopRestoreSelectionSchema = z
  .object({
    path: z.string().min(1).max(4096),
    device: z.string().regex(/^\d+$/u),
    inode: z.string().regex(/^\d+$/u),
    bytes: z
      .number()
      .int()
      .positive()
      .safe()
      .max(1024 ** 4),
    mtimeSeconds: z.string().regex(/^\d+$/u),
    mtimeNanoseconds: z.string().regex(/^\d+$/u),
  })
  .strict();
const importId = z.string().uuid();
export const desktopRestoreImportSchema = z
  .object({ importId, selection: desktopRestoreSelectionSchema })
  .strict();
export const desktopRestorePreviewSchema = z
  .object({
    importId,
    recoveryCode: z.string().max(512).optional(),
    recoveryEnvelope: z.unknown().optional(),
  })
  .strict();
export const desktopRestoreApplySchema = z
  .object({ confirmationId: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict();
export const desktopRestoreCancelSchema = z.object({ importId }).strict();
export const desktopRestoreRecoverSchema = z.object({ operationId: z.string().uuid() }).strict();

export interface DesktopRestoreImportResult {
  kind: "desktopRestoreImport";
  importId: string;
  imported: true;
  bytes: number;
}
export type DesktopRestorePreview =
  | {
      kind: "desktopRestorePreview";
      importId: string;
      status: "needs-recovery-code";
      needsRecoveryCode: true;
      hasRecoveryEnvelope: boolean;
    }
  | {
      kind: "desktopRestorePreview";
      importId: string;
      status: "ready";
      needsRecoveryCode: false;
      hasRecoveryEnvelope: boolean;
      confirmationId: string;
      protection: "encrypted-payloads" | "plaintext" | "mixed";
      createdAt: string;
      version: string;
      includedData: string[];
      consequences: string[];
      summary: { documents: number; sources: number; watches: number; analyticsRows: number };
      willCreateRecoveryCopy: true;
    };
export interface DesktopRestoreResult {
  kind: "desktopRestoreResult";
  status: "restored";
  runtimeStopped: true;
  recoveryCopyRetained: true;
  sourcesPaused: number;
  watchesPaused: number;
}
export interface DesktopRestoreRecoveryResult {
  kind: "desktopRestoreResult";
  status: "rolled-back";
  runtimeStopped: true;
  recoveryCopyRetained: boolean;
}
export interface DesktopRestoreStatus {
  kind: "desktopRestoreStatus";
  status: "idle" | "pending" | "complete" | "rolled-back" | "recovery-required";
  canRecover: boolean;
  operationId?: string;
  recoveryCopyRetained: boolean;
}
