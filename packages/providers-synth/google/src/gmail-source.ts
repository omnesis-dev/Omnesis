// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { syncPage, type SourceInstance } from "@omnesis/source-sdk";
import {
  impairEntries,
  pageFromFixture,
  synthPartitionOf,
  type SynthCursor,
} from "@omnesis/providers-synth-common";
import { mapEmail, type EmailEntry } from "./fixtures.js";
import {
  hasBinaryAttachments,
  mapEmailWithAssets,
  type GmailFixtureExtraction,
} from "./gmail-attachments.js";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";

interface GmailFixtureCursor extends SynthCursor {
  /** Successfully emitted binary-message children, preserved across restart. */
  attachmentIds?: string[];
  /** Each observed parent records its attachment definition, including no-child outcomes. */
  binaryParents?: [string, string][];
}

/** Keep expensive byte extraction on the current page, never the snapshot enumeration. */
export function createGmailFixtureSource(
  entries: EmailEntry[],
  context: { sourceId: SourceId; providerId: ProviderId },
  extraction: GmailFixtureExtraction,
): SourceInstance<GmailFixtureCursor> {
  const partitions = new Map(
    entries.map((entry, index) => [entry.externalId, synthPartitionOf(index)]),
  );
  return {
    async sync(cursor) {
      if (
        cursor?.attachmentIds !== undefined &&
        (!Array.isArray(cursor.attachmentIds) ||
          cursor.attachmentIds.length > entries.length * 20 ||
          cursor.attachmentIds.some(
            (id) => typeof id !== "string" || id.length > 4096 || !id.includes("/att/"),
          ))
      )
        throw new Error("Invalid synthetic Gmail attachment cursor");
      if (
        cursor?.binaryParents !== undefined &&
        (!Array.isArray(cursor.binaryParents) ||
          cursor.binaryParents.length > entries.length ||
          cursor.binaryParents.some(
            (pair) =>
              !Array.isArray(pair) ||
              pair.length !== 2 ||
              typeof pair[0] !== "string" ||
              pair[0].length > 4096 ||
              typeof pair[1] !== "string" ||
              !/^[a-f0-9]{64}$/.test(pair[1]),
          ))
      )
        throw new Error("Invalid synthetic Gmail parent cursor");
      const observed = new Map(cursor?.binaryParents ?? []);
      const signature = (entry: EmailEntry): string =>
        createHash("sha256")
          .update(JSON.stringify(entry.attachments ?? []))
          .digest("hex");
      const retained = new Map<string, string[]>();
      for (const id of cursor?.attachmentIds ?? []) {
        const parentId = id.slice(0, id.lastIndexOf("/att/"));
        const ids = retained.get(parentId) ?? [];
        ids.push(id);
        retained.set(parentId, ids);
      }
      const { visible, snapshotAllowed, partitioned } = impairEntries(
        entries,
        context.sourceId,
        (entry) => entry.externalId,
      );
      const { batch, newCursor, hasMore, isFinalPage } = pageFromFixture(visible, cursor);
      const documents: DocumentInput[] = [];
      for (const entry of batch) {
        const mapped = await mapEmailWithAssets(entry, context, extraction);
        const docs = Array.isArray(mapped) ? mapped : [mapped];
        documents.push(
          ...docs.map((doc) => ({ ...doc, partitionKey: partitions.get(entry.externalId) ?? "" })),
        );
        if (hasBinaryAttachments(entry)) {
          observed.set(entry.externalId, signature(entry));
          retained.set(
            entry.externalId,
            docs.slice(1).map((doc) => doc.externalId),
          );
        }
      }
      const idsOf = (entry: EmailEntry): string[] => {
        if (hasBinaryAttachments(entry))
          return [entry.externalId, ...(retained.get(entry.externalId) ?? [])];
        const mapped = mapEmail(entry, context);
        return (Array.isArray(mapped) ? mapped : [mapped]).map((doc) => doc.externalId);
      };
      const attachmentIds = entries.flatMap((entry) => retained.get(entry.externalId) ?? []);
      const next: GmailFixtureCursor = {
        ...newCursor,
        attachmentIds,
        binaryParents: entries
          .filter((entry) => observed.has(entry.externalId))
          .map((entry) => [entry.externalId, observed.get(entry.externalId)!]),
      };
      const inventoryKnown = visible.every(
        (entry) =>
          !hasBinaryAttachments(entry) || observed.get(entry.externalId) === signature(entry),
      );
      if (partitioned) {
        const claims = new Map<string, string[]>();
        for (const entry of visible) {
          const partition = partitions.get(entry.externalId) ?? "";
          const ids = claims.get(partition) ?? [];
          ids.push(...idsOf(entry));
          claims.set(partition, ids);
        }
        return syncPage(documents, next, {
          hasMore,
          presentClaims:
            isFinalPage && inventoryKnown
              ? [...claims].map(([partition, ids]) => ({ partition, ids }))
              : undefined,
        });
      }
      return syncPage(documents, next, {
        hasMore,
        presentExternalIds:
          isFinalPage && snapshotAllowed && inventoryKnown ? visible.flatMap(idsOf) : undefined,
      });
    },
  };
}
