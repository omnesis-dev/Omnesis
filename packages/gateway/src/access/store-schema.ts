// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createV152AccessTables } from "../data/migration-152-access-grants.js";
import { migrateV153AccessPolicyFamilies } from "../data/migration-153-access-policy-families.js";
import { migrateV154ConfidentialOAuthClients } from "../data/migration-154-confidential-oauth-clients.js";
import { addOAuthRefreshRetryColumns } from "../data/migration-160-oauth-refresh-retry.js";
import { indexPrincipalCredentialsByExecutionDevice } from "../data/migration-162-principal-credential-device-index.js";
import { addNotesAccessCapability } from "../data/migration-163-notes-access.js";
import { createAccessLevelTables } from "../data/migration-171-access-levels.js";
import type { Db } from "../data/types.js";

/** Install the current access schema on a fresh database. */
export function createAccessTables(db: Db): void {
  const schemaVersion = db.pragma("user_version", { simple: true }) as number;
  // The V1 base is frozen for upgrades from schema 151. Later live-schema
  // additions belong here after this call and in a newly numbered migration.
  // Existing installs advance only through the numbered migration runner.
  // Calling a historical transform from schema setup would run it out of
  // order and outside any transaction/foreign-key handling it owns. A fresh
  // database can install the current idempotent shape directly because it has
  // no historical rows to transform.
  if (schemaVersion === 0) {
    createV152AccessTables(db);
    migrateV153AccessPolicyFamilies(db);
    migrateV154ConfidentialOAuthClients(db);
    addOAuthRefreshRetryColumns(db);
    indexPrincipalCredentialsByExecutionDevice(db);
    addNotesAccessCapability(db);
    createAccessLevelTables(db);
  }
}
