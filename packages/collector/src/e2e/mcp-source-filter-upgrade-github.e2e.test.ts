// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { describeFilterUpgrade } from "./source-filter-upgrade.js";

// Issues, pull requests, discussions and commits indexed before repository
// filters were in use. Owners and repositories carry GitHub's ids, as the
// universe's fixtures give them: the organization northstar-labs is owner
// 9001, the account maya-reeves is owner 7001, northstar-labs/atlas-api is
// repository 4101. The "sketches" records are in a repository GitHub gave no
// id for, which no filter reaches.
const folder = (id: string) => ({ kind: "folder", id }) as const;
const ATLAS_THREADS = ["atlas-issue", "atlas-pull", "atlas-discussion"];

describeFilterUpgrade({
  universe: "repository-filters",
  sources: [
    {
      sourceId: "github:maya-reeves",
      kind: "folder",
      markers: { title: "TITLE", body: "BODY" },
      records: [
        ...ATLAS_THREADS,
        "docs-issue",
        "archive-issue",
        "garden-issue",
        "fork-pull",
        "sketches-issue",
      ],
      share: { choice: folder("owner:9001"), leaves: [...ATLAS_THREADS, "docs-issue"] },
      hide: {
        choice: folder("owner:7001"),
        leaves: [...ATLAS_THREADS, "docs-issue", "archive-issue"],
      },
    },
    {
      sourceId: "github-commits:maya-reeves",
      kind: "folder",
      markers: { title: "TITLE", body: "BODY" },
      records: [
        "atlas-commit",
        "docs-commit",
        "archive-commit",
        "garden-commit",
        "fork-commit",
        "sketches-commit",
      ],
      share: { choice: folder("repo:4101"), leaves: ["atlas-commit"] },
      hide: {
        choice: folder("owner:7001"),
        leaves: ["atlas-commit", "docs-commit", "archive-commit"],
      },
    },
  ],
});
