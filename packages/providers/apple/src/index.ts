// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_CONFIG_DIR,
  createLogger,
  readStorageKeySync,
  resolveAttachmentConfig,
} from "@omnesis/core";
import { defineProvider } from "@omnesis/source-sdk";
import { unavailableStorePage } from "./store-unavailable.js";
import { throwOnOpenFailure } from "./db-helpers/internal.js";
import { AppleProvider } from "./provider.js";
import { appleFileReadAccess, probeAppleStoresReadAccess } from "./read-access.js";
import { AppleNotesSource } from "./notes.js";
import { AppleRemindersSource } from "./reminders.js";
import { AppleIMessageSource } from "./imessage.js";
import { inspectTranscriptDatabase } from "./imessage-transcript-storage.js";
import { AppleContactsSource } from "./contacts.js";
import { AppleCalendarSource } from "./calendar.js";
import { AppleCallLogSource } from "./call-log.js";
import { AppleVoicemailSource } from "./voicemail.js";
import {
  NOTES_DB_PATH,
  REMINDERS_DIR,
  IMESSAGE_DB_PATH,
  CONTACTS_DB_PATH,
  CALENDAR_DB_PATH,
  CALL_LOG_DB_PATH,
  VOICEMAIL_DB_PATH,
} from "./paths.js";
import {
  appleNotesIconDataUri,
  appleRemindersIconDataUri,
  appleIMessageIconDataUri,
  appleContactsIconDataUri,
  appleCalendarIconDataUri,
  appleCallLogIconDataUri,
  appleVoicemailIconDataUri,
} from "./icons.js";
import {
  appleNotesDocumentProfile,
  appleRemindersDocumentProfile,
  appleIMessageDocumentProfile,
  appleContactsDocumentProfile,
  appleCalendarDocumentProfile,
  appleCallLogDocumentProfile,
  appleVoicemailDocumentProfile,
} from "./document-profiles.js";
import {
  appleNotesStateSpec,
  appleRemindersStateSpec,
  appleImessageStateSpec,
  appleContactsStateSpec,
  appleCalendarStateSpec,
  appleCallLogStateSpec,
  appleVoicemailStateSpec,
} from "./state.js";
import type {
  LocalStoreProbeResult,
  SourceInstance,
  SyncCursor,
  SyncResult,
} from "@omnesis/source-sdk";

/**
 * What a source returns when the macOS store it reads is not on this machine.
 *
 * It reports the cursor it was handed rather than an empty one. Absence here
 * is usually temporary — Full Disk Access has not been granted yet, or the app
 * has not created its database — and the collector persists whatever cursor a
 * page reports, unconditionally. An empty cursor would therefore erase a good
 * bookmark, and the source would re-read its entire history the first time the
 * store came back.
 *
 * It keeps the read-access probe for the same reason. "Not on this machine" and
 * "there, but this process may not open it" look identical from the outside,
 * and the probe is what tells them apart — so the instance that exists because
 * the store could not be opened is exactly the one that must still answer.
 */
function storeUnavailable<TCursor extends SyncCursor>(
  probeReadAccess: SourceInstance<TCursor>["probeReadAccess"],
  initialCursor: TCursor,
  probeLocalStores?: SourceInstance<TCursor>["probeLocalStores"],
): SourceInstance<TCursor> {
  return {
    probeReadAccess,
    probeLocalStores,
    sync: (cursor) => Promise.resolve(unavailableStorePage(cursor ?? initialCursor)),
  };
}

export { AppleProvider } from "./provider.js";
export { AppleNotesSource } from "./notes.js";
export { AppleRemindersSource } from "./reminders.js";
export { AppleIMessageSource } from "./imessage.js";
export { AppleContactsSource } from "./contacts.js";
export { AppleCalendarSource } from "./calendar.js";
export { AppleCallLogSource } from "./call-log.js";
export { AppleVoicemailSource } from "./voicemail.js";

const log = createLogger("provider:apple");

const APPLE_DATABASE_PATHS = [
  NOTES_DB_PATH,
  REMINDERS_DIR,
  IMESSAGE_DB_PATH,
  CONTACTS_DB_PATH,
  CALENDAR_DB_PATH,
  CALL_LOG_DB_PATH,
  VOICEMAIL_DB_PATH,
] as const;

/** Discover the local Apple account only when one of the requested stores exists. */
async function discoverAppleAccounts(paths: readonly string[]): Promise<string[]> {
  if (process.platform !== "darwin" || !paths.some((path) => existsSync(path))) return [];
  const provider = new AppleProvider();
  await provider.initialize();
  const accountId = provider.accountId ?? "local";
  await provider.disconnect();
  return [String(accountId)];
}

/**
 * Notes.app mediates this store: it is what pulls new and changed notes down
 * from iCloud, and while it is not running the file simply stops moving. The
 * collector cannot tell that apart from a fortnight of not writing anything,
 * so without this the source reports itself synced and healthy while serving
 * whatever was on disk the last time the app happened to run.
 *
 * It launches cleanly hidden and asks the operator for nothing once open, so
 * the collector reopens it rather than only complaining about it.
 */
const APPLE_NOTES_FRESHNESS = {
  quietPeriodMs: 14 * 24 * 60 * 60 * 1000,
  requiresProcess: {
    processName: "Notes",
    launch: {
      macosBundleId: "com.apple.Notes",
      failedHint:
        "Omnesis tried to open Notes, but it isn't staying open, so it can't pull new notes from iCloud. Open Notes yourself and check that it stays running.",
    },
  },
  hint: "Notes isn't running on this Mac, so it can't pull new notes from iCloud. Open Notes to resume syncing.",
};

const APPLE_VOICEMAIL_FRESHNESS = {
  quietPeriodMs: 30 * 24 * 60 * 60 * 1000,
  requiresProcess: { processName: "Phone" },
  hint: "Phone isn't running on this Mac, so it can't pull new voicemail from iCloud. Open Phone (and set it to open at login) to resume syncing.",
};

// ── Context ──────────────────────────────────────────────────────────

interface AppleContext {
  provider: AppleProvider;
  dataCutoff?: string;
  phoneRegion?: string;
}

// ── Provider Definition ──────────────────────────────────────────────

/**
 * The transcript cache's state for the collector's health check: the cache
 * lives beside the config directory and opens with this host's
 * `imessage-transcripts` key. A root key that cannot be read leaves it
 * locked rather than failing the probe.
 */
function inspectIMessageTranscriptCache(configDir: string): LocalStoreProbeResult {
  const keyName = "imessage-transcripts";
  const label = "iMessage transcript cache";
  const path = join(configDir, "apple-imessage", "transcripts.db");
  let key: Buffer | null;
  try {
    key = readStorageKeySync(keyName, { configDir });
  } catch {
    return { keyName, label, state: "locked", detail: "The install root key cannot be read." };
  }
  try {
    const state = inspectTranscriptDatabase(path, key);
    if (state === "locked")
      return { keyName, label, state, detail: "No wrapped key exists for it." };
    if (state === "unverifiable") {
      return { keyName, label, state, detail: "It did not open with this host's key." };
    }
    return { keyName, label, state };
  } finally {
    key?.fill(0);
  }
}

export default defineProvider<AppleContext>({
  provider: { id: "apple", name: "Apple" },
  authType: "local",
  supportedPlatforms: ["darwin"],
  multiDevice: { mode: "replicated" },
  // Every source here reads the local macOS databases of the logged-in user,
  // of which there is exactly one per host. There is no second instance to
  // add, so clients hide these once configured rather than offering an
  // "add another" that can only dead-end.
  singleInstance: true,

  async discover() {
    return discoverAppleAccounts(APPLE_DATABASE_PATHS);
  },

  async createContext({ accountId, dataCutoff, host }) {
    const provider = new AppleProvider({ accountId });
    await provider.initialize();
    await provider.authenticate();
    return { provider, dataCutoff, phoneRegion: host?.ingestion?.phoneRegion };
  },

  // A local store has no credential an operator renews, so this never stops
  // the source — the sync path reports the concrete local problem. What it
  // does say is whether the databases can be read at all, which a boolean had
  // no room for: "unreadable right now" is not the same claim as "absent".
  async credentialState(ctx) {
    return (await ctx.provider.isAuthenticated())
      ? { status: "connected" }
      : { status: "unknown", because: "no readable Apple database on this Mac" };
  },

  async disposeContext(ctx) {
    await ctx.provider.disconnect();
  },

  sources: [
    {
      id: "apple-notes",
      name: "Apple Notes",
      description: "Notes from Apple Notes app",
      unitName: "notes",
      contract: {
        // The host resolves the stored cursor against this before `sync`
        // runs, so a value from a build that could not read it never
        // reaches `sync`.
        state: appleNotesStateSpec,
      },
      icon: {
        sfSymbol: "note.text",
        color: "#FFCC00",
        bgColor: "#2A2410",
        imageDataUri: appleNotesIconDataUri,
      },
      documentEventProfile: appleNotesDocumentProfile,
      discover: async () => discoverAppleAccounts([NOTES_DB_PATH]),
      async create({ sourceId, providerId, dataCutoff }, ctx) {
        const probeReadAccess = appleFileReadAccess(ctx.provider.notesDbFilePath);
        if (!ctx.provider.hasNotes) {
          return storeUnavailable(probeReadAccess, { lastModifiedTimestamp: 0 });
        }
        const source = new AppleNotesSource(ctx.provider, { sourceId, providerId, dataCutoff });
        return {
          probeReadAccess,
          sync: (cursor) => source.sync(cursor),
          watchPaths: source.watchPaths,
          freshness: APPLE_NOTES_FRESHNESS,
        };
      },
    },
    {
      id: "apple-reminders",
      name: "Apple Reminders",
      description: "Tasks and reminders from Apple Reminders",
      unitName: "reminders",
      contract: {
        state: appleRemindersStateSpec,
      },
      icon: {
        sfSymbol: "checklist",
        color: "#FF9500",
        bgColor: "#2D2010",
        imageDataUri: appleRemindersIconDataUri,
      },
      documentEventProfile: appleRemindersDocumentProfile,
      documentTemporalProjections: [
        {
          slot: "due",
          start: "dueAt",
          kind: "deadline",
          modality: "asserted",
          status: {
            from: "status",
            map: { open: "active", completed: "completed" },
            default: "active",
          },
        },
      ],
      async create({ sourceId, providerId, dataCutoff }, ctx) {
        // Reminders is bound to one store's open handle, unlike the sources
        // that re-read their database each cycle. A store that is locked or
        // unreadable now may open later, so binding is retried on every sync
        // rather than settled once at instantiation.
        let boundPath: string | undefined;
        const bind = (): AppleRemindersSource | null => {
          // Reminders uses multiple stores — pick the first non-empty one matching this sourceId,
          // or fall back to the first store available. A store the scan could
          // not read names itself in the collector's log as it is skipped.
          const stores = ctx.provider.getRemindersStoresWithAccounts();
          if (stores.length === 0) return null;

          // Use the first store for now (multi-store support comes via multiple source instances)
          const store = stores[0];
          const fullPath = join(ctx.provider.remindersDirFilePath, store.filename);
          boundPath = fullPath;
          log.info(`Registered Reminders source: ${sourceId} (${store.filename})`);
          return new AppleRemindersSource(store.db, {
            sourceId,
            providerId,
            dbPath: fullPath,
            dataCutoff,
          });
        };

        let source = bind();
        const sync = async (cursor: SyncCursor | null): Promise<SyncResult> => {
          source ??= bind();
          if (!source) {
            // No store to read. If a denial or a lock is why, that is this
            // source's failure to report — a Mac with no Reminders store at
            // all simply syncs nothing.
            throwOnOpenFailure(ctx.provider.getRemindersOpenFailure());
            return unavailableStorePage(cursor ?? { lastModifiedTimestamp: 0 });
          }
          const result = await source.sync(cursor);
          return { ...result, issues: result.issues ?? [] };
        };

        // Watch the stores directory rather than the bound store's file: the
        // watch set is read once, at registration, so a source that binds on a
        // later cycle would otherwise never be watched. Watching the directory
        // also picks up a store file that appears mid-session, which a
        // per-file watch cannot.
        const storesDir = ctx.provider.remindersDirFilePath;
        return {
          probeReadAccess: ({ signal }) =>
            boundPath
              ? appleFileReadAccess(boundPath)({ signal })
              : probeAppleStoresReadAccess(storesDir, "reminders", signal),
          sync,
          watchPaths: [storesDir],
          watchDirectoryPaths: [storesDir],
          watchFileExtensions: [".sqlite", ".sqlite-wal"],
        };
      },
    },
    {
      id: "apple-imessage",
      name: "Apple iMessage",
      description: "Messages from iMessage",
      unitName: "messages",
      // Voice clips are transcribed inline into the conversation rather than
      // emitted as separate attachment child-docs. iMessage only — the other
      // Apple sources are not conversation streams.
      conversational: true,
      contract: {
        state: appleImessageStateSpec,
        requires: ["state-envelope"],
      },
      icon: {
        sfSymbol: "bubble.left.and.bubble.right.fill",
        color: "#34C759",
        bgColor: "#14241F",
        imageDataUri: appleIMessageIconDataUri,
      },
      documentEventProfile: appleIMessageDocumentProfile,
      async create({ sourceId, providerId, dataCutoff, sourceConfig, host }, ctx) {
        const probeReadAccess = appleFileReadAccess(ctx.provider.imessageDbFilePath);
        const probeLocalStores = async () => [
          inspectIMessageTranscriptCache(host?.configDir ?? DEFAULT_CONFIG_DIR),
        ];
        if (!ctx.provider.hasIMessage) {
          return storeUnavailable(probeReadAccess, { lastRowId: 0 }, probeLocalStores);
        }

        const attachmentConfig = resolveAttachmentConfig(sourceConfig, {
          defaultEnabled: true,
          includeAudioTypes: host?.includeAudioTypes,
        });

        const source = new AppleIMessageSource(ctx.provider, {
          sourceId,
          providerId,
          dataCutoff,
          attachmentConfig,
          extractAttachment: host?.extractAttachment,
          transcribeAudio: host?.transcribeAudio,
          // The config ROOT, not `host.stateDir`. The transcript cache lives at
          // `<configDir>/apple-imessage/` with no account segment, so it is
          // shared by every Apple account on the host. Pointing it at the
          // per-account state dir would orphan the existing cache -- re-running
          // speech-to-text over every clip in it -- and silently fragment it.
          configDir: host?.configDir,
        });

        return {
          probeReadAccess,
          probeLocalStores,
          sync: (cursor) => source.sync(cursor),
          watchPaths: source.watchPaths,
          dispose: async () => source.dispose(),
        };
      },
    },
    {
      id: "apple-contacts",
      // See #2182 — Contact ZUNIQUEID values are host-local even for the
      // same iCloud address book. Joining replicas would duplicate every
      // logical person.
      multiDevice: { mode: "exclusive" },
      name: "Apple Contacts",
      description: "Contacts from Apple Contacts app",
      unitName: "contacts",
      contract: {
        state: appleContactsStateSpec,
        apiVersion: 2,
        requires: ["snapshot-sessions"],
      },
      icon: {
        sfSymbol: "person.crop.circle.fill",
        color: "#FF6B6B",
        bgColor: "#2D1818",
        imageDataUri: appleContactsIconDataUri,
      },
      documentEventProfile: appleContactsDocumentProfile,
      async create({ sourceId, providerId, dataCutoff }, ctx) {
        const probeReadAccess = ({ signal }: { signal: AbortSignal }) =>
          probeAppleStoresReadAccess(ctx.provider.contactsDirFilePath, "contacts", signal);
        if (!ctx.provider.hasContacts) {
          return storeUnavailable(probeReadAccess, { lastModifiedTimestamp: 0 });
        }

        const source = new AppleContactsSource(ctx.provider, {
          sourceId,
          providerId,
          dataCutoff,
          phoneRegion: ctx.phoneRegion,
        });

        return {
          probeReadAccess,
          sync: (cursor) => source.sync(cursor),
          watchPaths: source.watchPaths,
        };
      },
    },
    {
      id: "apple-calendar",
      // See #2182 — CalendarItem.UUID is host-local across macOS replicas.
      // Keep this exclusive until the provider owns a stable cross-host key.
      multiDevice: { mode: "exclusive" },
      name: "Apple Calendar",
      description: "Events from Apple Calendar app",
      unitName: "events",
      contract: {
        state: appleCalendarStateSpec,
      },
      icon: {
        sfSymbol: "calendar",
        color: "#FF3B30",
        bgColor: "#2D1414",
        imageDataUri: appleCalendarIconDataUri,
      },
      documentEventProfile: appleCalendarDocumentProfile,
      async create({ sourceId, providerId, dataCutoff }, ctx) {
        const probeReadAccess = appleFileReadAccess(ctx.provider.calendarDbFilePath);
        if (!ctx.provider.hasCalendar) {
          return storeUnavailable(probeReadAccess, { lastModifiedTimestamp: 0 });
        }

        const source = new AppleCalendarSource(ctx.provider, {
          sourceId,
          providerId,
          dataCutoff,
          phoneRegion: ctx.phoneRegion,
        });

        // Event documents sync alongside the analytics dual-push (#5 / #450): an
        // `apple_calendar_events` table and the synthesized doc↔row edge.
        return {
          probeReadAccess,
          sync: (cursor) => source.sync(cursor),
          syncStructured: (cursor) => source.syncStructured(cursor),
          analyticsSchemas: source.analyticsSchemas,
          watchPaths: source.watchPaths,
        };
      },
    },
    {
      id: "apple-call-log",
      name: "Apple Call Log",
      description: "Phone and FaceTime calls (macOS iCloud call-history sync)",
      unitName: "calls",
      contract: {
        state: appleCallLogStateSpec,
        requires: ["state-envelope"],
      },
      icon: {
        sfSymbol: "phone.fill",
        color: "#30D158",
        bgColor: "#122318",
        imageDataUri: appleCallLogIconDataUri,
      },
      documentEventProfile: appleCallLogDocumentProfile,
      async create({ sourceId, providerId, dataCutoff }, ctx) {
        const probeReadAccess = appleFileReadAccess(ctx.provider.callLogDbFilePath);
        if (!ctx.provider.hasCallLog) {
          return storeUnavailable(probeReadAccess, { lastModifiedTimestamp: 0 });
        }

        const source = new AppleCallLogSource(ctx.provider, {
          sourceId,
          providerId,
          dataCutoff,
          phoneRegion: ctx.phoneRegion,
        });

        // One `call-log` day-document per calendar day, alongside the
        // analytics dual-push: one `apple_call_log` row per raw call.
        return {
          probeReadAccess,
          sync: (cursor) => source.sync(cursor),
          syncStructured: (cursor) => source.syncStructured(cursor),
          analyticsSchemas: source.analyticsSchemas,
          watchPaths: source.watchPaths,
        };
      },
    },
    {
      id: "apple-voicemail",
      name: "Apple Voicemail",
      description: "Carrier voicemail transcripts synchronized by macOS Phone",
      unitName: "voicemails",
      contract: {
        state: appleVoicemailStateSpec,
        requires: ["state-envelope"],
      },
      icon: {
        sfSymbol: "recordingtape",
        color: "#30D158",
        bgColor: "#122318",
        imageDataUri: appleVoicemailIconDataUri,
      },
      documentEventProfile: appleVoicemailDocumentProfile,
      async create({ sourceId, providerId, dataCutoff }, ctx) {
        if (!ctx.provider.hasVoicemail) {
          throw new Error(
            "Apple Voicemail requires macOS 26 or later and a local Phone database. Open Phone and wait for voicemail to synchronize, then retry.",
          );
        }

        const source = new AppleVoicemailSource(ctx.provider, {
          sourceId,
          providerId,
          dataCutoff,
          phoneRegion: ctx.phoneRegion,
        });
        return {
          sync: (cursor) => source.sync(cursor),
          watchPaths: source.watchPaths,
          freshness: APPLE_VOICEMAIL_FRESHNESS,
          probeReadAccess: appleFileReadAccess(ctx.provider.voicemailDbFilePath, false),
        };
      },
    },
  ],
});
