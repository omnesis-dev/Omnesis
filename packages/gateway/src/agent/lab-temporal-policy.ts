// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { labFeatureEnabled } from "../lab/store.js";
import { taskDocumentHidden } from "../lab/document-policy.js";
import type Database from "better-sqlite3";
import type { TemporalReadPort } from "@omnesis/agent";

/** Stored temporal evidence remains readable; disabled Tasks contribute no task references. */
export function withTaskTemporalPolicy(
  port: TemporalReadPort,
  db: Database.Database,
): TemporalReadPort {
  return {
    async query(input, signal) {
      const result = await port.query(input, signal);
      if (labFeatureEnabled(db, "tasks")) return result;
      return {
        ...result,
        items: result.items
          .filter((item) => {
            const documentId = item.mention?.documentId ?? item.projection?.documentId;
            return !documentId || !taskDocumentHidden(db, documentId);
          })
          .map((item) =>
            item.annotation
              ? {
                  ...item,
                  annotation: {
                    ...item.annotation,
                    loopIds: [],
                    documentIds: item.annotation.documentIds.filter(
                      (id) => !taskDocumentHidden(db, id),
                    ),
                  },
                }
              : item,
          ),
      };
    },
  };
}
