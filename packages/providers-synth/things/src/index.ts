// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import realThings from "@omnesis/provider-things";
import { defineSource } from "@omnesis/source-sdk";
import {
  fakeLocalFlow,
  preDiscoveredAccounts,
  syncFromFixture,
  type SynthCursor,
} from "@omnesis/providers-synth-common";
import { loadTasks, mapTask } from "./fixtures.js";
import { thingsSynthStateSpec } from "./state.js";

const { type: _type, ...rest } = realThings;

export default defineSource<SynthCursor>({
  ...rest,
  // A double reads fixtures, not a real vault or database, so it declares no
  // configuration at all. Inheriting the real schema would inherit its path
  // check too, and that check answers a question about this machine's
  // filesystem — which on a synthetic host, or any host without the real app
  // installed, refuses to instantiate the source.
  config: undefined,
  // Its own declaration over its own cursor, deliberately not the real
  // source's: a real decoder refuses the cursor a double writes. This is the
  // one double that declares state, so that the machinery carrying an
  // installed cursor forward is reachable from an end-to-end run rather than
  // only from unit tests on either side of a seam nothing crosses.
  contract: { state: thingsSynthStateSpec, requires: ["state-envelope"] },
  authType: "local",
  supportedPlatforms: undefined,
  credentials: undefined,
  discover: async () => preDiscoveredAccounts("things", ["local"]),
  authFlow: async () => fakeLocalFlow("things", "local"),
  // A synthetic double spreads the real definition, so every auth entry point
  // the real source declares has to be overridden here or a demo run reaches
  // the real service.
  authenticate: undefined,
  cleanupCredentials: undefined,
  async create({ sourceId, providerId }) {
    const entries = loadTasks();
    return {
      async sync(cursor) {
        return syncFromFixture(entries, cursor, (e) => mapTask(e, { sourceId, providerId }), {
          sourceId,
        });
      },
    };
  },
});
