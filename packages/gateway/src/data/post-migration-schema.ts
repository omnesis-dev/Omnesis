// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { installTemporalDocumentEpochs } from "../brain/knowledge/temporal-document-epochs.js";
import { installConversationEvidence } from "../sources/omnesis-chat/evidence-projection.js";
import type { Db } from "./types.js";

/** Trusted cross-table setup shared by live boot and restored database construction. */
export function runPostMigrationSchemaSetup(db: Db): void {
  // Historical table rebuilds must finish before installing these triggers.
  db.transaction(() => installTemporalDocumentEpochs(db))();
  db.transaction(() => installConversationEvidence(db))();
}
