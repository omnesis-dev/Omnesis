// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import realChrome from "@omnesis/provider-chrome";
import { defineSource } from "@omnesis/source-sdk";
import {
  fakeLocalFlow,
  preDiscoveredAccounts,
  syncFromFixture,
  selfAccountId,
  type SynthCursor,
} from "@omnesis/providers-synth-common";
import { loadBookmarks, mapBookmark, mapBookmarkEdge } from "./fixtures.js";

const { type: _type, ...rest } = realChrome;
const accountId = selfAccountId("email");

export default defineSource<SynthCursor>({
  ...rest,
  // The double drives its own cursor, which the real source's decoder does not
  // know. Inheriting the declaration would refuse that cursor on the tick after
  // the first one and park the source.
  contract: undefined,
  // Same reason, for the settings: the real source declares a path that has to
  // exist on this machine, and a double that inherited the check would refuse
  // to instantiate on a host that has never run the real app.
  config: undefined,
  authType: "local",
  credentials: undefined,
  discover: async () => preDiscoveredAccounts("chrome", [accountId]),
  authFlow: async () => fakeLocalFlow("chrome", accountId),
  // A synthetic double spreads the real definition, so every auth entry point
  // the real source declares has to be overridden here or a demo run reaches
  // the real service.
  authenticate: undefined,
  cleanupCredentials: undefined,
  async create({ sourceId, providerId }) {
    const entries = loadBookmarks();
    return {
      async sync(cursor) {
        return syncFromFixture(entries, cursor, (e) => mapBookmark(e, { sourceId, providerId }), {
          sourceId,
          mapEdges: (e) => mapBookmarkEdge(e),
        });
      },
    };
  },
});
