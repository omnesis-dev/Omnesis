// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceScopes } from "@omnesis/types";

/**
 * Pure source-owned metadata, also packaged for gateways with older collectors.
 *
 * A folder is a directory inside one of the configured folders; naming one
 * covers every file beneath it.
 */
export const scopeContracts = {
  "local-files": {
    items: [
      {
        kind: "folder",
        noun: { one: "folder", many: "folders" },
        picker: "tree",
        link: "hierarchy",
      },
    ],
  },
} satisfies Record<string, SourceScopes>;
