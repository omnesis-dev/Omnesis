// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { markerKey } from "./filter-e2e-reads.js";
import { describeFilterUpgrade } from "./source-filter-upgrade.js";

// Issues, pull requests, discussions and commits read by a build that stored
// no repository id. Owners and repositories are GitHub's ids, as the
// universe's fixtures give them: the organization northstar-labs is owner
// 9001, the account maya-reeves is owner 7001, northstar-labs/atlas-api is
// repository 4101. The "sketches" records are in a repository GitHub gave no
// id for, which no filter can place, so every filter hides them.
const THREADS = "github:maya-reeves";
const COMMITS = "github-commits:maya-reeves";
const ATLAS_THREADS = ["atlas-issue", "atlas-pull", "atlas-discussion"];

/** The last two records of the account cannot be read again. */
const unreadable = (sourceId: string) => (missing: boolean) => {
  if (missing) process.env.OMNESIS_SYNTH_READ_IMPAIRMENT = `${sourceId}:degraded:2`;
  else delete process.env.OMNESIS_SYNTH_READ_IMPAIRMENT;
};

describeFilterUpgrade({
  universe: "repository-filters",
  sources: [
    {
      sourceId: THREADS,
      field: "extra.repositoryIds",
      key: markerKey(/BODY_([A-Z_]+)/),
      records: [
        ...ATLAS_THREADS,
        "docs-issue",
        "archive-issue",
        "garden-issue",
        "fork-pull",
        "sketches-issue",
      ],
      share: { choice: { id: "owner:9001" }, leaves: [...ATLAS_THREADS, "docs-issue"] },
      hide: {
        choice: { id: "owner:7001" },
        leaves: [...ATLAS_THREADS, "docs-issue", "archive-issue"],
      },
      unreadable: unreadable(THREADS),
      answer: true,
    },
    {
      sourceId: COMMITS,
      field: "extra.repositoryIds",
      key: markerKey(/BODY_([A-Z_]+)/),
      records: [
        "atlas-commit",
        "docs-commit",
        "archive-commit",
        "garden-commit",
        "fork-commit",
        "sketches-commit",
      ],
      share: { choice: { id: "4101" }, leaves: ["atlas-commit"] },
      hide: {
        choice: { id: "owner:7001" },
        leaves: ["atlas-commit", "docs-commit", "archive-commit"],
      },
      answer: true,
    },
  ],
});
