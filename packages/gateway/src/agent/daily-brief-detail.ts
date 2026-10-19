// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What one morning brief in the Morning brief conversation was based on: the
 * observations it shipped, in the order it showed them, each with the
 * documents it cites and the tasks it relates to. Served by
 * `GET /agent/conversations/:id/briefs/:day`; the Brain supplies the reader.
 */

/** A cited document that still exists. */
export interface DailyBriefItemSource {
  id: string;
  title: string | null;
  /** The document's source type, as stored. */
  sourceType: string | null;
  /** The source's own creation time (ISO 8601). */
  createdAt: string | null;
}

/** A related task, with its current title and state. */
export interface DailyBriefItemTask {
  id: string;
  title: string;
  state: string;
}

/** The owner's current thumbs on an item, when they gave one. */
export interface DailyBriefItemReaction {
  kind: "up" | "not_interested" | "factual_error";
  /** Their words: why they are not interested, or the correction. */
  note?: string;
  /** When the reaction was last set (ISO 8601 UTC). */
  at: string;
}

export interface DailyBriefItemDetail {
  /** The item's number as the brief showed it, from 1. */
  rank: number;
  observationId: string;
  summary: string;
  sources: DailyBriefItemSource[];
  tasks: DailyBriefItemTask[];
  reaction?: DailyBriefItemReaction;
}

export interface DailyBriefDetail {
  /** When the brief was sent (ISO 8601 UTC), or null when no send was recorded. */
  sentAt: string | null;
  items: DailyBriefItemDetail[];
}

/** Reads one sent brief's detail; read-only. */
export type DailyBriefDetailReader = (brief: {
  day: string;
  messageId: string;
}) => DailyBriefDetail;
