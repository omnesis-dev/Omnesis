// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import realObsidian from "@omnesis/provider-obsidian";
import { defineSource } from "@omnesis/source-sdk";
import {
  fakeLocalFlow,
  preDiscoveredAccounts,
  syncFromFixture,
  type SynthCursor,
} from "@omnesis/providers-synth-common";
import { loadNotes, mapNote } from "./fixtures.js";

const { type: _type, ...rest } = realObsidian;

export default defineSource<SynthCursor>({
  ...rest,
  // A double reads fixtures, not a real vault or database, so it declares no
  // configuration at all. Inheriting the real schema would inherit its path
  // check too, and that check answers a question about this machine's
  // filesystem — which on a synthetic host, or any host without the real app
  // installed, refuses to instantiate the source.
  config: undefined,
  resolveAccountId: undefined,
  authType: "local",
  credentials: undefined,
  // params kept from real definition (vaultPath) so the descriptor surface
  // matches; discover() bypasses param entry by returning a synthetic vault.
  discover: async () => preDiscoveredAccounts("obsidian-notes", ["Personal"]),
  authFlow: async () => fakeLocalFlow("obsidian-notes", "Personal"),
  // A synthetic double spreads the real definition, so every auth entry point
  // the real source declares has to be overridden here or a demo run reaches
  // the real service.
  authenticate: undefined,
  // A double drives its own cursor, which the real source's decoder does not
  // know. Inheriting the declaration would refuse that cursor on the tick
  // after the first one and park the source.
  contract: undefined,
  cleanupCredentials: undefined,
  async create({ sourceId, providerId }) {
    const entries = loadNotes();
    return {
      async sync(cursor) {
        return syncFromFixture(entries, cursor, (e) => mapNote(e, { sourceId, providerId }), {
          sourceId,
        });
      },
    };
  },
});
