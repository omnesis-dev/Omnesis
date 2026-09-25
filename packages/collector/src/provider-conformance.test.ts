// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import {
  formatConformanceReport,
  runProviderConformance,
  runSourceConformance,
  type SourceConformanceOptions,
} from "@omnesis/source-sdk/testing";
import { allDefinitions } from "./source-descriptors.js";
import type { SourceDefinition, SourceInstance } from "@omnesis/source-sdk";

// Hand-authored contract fixtures, not captured release output. Keep nonempty
// bookmarks so dropping a token/map during migration cannot pass as a fresh run.
const timestamp = "2026-01-02T00:00:00.000Z";
const agentCursor = {
  version: 2,
  scanKey: "fixture-root",
  files: {
    "session.jsonl": {
      size: 12,
      mtimeMs: 10,
      ctimeMs: 10,
      ino: 7,
      externalIds: ["session-a"],
      complete: true,
    },
  },
};
const githubCursor = {
  repos: { "example/widgets": { wm: timestamp } },
  pending: [],
  discoveryQueue: ["example/widgets"],
  missingRepos: { "example/retired": 1 },
  lane: { repo: "example/widgets", kind: "issues", after: "page-2", page: 2 },
  snapshotMode: false,
};
const notionCursor = {
  phase: "sync-db",
  databases: [{ id: "db-1", title: "Tasks", lastEditedTime: timestamp }],
  currentDbIndex: 0,
  inSnapshotMode: false,
  dbPageCursor: "page-2",
  emittedSummary: true,
  lastSyncTime: timestamp,
};
const calendarLegacy = {
  calendarSyncTokens: { primary: "sync-token" },
  pendingCalendars: ["primary"],
  resumePageToken: "page-2",
};
const outlookLegacy = {
  calendarLinks: { primary: "https://graph.microsoft.com/delta/primary" },
  pendingCalendars: ["secondary"],
  resumeLink: "https://graph.microsoft.com/page/secondary",
  windowStart: "2025-01-01T00:00:00.000Z",
  windowRefreshAfter: "2027-01-01T00:00:00.000Z",
  snapshotPresentIds: ["primary:event-1"],
  knownMasters: ["primary:master-1"],
};
const screenLegacy = {
  phase: "sessions",
  lastCreationDate: 100,
  sessionsProcessed: 12,
  affectedDates: ["2026-01-02"],
};

const current: Record<string, unknown> = {
  "apple-notes": { lastModifiedTimestamp: 700, lastModifiedPk: 12 },
  "apple-reminders": { lastModifiedTimestamp: 700, lastModifiedPk: 12 },
  "apple-imessage": { lastRowId: 500, lastDaySignatures: { "chat:2026-01-02": "signature" } },
  "apple-contacts": {
    lastModifiedTimestamp: 700,
    lastUniqueId: "person-1",
    bootstrapInProgress: true,
  },
  "apple-calendar": { lastModifiedTimestamp: 700, insertRowIdHighWater: 12 },
  "apple-call-log": { lastModifiedTimestamp: 700, affectedDates: ["2026-01-02"] },
  "apple-voicemail": { daySignatures: { "2026-01-02": "signature" } },
  "browser-history": {
    phase: "visits",
    lastVisitTime: { Default: 700 },
    visitsProcessed: 12,
    affectedDates: ["2026-01-02"],
  },
  "chrome-bookmarks": { fileChecksum: "checksum", knownIds: ["bookmark-1"] },
  "enable-banking-accounts": {
    phase: "incremental",
    accountIndex: 1,
    lastBookingDates: { account: "2026-01-02" },
    windowHashCounts: { transaction: 1 },
  },
  gmail: { phase: "incremental", historyId: "700", nextPageToken: "page-2" },
  "google-calendar": { ...calendarLegacy, occurrenceExpansion: false },
  "google-drive": { phase: "incremental", startPageToken: "token" },
  "google-contacts": { syncToken: "sync-token", pageToken: "page-2", processedThisCycle: 12 },
  imap: {
    phase: "incremental",
    mailboxes: { INBOX: { uidValidity: "1", lastUid: 42 } },
    pendingMailboxPaths: ["Archive"],
  },
  "local-files": {
    version: 1,
    fileMap: {
      "notes.txt": {
        mtime: 10,
        contentHash: "hash",
        rawHash: "raw",
        size: 12,
        inode: 7,
        device: 1,
        stableId: "file-1",
      },
    },
  },
  "lunchflow-accounts": {
    phase: "transactions",
    accountIndex: 1,
    lastDates: { account: "2026-01-02" },
    currencies: { account: "USD" },
  },
  "notion-pages": { lastEditedTime: timestamp, startCursor: "page-2", snapshotIds: ["page-1"] },
  "notion-databases": notionCursor,
  "obsidian-notes": {
    version: 2,
    fileMap: {
      "note.md": { mtime: 10, contentHash: "hash", size: 12, inode: 7, stableId: "note-1" },
    },
  },
  "outlook-email": { phase: "incremental", folderDeltas: { inbox: "delta-token" } },
  onedrive: {
    phase: "incremental",
    link: "https://graph.microsoft.com/delta",
    seen: { "file-1": "etag" },
  },
  "outlook-calendar": {
    calendarLinks: outlookLegacy.calendarLinks,
    pendingCalendars: outlookLegacy.pendingCalendars,
    resumeLink: outlookLegacy.resumeLink,
    windowStart: outlookLegacy.windowStart,
    windowRefreshAfter: outlookLegacy.windowRefreshAfter,
    snapshotCalendars: ["primary"],
  },
  "screen-time": { ...screenLegacy, lastPk: 42 },
  "strava-activities": {
    phase: "incremental",
    lastActivityTimestamp: 700,
    pendingSocialStamps: ["1"],
    pendingDetailStamps: ["2"],
  },
  things: { lastModifiedTimestamp: 700, cycleQueueTotal: 12 },
  "claude-code": agentCursor,
  codex: agentCursor,
  pi: agentCursor,
  coinbase: { phase: "orders", pageCursor: "page-2", ledgerWatermarks: { account: timestamp } },
  github: githubCursor,
  "github-commits": githubCursor,
  "granola-meetings": {
    reconciliationVersion: 2,
    phase: "incremental",
    pageCursor: "page-2",
    syncedUpTo: timestamp,
  },
  plaid: { phase: "transactions", transactionsCursor: "page-2", lastSnapshotDate: "2026-01-02" },
  "whatsapp-messages": {
    phase: "incremental",
    lastTimestamp: 700,
    committedSeq: 42,
    storeId: "store-1",
  },
};

const historical: Record<string, unknown> = {
  "granola-meetings": { phase: "incremental", pageCursor: "page-2", syncedUpTo: timestamp },
  "google-calendar": calendarLegacy,
  "notion-databases": notionCursor,
  "obsidian-notes": { fileMap: { "note.md": { mtime: 10, contentHash: "hash" } } },
  "outlook-calendar": outlookLegacy,
  "screen-time": screenLegacy,
  github: githubCursor,
  "github-commits": githubCursor,
};
const expectations: Record<string, (state: Record<string, unknown>) => void> = {
  "granola-meetings": (state) =>
    expect(state).toEqual({
      ...(historical["granola-meetings"] as Record<string, unknown>),
      reconciliationVersion: 2,
    }),
  "google-calendar": (state) =>
    expect(state).toEqual({ ...calendarLegacy, occurrenceExpansion: false }),
  "notion-databases": (state) => expect(state).toEqual(notionCursor),
  "screen-time": (state) => expect(state).toEqual({ ...screenLegacy, lastPk: 0 }),
  github: (state) => expect(state).toMatchObject(githubCursor),
  "github-commits": (state) => expect(state).toMatchObject(githubCursor),
  "obsidian-notes": (state) =>
    expect(state).toMatchObject({ version: 2, fileMap: {}, pendingMigrationDeletes: ["note.md"] }),
  "outlook-calendar": (state) => {
    expect(state).toMatchObject({
      calendarLinks: outlookLegacy.calendarLinks,
      pendingCalendars: outlookLegacy.pendingCalendars,
      resumeLink: outlookLegacy.resumeLink,
      windowStart: outlookLegacy.windowStart,
    });
    expect(state.snapshotPresentIds).toBeUndefined();
    expect(state.windowRefreshAfter).toBe("1970-01-01T00:00:00.000Z");
  },
};

// Intentionally incompatible generations must restart/refuse, not silently
// resume a bookmark whose ordering or output identity no longer matches.
const incompatible: Record<string, unknown> = {
  "outlook-calendar": { phase: "incremental", link: "https://graph.microsoft.com/delta/legacy" },
  github: { ...githubCursor, renderVersion: 999 },
  "github-commits": { ...githubCursor, renderVersion: 999 },
  "screen-time": { ...screenLegacy, lastCreationDate: "invalid" },
  "claude-code": { ...agentCursor, version: 999 },
  codex: { ...agentCursor, version: 999 },
  pi: { ...agentCursor, version: 999 },
};

function options(id: string, version?: number): SourceConformanceOptions {
  if (version === undefined) return {};
  expect(current, `${id} needs a current cursor fixture`).toHaveProperty(id);
  const old = historical[id];
  if (version > 1) expect(old, `${id} needs a historical cursor fixture`).toBeDefined();
  return {
    stateFixtures: { ...(old === undefined ? {} : { 1: old }), [version]: current[id] },
    legacyStateFixtures: old === undefined ? [current[id]] : [old, current[id]],
    refusedStateFixtures: [
      "unreadable-state",
      ...(incompatible[id] === undefined ? [] : [incompatible[id]]),
    ],
    expectMigrated: expectations[id] ? { 1: expectations[id] } : undefined,
  };
}

describe("registered provider contract conformance", () => {
  // Factory checks deliberately use explicit temporary roots. Discovery and
  // default local paths must never inspect the test operator's real stores.
  it.each(["local-files", "obsidian-notes", "chrome-bookmarks", "claude-code", "codex", "pi"])(
    "%s: declaration matches its actual isolated factory",
    async (id) => {
      const definition = allDefinitions.find(
        (candidate) => candidate.type === "source" && candidate.id === id,
      );
      if (!definition || definition.type !== "source" || !definition.create)
        throw new Error(`Missing factory for ${id}`);
      const root = await mkdtemp(join(tmpdir(), "omnesis-conformance-"));
      let instance: SourceInstance | undefined;
      try {
        const configs: Record<string, Record<string, unknown>> = {
          "local-files": { roots: [root], exclude: [] },
          "obsidian-notes": { vaultPath: root, exclude: [] },
          "chrome-bookmarks": { basePath: root, profileDir: "Default" },
          "claude-code": { sessionsPath: root },
          codex: { codexHome: root },
          pi: { sessionsPath: root },
        };
        if (id === "obsidian-notes") await mkdir(join(root, ".obsidian"));
        const report = await runSourceConformance(definition, {
          ...options(id, definition.contract?.state?.version),
          instantiate: async () => {
            instance = await definition.create!({
              sourceId: SourceId(`${id}:fixture`),
              providerId: ProviderId(`${id}:fixture`),
              accountId: "fixture",
              config: configs[id],
            });
            return instance;
          },
        });
        expect(report.findings, formatConformanceReport(report)).toEqual([]);
      } finally {
        await instance?.dispose?.();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps fixtures in exact correspondence with stateful registered sources", () => {
    const sources = allDefinitions.flatMap<Pick<SourceDefinition, "id" | "contract">>(
      (definition) => ("sources" in definition ? definition.sources : [definition]),
    );
    expect(
      sources
        .filter((source) => source.contract?.state)
        .map((source) => source.id)
        .sort(),
    ).toEqual(Object.keys(current).sort());
    expect(
      sources
        .filter((source) => (source.contract?.state?.version ?? 1) > 1)
        .map((source) => source.id)
        .sort(),
    ).toEqual(Object.keys(historical).sort());
  });

  for (const definition of allDefinitions) {
    const name = "sources" in definition ? definition.provider.id : definition.id;
    it(`${name}: real declarations, current/legacy state, migrations and downgrade refusal`, async () => {
      const reports =
        "sources" in definition
          ? await runProviderConformance(
              definition,
              Object.fromEntries(
                definition.sources.map((source) => [
                  source.id,
                  options(source.id, source.contract?.state?.version),
                ]),
              ),
            )
          : [
              await runSourceConformance(
                definition,
                options(definition.id, definition.contract?.state?.version),
              ),
            ];
      for (const report of reports)
        expect(report.findings, formatConformanceReport(report)).toEqual([]);
    });
  }
});
