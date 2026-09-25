// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import realWhatsapp from "@omnesis/provider-whatsapp";
import { defineSource } from "@omnesis/source-sdk";
import {
  fakeQrSession,
  preDiscoveredAccounts,
  syncFromFixture,
  selfAccountId,
  type SynthCursor,
} from "@omnesis/providers-synth-common";
import { loadChats, mapChat } from "./fixtures.js";
import { universeHasFakeCorpus, createWrapsRealWhatsApp } from "./wraps-real.js";

export {
  getWhatsAppWrapsRealController,
  type WhatsAppWrapsRealController,
  type WhatsAppFakeCorpusFixture,
} from "./wraps-real.js";

const { type: _type, ...rest } = realWhatsapp;
const accountId = selfAccountId("phone");

export default defineSource<SynthCursor>({
  ...rest,
  authType: "qr",
  credentials: undefined,
  discover: async () => preDiscoveredAccounts("whatsapp", [accountId]),
  authenticate: (session) =>
    fakeQrSession("whatsapp", accountId, session, {
      title: "Scan this code from your phone",
      instructions: "This is a synthetic pairing; nothing leaves this machine.",
    }),
  cleanupCredentials: undefined,
  // A double drives its own cursor, which the real source's decoder does not
  // know. Inheriting the declaration would refuse that cursor on the tick
  // after the first one and park the source.
  contract: undefined,
  async create(opts) {
    // Two synth modes, selected by what the active universe ships:
    //
    // 1. WRAPS-REAL (#586) — universes that carry a `fake-corpus.json` drive
    //    the REAL WhatsAppProvider (durable store, #579 seal, #580 backfill)
    //    via an injected FakeWhatsAppServer. Exercises the full provider
    //    end-to-end through the gateway pipeline.
    //
    // 2. FIXTURE — every other universe renders pre-baked day-doc fixtures and
    //    BYPASSES the real provider (no Baileys, store, seal, or backfill).
    //    Fast and sufficient for cross-source / search / people coverage.
    if (universeHasFakeCorpus()) {
      return createWrapsRealWhatsApp(opts);
    }
    const { sourceId, providerId } = opts;
    const entries = loadChats();
    return {
      async sync(cursor) {
        return syncFromFixture(entries, cursor, (e) => mapChat(e, { sourceId, providerId }), {
          sourceId,
        });
      },
    };
  },
});
