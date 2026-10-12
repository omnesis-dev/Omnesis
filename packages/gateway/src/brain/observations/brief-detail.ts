// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a sent morning brief was based on: the observations it shipped, in the
 * order it showed them, with the documents each cites and the tasks each
 * relates to. Read-only — every query here runs on a reader connection.
 */

import { parseSourceKey } from "@omnesis/core";
import { getDocumentTitlesAndSources } from "../../db.js";
import {
  getSentMorningBrief,
  listMorningBriefItemsForMessage,
} from "../storage/morning-brief-items.js";
import { getObservation } from "../storage/observations.js";
import { getOpenLoop } from "../storage/open-loops.js";
import type { DailyBriefDetail } from "../../agent/daily-brief-detail.js";
import type { ObservationRow } from "../storage/types.js";
import type Database from "better-sqlite3";

export interface ShippedBriefItem {
  /** The item's number as the brief showed it, from 1. */
  rank: number;
  observation: ObservationRow;
}

/**
 * The observations a sent brief shipped, numbered as the brief showed them.
 * An item the composer left out was never shown and takes no number, while
 * one deleted since keeps its place (its rank still counts).
 */
export function shippedBriefItems(db: Database.Database, messageId: string): ShippedBriefItem[] {
  const shipped: ShippedBriefItem[] = [];
  let leftOut = 0;
  for (const item of listMorningBriefItemsForMessage(db, messageId)) {
    const observation = getObservation(db, item.observationId);
    if (!observation) continue;
    if (observation.state !== "shipped" || observation.shippedMessageId !== messageId) {
      leftOut += 1;
      continue;
    }
    shipped.push({ rank: item.rank - leftOut, observation });
  }
  return shipped;
}

function sourceTypeOf(sourceId: string): string | null {
  try {
    return parseSourceKey(sourceId).sourceType;
  } catch {
    return null;
  }
}

function isoOrNull(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** One sent brief's items with their sources and tasks, and when it was sent. */
export function readDailyBriefDetail(
  db: Database.Database,
  brief: { day: string; messageId: string },
): DailyBriefDetail {
  const sent = getSentMorningBrief(db, brief.day);
  const items = shippedBriefItems(db, brief.messageId);
  const documents = getDocumentTitlesAndSources(db, [
    ...new Set(items.flatMap((item) => item.observation.citations)),
  ]);
  return {
    sentAt: sent && sent.messageId === brief.messageId ? new Date(sent.sentAt).toISOString() : null,
    items: items.map(({ rank, observation }) => ({
      rank,
      observationId: observation.id,
      summary: observation.summary,
      sources: observation.citations.flatMap((id) => {
        const doc = documents.get(id);
        return doc
          ? [
              {
                id,
                title: doc.title || null,
                sourceType: sourceTypeOf(doc.sourceId),
                createdAt: isoOrNull(doc.createdAt),
              },
            ]
          : [];
      }),
      tasks: observation.relatedLoopIds.flatMap((id) => {
        const loop = getOpenLoop(db, id);
        return loop ? [{ id, title: loop.title, state: loop.state }] : [];
      }),
    })),
  };
}
