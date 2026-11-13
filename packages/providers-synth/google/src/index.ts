// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import realGoogle, {
  DRIVE_FOLDERS_FIELD,
  GMAIL_LABELS_FIELD,
  GoogleCalendarSource,
} from "@omnesis/provider-google";
import { defineProvider, withFilterLists } from "@omnesis/source-sdk";
import {
  fakeOAuthFlow,
  pageFromFixture,
  preDiscoveredAccounts,
  syncFromFixture,
  selfAccountId,
  type SynthCursor,
  impairEntries,
  synthPartitionOf,
} from "@omnesis/providers-synth-common";
import { resolveAttachmentConfig } from "@omnesis/core";
import {
  loadEmails,
  loadEvents,
  loadFiles,
  loadDriveFolders,
  loadContacts,
  mapEvent,
  mapEventRecord,
  mapDriveFile,
  mapContact,
} from "./fixtures.js";
import { createGmailFixtureSource } from "./gmail-source.js";
import {
  DriveTwinAccount,
  GmailTwinMailbox,
  registerDriveTwin,
  registerGmailTwin,
  unregisterGoogleTwin,
} from "./accounts.js";
import { withChangeReplay, type ReplayCursor } from "./change-replay.js";
import type { SourceContractDeclaration, StructuredSyncResult } from "@omnesis/source-sdk";

export {
  getDriveTwin,
  getGmailTwin,
  type DriveTwinAccount,
  type GmailTwinMailbox,
} from "./accounts.js";

const { type: _type, ...rest } = realGoogle;
// Resolved when a source asks, not on import: a universe that does not carry
// this source must still load the package, and its discover() then reports no
// account instead of failing the provider load.
const selfAccount = (): string => selfAccountId("email");
const GOOGLE_CALENDAR_SCHEMA = new GoogleCalendarSource(
  {} as ConstructorParameters<typeof GoogleCalendarSource>[0],
).analyticsSchemas[0];

interface SourceWiring {
  load: () => unknown[];
  map: (e: any, ctx: any) => any;
}

const wiring: Record<string, SourceWiring> = {
  "google-contacts": { load: loadContacts, map: mapContact },
};

/**
 * What a double keeps of its real source's contract: the output revision, so
 * its documents are stored at the version the real source writes and the
 * filter fields the real profile declares stay within it. The state spec is
 * left out because the double drives its own cursor, which the real source's
 * decoder would refuse on the next tick.
 */
function revisionOnly(
  contract: SourceContractDeclaration | undefined,
): SourceContractDeclaration | undefined {
  return contract?.outputRevision === undefined
    ? undefined
    : { outputRevision: contract.outputRevision };
}

export default defineProvider<Record<string, never>>({
  ...rest,
  authType: "oauth",
  credentials: undefined,
  discover: async () => preDiscoveredAccounts("google", [selfAccount()]),
  authFlow: async (_p, cb) => fakeOAuthFlow("google", "Google", selfAccount(), cb),
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
  sources: rest.sources.map((s) => {
    if (s.id === "google-calendar") {
      return {
        ...s,
        contract: revisionOnly(s.contract),
        analyticsSchemas: [GOOGLE_CALENDAR_SCHEMA],
        async create({ accountId: sourceAccount, sourceId, providerId }) {
          const entries = loadEvents();
          const context = { sourceId, providerId };
          return {
            analyticsSchemas: [GOOGLE_CALENDAR_SCHEMA],
            async sync(cursor: SynthCursor | null) {
              return syncFromFixture(entries, cursor, (entry) => mapEvent(entry, context), {
                sourceId,
              });
            },
            async syncStructured(
              cursor: SynthCursor | null,
            ): Promise<StructuredSyncResult<SynthCursor>> {
              // Resolved per sync, never at create() time.
              const { visible, snapshotAllowed } = impairEntries(
                entries,
                sourceId,
                (entry) => entry.externalId,
              );
              const snapshotIds = snapshotAllowed
                ? visible.map((entry) => entry.externalId)
                : undefined;
              const { batch, newCursor, hasMore, isFinalPage } = pageFromFixture(visible, cursor);
              return {
                analytics: {
                  tableName: GOOGLE_CALENDAR_SCHEMA.tableName,
                  records: batch.map((entry) => mapEventRecord(entry, String(sourceAccount))),
                  schema: GOOGLE_CALENDAR_SCHEMA,
                  presentIds: isFinalPage ? snapshotIds : undefined,
                },
                documents: batch.map((entry) => mapEvent(entry, context)),
                cursor: newCursor,
                hasMore,
                presentExternalIds: isFinalPage ? snapshotIds : undefined,
              };
            },
          };
        },
      };
    }
    return {
      ...s,
      contract: revisionOnly(s.contract),
      async create({ sourceId, providerId, sourceConfig, host }) {
        const context = { sourceId, providerId };
        if (s.id === "gmail") {
          const emails = loadEmails();
          const mailbox = new GmailTwinMailbox(emails);
          registerGmailTwin(String(sourceId), mailbox);
          return withFilterLists(
            {
              ...createGmailFixtureSource(
                emails,
                context,
                {
                  extractAttachment: host?.extractAttachment,
                  attachmentConfig: resolveAttachmentConfig(sourceConfig, {
                    defaultEnabled: true,
                    includeAudioTypes: host?.includeAudioTypes,
                  }),
                },
                mailbox,
              ),
              dispose: async () => unregisterGoogleTwin(String(sourceId), mailbox),
            },
            { [GMAIL_LABELS_FIELD]: () => mailbox.listLabels() },
          );
        }
        if (s.id === "google-drive") {
          const files = loadFiles();
          const drive = new DriveTwinAccount(files, loadDriveFolders());
          registerDriveTwin(String(sourceId), drive);
          const documentOf = (file: (typeof files)[number]) =>
            mapDriveFile(drive.current(file), context);
          return withFilterLists(
            {
              async sync(cursor: ReplayCursor | null) {
                const page = syncFromFixture(files, cursor, documentOf, { sourceId });
                return withChangeReplay(cursor, drive.changes, page, (changed) =>
                  files.flatMap((file, index) =>
                    changed.has(file.externalId)
                      ? [{ ...documentOf(file), partitionKey: synthPartitionOf(index) }]
                      : [],
                  ),
                );
              },
              dispose: async () => unregisterGoogleTwin(String(sourceId), drive),
            },
            { [DRIVE_FOLDERS_FIELD]: () => drive.listFolders() },
          );
        }
        const w = wiring[s.id];
        if (!w) throw new Error(`No synth wiring for google source: ${s.id}`);
        const entries = w.load();
        return {
          async sync(cursor) {
            return syncFromFixture(entries, cursor, (e) => w.map(e, context), { sourceId });
          },
        };
      },
    };
  }),
});
