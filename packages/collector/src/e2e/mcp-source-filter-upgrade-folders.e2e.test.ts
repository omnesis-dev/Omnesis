// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { markerKey } from "./filter-e2e-reads.js";
import { describeFilterUpgrade } from "./source-filter-upgrade.js";
import type { SyntheticE2EHarness } from "./synth-harness.js";

// Coding sessions and local files read by a build that predates versions.
// The real sources run over invented files on disk, and those still read the
// same, so the records written then already hold their folder: only their
// version tells the gateway they were written before the field existed, and
// that alone keeps them out of any folder filter until they are read again.
//
// A folder is its device and its path, and each computer's records are kept
// apart, so every record is named with its computer. Codex runs on the
// laptop only. The local files are read on the laptop and on the desktop, at
// the same paths, so each file is two records, `atlas@laptop` and
// `atlas@desktop`, and a folder picked on the laptop says nothing about the
// desktop's copies.
const laptop = (harness: SyntheticE2EHarness) =>
  harness.getDevices().find((device) => device.rosterId === "laptop")!;
const IN_WORK = ["atlas", "guide", "billing"];
const FILES = [...IN_WORK, "garden", "bench", "inbox"];
const onLaptop = (keys: readonly string[]) => keys.map((key) => `${key}@laptop`);
const onBoth = (keys: readonly string[]) =>
  keys.flatMap((key) => [`${key}@laptop`, `${key}@desktop`]);

describeFilterUpgrade({
  universe: "folder-filters",
  sources: [
    {
      sourceId: "codex:codex-maya",
      field: "extra.projectFolder",
      key: markerKey(/PROMPT_([A-Z_]+)/),
      // "retries" moved into a subfolder and "roaming" into an unrelated
      // project: both stay filed under the folder they started in.
      records: onLaptop([...IN_WORK, "retries", "garden", "bench", "roaming"]),
      share: {
        choice: { labelEndsWith: "/srv/work", device: laptop },
        leaves: onLaptop([...IN_WORK, "retries", "roaming"]),
      },
      hide: {
        choice: { labelEndsWith: "/srv/personal", device: laptop },
        leaves: onLaptop([...IN_WORK, "retries", "bench", "roaming"]),
      },
      answer: true,
    },
    {
      sourceId: "local-files:files-maya",
      field: "extra.folder",
      key: markerKey(/BODY_([A-Z_]+)/),
      records: onBoth(FILES),
      share: {
        choice: { labelEndsWith: "/work", device: laptop },
        leaves: onLaptop(IN_WORK),
      },
      hide: {
        choice: { labelEndsWith: "/personal", device: laptop },
        leaves: onBoth(FILES).filter((key) => key !== "garden@laptop"),
      },
      answer: false,
    },
  ],
});
