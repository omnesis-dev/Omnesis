// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { assertNever } from "@omnesis/core";
import { z } from "zod";
import { DesktopRestoreFailure } from "./restore-errors.js";
import { DesktopRestoreTransactionError } from "./restore-transaction.js";
import {
  desktopRestoreApplySchema,
  desktopRestoreCancelSchema,
  desktopRestoreImportSchema,
  desktopRestorePreviewSchema,
  desktopRestoreRecoverSchema,
  type DesktopRestoreCommand,
  type DesktopRestoreReply,
} from "./restore-contract.js";
import type { DesktopBackupRestoreService } from "./restore-service.js";

export function isDesktopRestoreCommand(command: string): command is DesktopRestoreCommand {
  return [
    "restorePrepareImport",
    "restoreImport",
    "restorePreview",
    "restoreApply",
    "restoreImportCancel",
    "restoreStatus",
    "restoreRecover",
  ].includes(command);
}
export async function handleDesktopRestore(
  service: DesktopBackupRestoreService,
  command: DesktopRestoreCommand,
  params: unknown,
  signal: AbortSignal,
  closeTransport: () => Promise<void>,
): Promise<DesktopRestoreReply> {
  try {
    switch (command) {
      case "restorePrepareImport":
        z.object({})
          .strict()
          .parse(params ?? {});
        return await service.prepare(signal);
      case "restoreImport": {
        const input = desktopRestoreImportSchema.parse(params);
        return await service.ingest(input.importId, input.selection, signal);
      }
      case "restorePreview": {
        const input = desktopRestorePreviewSchema.parse(params);
        return await service.preview(input.importId, input, signal);
      }
      case "restoreApply": {
        const input = desktopRestoreApplySchema.parse(params);
        await closeTransport();
        signal.throwIfAborted();
        return await service.apply(input.confirmationId, signal);
      }
      case "restoreImportCancel":
        return await service.cancel(desktopRestoreCancelSchema.parse(params).importId);
      case "restoreStatus":
        z.object({})
          .strict()
          .parse(params ?? {});
        return await service.status();
      case "restoreRecover": {
        const input = desktopRestoreRecoverSchema.parse(params);
        await closeTransport();
        signal.throwIfAborted();
        return await service.recover(input.operationId, signal);
      }
      default:
        return assertNever(command);
    }
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof DesktopRestoreFailure) throw error;
    if (error instanceof DesktopRestoreTransactionError)
      throw new DesktopRestoreFailure(error.code);
    throw new DesktopRestoreFailure(
      command === "restorePrepareImport"
        ? "RESTORE_PREPARE_REQUIRED"
        : command === "restoreImport"
          ? "RESTORE_SELECTION_REFUSED"
          : command === "restorePreview"
            ? "RESTORE_PREVIEW_REFUSED"
            : "RESTORE_OPERATION_REFUSED",
    );
  }
}
