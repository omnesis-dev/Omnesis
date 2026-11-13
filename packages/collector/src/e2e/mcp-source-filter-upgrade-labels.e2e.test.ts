// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { describeFilterUpgrade } from "./source-filter-upgrade.js";

// Mail indexed before filters were in use. A message's labels are known only
// to the collector, which reports them for the stored messages; its sender
// and recipients are in what the gateway stores, so a filter on a person
// works before the collector has reported anything.
describeFilterUpgrade({
  universe: "label-filters",
  sources: [
    {
      sourceId: "gmail:maya.reeves@example.org",
      kind: "label",
      markers: { title: "TITLE", body: "BODY" },
      records: ["atlas", "billing", "garden", "both", "plain"],
      share: { choice: { kind: "label", id: "Label_work" }, leaves: ["atlas", "billing", "both"] },
      hide: {
        choice: { kind: "label", id: "Label_personal" },
        leaves: ["atlas", "billing", "plain"],
      },
      storedFacts: {
        choice: {
          kind: "participant",
          label: "david.lin@example.org",
          identifiers: [{ type: "email", value: "david.lin@example.org" }],
        },
        leaves: ["garden", "plain"],
      },
    },
  ],
});
