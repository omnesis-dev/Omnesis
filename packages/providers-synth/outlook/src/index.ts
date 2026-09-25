// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import realOutlook, {
  OneDriveSource,
  OutlookCalendarSource,
  validateOneDriveCursor,
} from "@omnesis/provider-outlook";
import { defineProvider } from "@omnesis/source-sdk";
import { resolveAttachmentConfig } from "@omnesis/core";
import {
  fakeOAuthFlow,
  preDiscoveredAccounts,
  resolvePerson,
  syncFromFixture,
} from "@omnesis/providers-synth-common";
import { loadEmails, mapEmail } from "./fixtures.js";
import { loadOneDriveItems, syntheticOneDriveGraph } from "./onedrive-fixtures.js";
import { loadCalendarEvents, syntheticCalendarGraph } from "./calendar-fixtures.js";

/** The mutations the synth env switches apply, for E2E assertions. */
export { CALENDAR_UPDATE_OVERRIDE, calendarIdFor } from "./calendar-fixtures.js";
export { REWALK_BUMP } from "./onedrive-fixtures.js";

const { type: _type, ...rest } = realOutlook;

// The Microsoft provider's synthetic account id is the self persona's
// work-domain email, resolved from the active universe's cast rather than
// restated as a literal here — so the synth account id can never drift from the
// emails the cast wires through every Microsoft-flavored fixture. Both the
// Outlook email and OneDrive sources share this one account id, mirroring how
// one real Microsoft consent grants both Mail and Files. Resolved lazily (inside
// the auth/discover callbacks) so the active-universe env is already set before
// the cast loads — a module-load resolve would cache the default universe.
function microsoftAccountId(): string {
  const self = resolvePerson("self");
  // Prefer the self persona's corporate-domain email (the Outlook/work account)
  // over a personal gmail/icloud alias; fall back to the first email.
  const work = self.emails.find((e) => !/(@gmail\.|@icloud\.|@outlook\.|@hotmail\.)/i.test(e));
  const email = work ?? self.emails[0];
  if (!email) throw new Error("self persona has no email alias for the Microsoft account id");
  return email;
}

export default defineProvider<Record<string, never>>({
  ...rest,
  authType: "oauth",
  credentials: undefined,
  discover: async () => preDiscoveredAccounts("microsoft", [microsoftAccountId()]),
  authFlow: async (_p, cb) => fakeOAuthFlow("microsoft", "Microsoft", microsoftAccountId(), cb),
  // A synthetic double spreads the real definition, so every auth entry point
  // the real source declares has to be overridden here or a demo run reaches
  // the real service.
  authenticate: undefined,
  cleanupCredentials: undefined,
  createContext: async () => ({}),
  // A synthetic double has no credential to be in a state about, and says so
  // outright: the real provider's declaration would otherwise leak through
  // the spread above with a context type this double does not have.
  credentialState: () => Promise.resolve({ status: "connected" as const }),
  disposeContext: async () => {},
  // Both Microsoft sources rejoin the synth twin: the email source maps fixture
  // entries directly; the OneDrive source runs the REAL `OneDriveSource` over a
  // fixture-backed Graph so the production delta walk / normalization / 410
  // bounded re-walk all execute against canned `driveItem` pages.
  sources: rest.sources.map((s) => {
    if (s.id === "onedrive") {
      return {
        ...s,
        // The double drives its own cursor; the real source's decoder does not
        // know it. Inheriting the declaration refuses that cursor on the next tick.
        contract: undefined,
        async create({ sourceId, providerId, dataCutoff, sourceConfig, extractAttachment }) {
          const attachmentConfig = resolveAttachmentConfig(sourceConfig, { defaultEnabled: true });
          const source = new OneDriveSource(
            async () => "synthetic-token",
            sourceId,
            providerId,
            dataCutoff,
            {
              attachmentConfig,
              extractAttachment,
              graph: syntheticOneDriveGraph(loadOneDriveItems()),
            },
          );
          return { sync: (cursor) => source.sync(validateOneDriveCursor(cursor)) };
        },
      };
    }
    if (s.id === "outlook-calendar") {
      // Calendar rejoins the synth twin like OneDrive: the REAL
      // `OutlookCalendarSource` runs over a fixture-backed Graph so the
      // production `calendarView` delta walk, event→document/row normalization,
      // and `outlook_calendar_events` dual-push all execute against canned
      // pages — keeping the hybrid (documents + analytics row) shape intact.
      return {
        ...s,
        // The double drives its own cursor; the real source's decoder does not
        // know it. Inheriting the declaration refuses that cursor on the next tick.
        contract: undefined,
        async create({ sourceId, providerId, dataCutoff }) {
          const source = new OutlookCalendarSource(
            async () => "synthetic-token",
            sourceId,
            providerId,
            dataCutoff,
            { graph: syntheticCalendarGraph(loadCalendarEvents()) },
          );
          return {
            sync: (cursor) => source.sync(cursor),
            syncStructured: (cursor) => source.syncStructured(cursor),
            analyticsSchemas: source.analyticsSchemas,
          };
        },
      };
    }
    return {
      ...s,
      // The double drives its own cursor; the real source's decoder does not
      // know it. Inheriting the declaration refuses that cursor on the next tick.
      contract: undefined,
      async create({ sourceId, providerId }) {
        const entries = loadEmails();
        return {
          async sync(cursor) {
            return syncFromFixture(entries, cursor, (e) => mapEmail(e, { sourceId, providerId }), {
              sourceId,
            });
          },
        };
      },
    };
  }),
});
