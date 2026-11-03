// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The io ops that read the watch journal rather than `omnesis.db`.
 *
 * The journal is a file of its own with a storage key of its own, so the io
 * worker holds a second read-only connection for these and passes it where
 * `ioHandlers` pass the gateway handle. Names share the `io.` namespace and
 * the same `IoOps` task table.
 */

import { journalDocumentHistories, type JournalHistoryRequest } from "../watch/journal-document.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

export const ioJournalHandlers = {
  "io.watchDocumentHistories": (journal: Db, requests: JournalHistoryRequest[]) =>
    journalDocumentHistories(journal, requests),
} as const;

export type IoJournalHandlers = typeof ioJournalHandlers;
