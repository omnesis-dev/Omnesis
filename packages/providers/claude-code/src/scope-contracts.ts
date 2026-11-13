// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceScopes } from "@omnesis/types";

/**
 * Pure source-owned metadata, also packaged for gateways with older collectors.
 *
 * A project folder is the directory a session worked in; naming one covers
 * the sessions run in it and in every directory beneath it.
 */
export const scopeContracts = {
  "claude-code": {
    items: [
      {
        kind: "folder",
        noun: { one: "project folder", many: "project folders" },
        picker: "tree",
        link: "hierarchy",
      },
    ],
  },
} satisfies Record<string, SourceScopes>;
