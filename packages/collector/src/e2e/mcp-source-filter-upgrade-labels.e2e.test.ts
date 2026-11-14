// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { markerKey } from "./filter-e2e-reads.js";
import { describeFilterUpgrade } from "./source-filter-upgrade.js";

// Mail read by a build that wrote no label ids. The Gmail double writes its
// messages without them while `beforeFilterDetails` is set, as that build
// did; it is reached through a dynamic import, which loads the synthetic
// package only once the harness has chosen the universe.
const GMAIL = "gmail:maya.reeves@example.org";
const label = (id: string) => ({ id });

describeFilterUpgrade({
  universe: "label-filters",
  sources: [
    {
      sourceId: GMAIL,
      field: "extra.labelIds",
      key: markerKey(/BODY_([A-Z_]+)/),
      records: ["atlas", "billing", "garden", "both", "plain"],
      share: { choice: label("Label_work"), leaves: ["atlas", "billing", "both"] },
      hide: { choice: label("Label_personal"), leaves: ["atlas", "billing", "plain"] },
      oldBuild: async (_harness, old) => {
        const twins = await import("@omnesis/provider-google-synth");
        const mailbox = twins.getGmailTwin(GMAIL);
        if (!mailbox) throw new Error(`no Gmail double registered for ${GMAIL}`);
        mailbox.beforeFilterDetails = old;
      },
      // The last two messages of the mailbox cannot be read again.
      unreadable: (missing) => {
        if (missing) process.env.OMNESIS_SYNTH_READ_IMPAIRMENT = `${GMAIL}:degraded:2`;
        else delete process.env.OMNESIS_SYNTH_READ_IMPAIRMENT;
      },
      answer: true,
    },
  ],
});
