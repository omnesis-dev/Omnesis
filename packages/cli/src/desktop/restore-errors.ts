// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

const messages = {
  RESTORE_CAPACITY_REQUIRED:
    "Free more storage on this Mac before restoring. Keep enough space for the backup, a recovery copy and the library's configured free-space reserve.",
  RESTORE_TARGET_SECRETS_UNPROTECTED:
    "Before making a recovery copy, open Models settings and save the existing model connection key using its protected credential field. Then preview the backup again.",
  RESTORE_CLEANUP_PENDING:
    "Some temporary restore data remains. Choose Erase local data again to finish removal. Its protection key has been kept.",
  RESTORE_BUSY: "Cancel the active backup restore before removing or changing this library.",
  RESTORE_PREPARE_REQUIRED:
    "Unlock this Mac's Keychain and prepare its managed library before importing a backup.",
  RESTORE_SELECTION_REFUSED:
    "The selected backup could not be read safely. Select the original completed backup again.",
  RESTORE_PREVIEW_REFUSED:
    "The backup could not be verified. Check its recovery code and supported backup format, then preview it again.",
  RESTORE_ROLLED_BACK: "The backup was not applied. Your previous library was kept.",
  RESTORE_RECOVERY_REQUIRED:
    "This library needs recovery before it can start. Keep the recovery copy and recover the previous library in the app.",
  RESTORE_OPERATION_REFUSED:
    "The restore step could not finish. Keep your backup and recovery copy, unlock this Mac, and try again.",
} as const;
/** Only fixed public messages can cross the private bridge; exception text never does. */
export class DesktopRestoreFailure extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}
export function desktopRestoreFailureFromCode(code: unknown): DesktopRestoreFailure | undefined {
  if (typeof code !== "string") return undefined;
  for (const name of Object.keys(messages) as Array<keyof typeof messages>)
    if (code === name) return new DesktopRestoreFailure(name);
  return undefined;
}
