// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { listPrivacyExchangeFeed, listPrivacyExchangePresentations } from "./presentation.js";
import { PrivacyCursorError, type PrivacyDb } from "./store-types.js";
import type {
  PrivacyExchangeFeedPage,
  PrivacyExchangePresentationPage,
} from "@omnesis/types/privacy";

/** The feed page to read; see `listPrivacyExchangeFeed`. */
export interface PrivacyExchangeFeedRequest {
  limit: number;
  cursor?: string;
}

/** One page of a conversation's exchanges; see `listPrivacyExchangePresentations`. */
export interface PrivacyConversationExchangesRequest {
  conversationId: string;
  limit: number;
  cursor?: string;
  includeAgentTracesTaskId?: string;
}

/**
 * A page, or the refusal of a cursor no page handed out. A read on the worker
 * reports a thrown error only as a failure, so the refusal travels as data,
 * and the caller raises it where the read was asked for.
 */
export type PrivacyExchangeRead<T> = { page: T } | { invalidCursor: true };

/**
 * Where the Privacy page's exchange reads run. A page joins every exchange
 * with its workflow, release, approval and audit records and builds its
 * presentation, which on a long history is too much work for the main event
 * loop, so the gateway passes its read worker. Each read takes the clock the
 * request was answered at, so the worker presents an approval's expiry as the
 * request saw it.
 */
export interface PrivacyExchangeReads {
  privacyExchangeFeed(
    request: PrivacyExchangeFeedRequest,
    now: number,
  ): Promise<PrivacyExchangeRead<PrivacyExchangeFeedPage>>;
  privacyConversationExchanges(
    request: PrivacyConversationExchangesRequest,
    now: number,
  ): Promise<PrivacyExchangeRead<PrivacyExchangePresentationPage | null>>;
}

export function readPrivacyExchangeFeed(
  db: PrivacyDb,
  request: PrivacyExchangeFeedRequest,
  now: number,
): PrivacyExchangeRead<PrivacyExchangeFeedPage> {
  return refusingInvalidCursor(() => listPrivacyExchangeFeed(db, request, now));
}

export function readPrivacyConversationExchanges(
  db: PrivacyDb,
  request: PrivacyConversationExchangesRequest,
  now: number,
): PrivacyExchangeRead<PrivacyExchangePresentationPage | null> {
  return refusingInvalidCursor(() =>
    listPrivacyExchangePresentations(
      db,
      request.conversationId,
      request.limit,
      request.cursor,
      now,
      request.includeAgentTracesTaskId,
    ),
  );
}

/** The page a read returns, raising a refused cursor as `PrivacyCursorError`. */
export function exchangePage<T>(read: PrivacyExchangeRead<T>): T {
  if ("invalidCursor" in read) throw new PrivacyCursorError();
  return read.page;
}

function refusingInvalidCursor<T>(read: () => T): PrivacyExchangeRead<T> {
  try {
    return { page: read() };
  } catch (err) {
    if (err instanceof PrivacyCursorError) return { invalidCursor: true };
    throw err;
  }
}

/** The exchange reads on the caller's own handle, delivered as the worker delivers them. */
export function directPrivacyExchangeReads(db: PrivacyDb): PrivacyExchangeReads {
  return {
    privacyExchangeFeed: (request, now) =>
      new Promise((resolve) => resolve(readPrivacyExchangeFeed(db, request, now))),
    privacyConversationExchanges: (request, now) =>
      new Promise((resolve) => resolve(readPrivacyConversationExchanges(db, request, now))),
  };
}
