// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

const messages = {
  RECOVERY_COPIES_FULL:
    "Automatic recovery copies are full. Save a personal backup, then remove eligible older recovery copies before updating again.",
  RECOVERY_COPY_INCOMPLETE:
    "An earlier automatic recovery copy is incomplete. Review it in Backups settings before preparing another update.",
  RECOVERY_CLEANUP_PENDING:
    "A recovery cleanup is pending. Review it in Backups settings before preparing another update.",
  RECOVERY_CLEANUP_REFUSED:
    "The recovery cleanup did not finish. Review its status before retrying.",
} as const;
export class DesktopSnapshotRetentionFailure extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}
export function desktopSnapshotRetentionFailureFromCode(
  code: unknown,
): DesktopSnapshotRetentionFailure | null {
  return typeof code === "string" && Object.hasOwn(messages, code)
    ? new DesktopSnapshotRetentionFailure(code as keyof typeof messages)
    : null;
}
