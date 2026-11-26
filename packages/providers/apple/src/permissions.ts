// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourcePermissionDeclaration } from "@omnesis/source-sdk";

/** Protected-store access is scoped to this source, not evidence of global Full Disk Access. */
export function appleStorePermissions(
  scope: string,
  probePermissionAccess: NonNullable<SourcePermissionDeclaration["probePermissionAccess"]>,
  fullDiskAccess = true,
): SourcePermissionDeclaration {
  return {
    permissionRequirements: [
      {
        id: "local-store",
        kind: "protected-files",
        summary: "Allow access to this source's local store",
        scope,
        blocking: true,
        actions: [
          ...(fullDiskAccess
            ? [{ kind: "open-system-settings" as const, category: "full-disk-access" as const }]
            : []),
          { kind: "retry-access" },
          { kind: "restart-collector" },
        ],
      },
    ],
    probePermissionAccess,
  };
}
