// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Opaque cursor contracts for the product Briefs and Radar routes.
 *
 * The cursor owns every field that affects ordering or filtering. Feed pages
 * also freeze the ranking clock at the first request so tier boundaries and
 * deadline proximity cannot shift underneath a multi-page walk.
 */

import { BadRequestError, StalePageCursorError } from "../http/errors.js";
import { decodePageCursor, encodePageCursor } from "../http/pagination-cursor.js";
import { FEED_TIER, type BriefFeedSortKey, type FeedTier } from "./ranking.js";
import type { OpenLoopState } from "./storage/types.js";

const FEED_SCOPE = "briefs-feed";
const LOOPS_SCOPE = "product-loops";

export interface BriefFeedPageCursor {
  snapshotNow: number;
  snapshotReadAt: number;
  after: BriefFeedSortKey;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nullableFiniteNumber(value: unknown): value is number | null {
  return value === null || finiteNumber(value);
}

function feedTier(value: unknown): value is FeedTier {
  return finiteNumber(value) && (Object.values(FEED_TIER) as number[]).includes(value);
}

function briefSortKey(value: unknown): BriefFeedSortKey | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const key = value as Record<string, unknown>;
  if (
    (key.readGroup !== 0 && key.readGroup !== 1) ||
    !feedTier(key.tier) ||
    !nullableFiniteNumber(key.eventAt) ||
    !finiteNumber(key.proximity) ||
    key.proximity < 0 ||
    key.proximity > 1 ||
    !finiteNumber(key.urgency) ||
    !finiteNumber(key.confidence) ||
    !nullableFiniteNumber(key.relevantUntil) ||
    !finiteNumber(key.createdAt) ||
    typeof key.id !== "string" ||
    key.id.length === 0
  ) {
    return null;
  }
  if (key.tier <= FEED_TIER.today && key.eventAt === null) return null;
  return {
    readGroup: key.readGroup,
    tier: key.tier,
    eventAt: key.eventAt,
    proximity: key.proximity,
    urgency: key.urgency,
    confidence: key.confidence,
    relevantUntil: key.relevantUntil,
    createdAt: key.createdAt,
    id: key.id,
  };
}

export function parseBriefFeedPageCursor(raw: string | undefined): BriefFeedPageCursor | null {
  return decodePageCursor(raw, FEED_SCOPE, (payload) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const value = payload as Record<string, unknown>;
    const after = briefSortKey(value.after);
    if (!finiteNumber(value.snapshotNow) || !finiteNumber(value.snapshotReadAt) || !after)
      return null;
    return { snapshotNow: value.snapshotNow, snapshotReadAt: value.snapshotReadAt, after };
  });
}

export function nextBriefFeedPageCursor(
  snapshotNow: number,
  snapshotReadAt: number,
  after: BriefFeedSortKey,
): string {
  return encodePageCursor(FEED_SCOPE, { snapshotNow, snapshotReadAt, after });
}

export type ProductLoopFilter = "all" | "active" | "resolved";

export function parseProductLoopFilter(raw: string | undefined): ProductLoopFilter {
  if (raw === undefined || raw === "" || raw === "all") return "all";
  if (raw === "active" || raw === "resolved") return raw;
  throw new BadRequestError('"state" must be one of: active, resolved, all');
}

export function productLoopStates(filter: ProductLoopFilter): readonly OpenLoopState[] | undefined {
  if (filter === "active") return ["open", "snoozed"];
  if (filter === "resolved") return ["done", "dismissed"];
  return undefined;
}

export interface ProductLoopPageKey {
  importance: number;
  lastUpdate: number;
  id: string;
}

export function parseProductLoopPageCursor(
  raw: string | undefined,
  state: ProductLoopFilter,
  revision: number,
): ProductLoopPageKey | null {
  return decodePageCursor(raw, LOOPS_SCOPE, (payload) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const value = payload as Record<string, unknown>;
    if (
      value.state !== state ||
      typeof value.revision !== "number" ||
      !Number.isSafeInteger(value.revision) ||
      !finiteNumber(value.importance) ||
      !finiteNumber(value.lastUpdate) ||
      typeof value.id !== "string" ||
      value.id.length === 0
    ) {
      return null;
    }
    if (value.revision !== revision) throw new StalePageCursorError();
    return {
      importance: value.importance,
      lastUpdate: value.lastUpdate,
      id: value.id,
    };
  });
}

export function nextProductLoopPageCursor(
  state: ProductLoopFilter,
  revision: number,
  after: ProductLoopPageKey,
): string {
  return encodePageCursor(LOOPS_SCOPE, { state, revision, ...after });
}
