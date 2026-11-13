// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { homedir } from "node:os";
import { pathScopeFolders } from "@omnesis/source-sdk";
import { describeFilterUpgrade } from "./source-filter-upgrade.js";

// Coding-agent sessions and local files indexed before folder filters were in
// use. A session's folder id follows from its path alone, so the filter can
// be asked for before the collector has reported; a local file's folder is
// named from the configured folder, so it is picked from the editor.
const folder = (path: string) =>
  ({ kind: "folder", id: pathScopeFolders(path, { home: homedir() })![0]!.id }) as const;
const IN_WORK = ["atlas", "guide", "billing"];

describeFilterUpgrade({
  universe: "folder-filters",
  sources: [
    {
      sourceId: "codex:codex-maya",
      kind: "folder",
      markers: { title: "ANSWER", body: "PROMPT" },
      // "roaming" ran in two unrelated folders, so no folder filter reaches it.
      records: [...IN_WORK, "retries", "garden", "bench", "roaming"],
      share: { choice: folder("/srv/work"), leaves: [...IN_WORK, "retries"] },
      hide: { choice: folder("/srv/personal"), leaves: [...IN_WORK, "retries", "bench"] },
    },
    {
      sourceId: "local-files:files-maya",
      kind: "folder",
      markers: { title: "TITLE", body: "BODY" },
      records: [...IN_WORK, "garden", "bench", "inbox"],
      share: { choice: { labelEndsWith: "/work" }, leaves: IN_WORK },
      hide: { choice: { labelEndsWith: "/personal" }, leaves: [...IN_WORK, "bench", "inbox"] },
    },
  ],
});
