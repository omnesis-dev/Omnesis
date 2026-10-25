// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Opaque cursor contracts for the product loop routes.
 *
 * The cursor owns every field that affects ordering or filtering.
 */

import { BadRequestError, StalePageCursorError } from "../http/errors.js";
import { decodePageCursor, encodePageCursor } from "../http/pagination-cursor.js";
import type { OpenLoopState } from "./storage/types.js";

const LOOPS_SCOPE = "product-loops";

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
