// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineSource, type SyncCursor } from "@omnesis/source-sdk";

import { hermesDocumentEventProfile } from "./document-event-profile.js";

/**
 * Hermes conversation transcripts.
 *
 * The Hermes harness plugin pushes its turns to `POST /agent-messages`; the
 * gateway projects them into one `conversation` document per chat per calendar
 * day. No collector ever syncs this source, so it declares external execution and
 * `gatewayHosted: true` keeps collectors from advertising it as something an
 * operator could add.
 *
 * The definition exists so the source can declare what its documents contain.
 * Without a `documentEventProfile` the watch compiler has no Hermes shape to
 * reach for and picks the nearest source it does know, producing a watch over
 * the wrong corpus entirely.
 */
export default defineSource<SyncCursor>({
  id: "hermes",
  name: "Hermes",
  description: "Conversations with the Hermes agent harness",
  provider: { id: "hermes", name: "Hermes" },
  authType: "local",
  unitName: "conversations",
  gatewayHosted: true,
  singleInstance: true,
  execution: "external",
  documentEventProfile: hermesDocumentEventProfile,
});
