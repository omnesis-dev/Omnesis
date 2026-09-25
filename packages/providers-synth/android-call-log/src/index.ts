// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineSource } from "@omnesis/source-sdk";
import {
  fakeLocalFlow,
  preDiscoveredAccounts,
  syncFromFixture,
  type SynthCursor,
} from "@omnesis/providers-synth-common";
import { loadCallLog, mapCallLog } from "./fixtures.js";
import { androidCallLogIconDataUri } from "./icons.js";

/**
 * Synth Android Call Log.
 *
 * The real source is Android (Kotlin) reading `CallLog.Calls` and pushing
 * day-aggregate documents to `/documents` plus per-call analytics rows to
 * `/analytics/ingest` over the device WS — the Android analogue of
 * `apple-call-log`. This synthetic twin mirrors only the document side
 * (matching `apple-call-log`'s own synth twin, which likewise skips the
 * analytics table): a device-hosted source's analytics schema is registered
 * inline on the wire by the Kotlin client, not via a Node descriptor, so
 * there's no equivalent TS-side registration path for the synthetic gateway
 * to exercise here either.
 */

// Matches health-connect-synth's accountId — both sources live on the same
// synthetic Android device/persona in the demo universe. The real production
// source uses accountId "local" (see `CallLogSource.ACCOUNT_ID_LOCAL`); this
// distinguishing string is purely a synth/demo-universe convention.
const accountId = "android-synth-johnsmith";

export default defineSource<SynthCursor>({
  id: "android-call-log",
  name: "Android Call Log",
  description: "Native phone call history from an Android device",
  authType: "local",
  unitName: "calls",
  singleInstance: true,
  icon: {
    sfSymbol: "phone.fill",
    color: "#3DDC84",
    imageDataUri: androidCallLogIconDataUri,
  },
  discover: async () => preDiscoveredAccounts("android-call-log", [accountId]),
  authFlow: async () => fakeLocalFlow("android-call-log", accountId),
  async create({ sourceId, providerId }) {
    return {
      async sync(cursor) {
        return syncFromFixture(
          loadCallLog(),
          cursor,
          (e) => mapCallLog(e, { sourceId, providerId }),
          { sourceId },
        );
      },
    };
  },
});
