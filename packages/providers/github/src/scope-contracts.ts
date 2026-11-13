// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceScopes } from "@omnesis/types";

/**
 * A filter names repositories, or every repository an owner holds: the tree
 * has owners (a user or an organization) at its roots and their repositories
 * beneath them.
 */
const repositories: SourceScopes = {
  items: [
    {
      kind: "folder",
      noun: { one: "repository or owner", many: "repositories and owners" },
      levels: [
        { one: "owner", many: "owners" },
        { one: "repository", many: "repositories" },
      ],
      picker: "tree",
      link: "hierarchy",
    },
  ],
};

/** Pure source-owned metadata, also packaged for gateways with older collectors. */
export const scopeContracts = {
  github: repositories,
  "github-commits": repositories,
} satisfies Record<string, SourceScopes>;
