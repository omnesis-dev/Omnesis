// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createStorageRetentionBindingTables } from "../storage/retention-bindings.js";
import { createStorageTrimJobsTables } from "../storage/trim-job-store.js";
import type Database from "better-sqlite3";

/** Policy authority and bounded trim progress survive gateway restarts independently of config. */
export function addStorageAuthority(db: Database.Database): void {
  createStorageRetentionBindingTables(db);
  createStorageTrimJobsTables(db);
}
