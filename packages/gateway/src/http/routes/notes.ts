// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP surface of the omnesis-notes quick-capture source ("tell the
 * brain"). The runtime is always available: capture is a standard gateway
 * capability and does not depend on an agent model or experimental mode.
 *
 * Five routes: capture POST, per-day listing GET, newest-first history
 * GET, per-entry edit PATCH, and per-entry hard-delete DELETE. Writes are
 * `scope.writeAny()` + a per-source refinement (`write:omnesis-notes`,
 * satisfied by admin / `write:*`); the listing and history are
 * `scope.read()`.
 */

import { DAY_KEY_RE, dayKeyFor } from "../../sources/omnesis-notes/index.js";
import { notesRateLimiter } from "../../rate-limit.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import { enforceWriteScopeForSource, scope } from "../scope.js";
import { validateJson } from "../validate.js";
import { createNoteBody, patchNoteBody } from "../schemas/index.js";
import { clientIp, isLoopbackRequest } from "./admin/internals.js";
import type { OmnesisNotesRuntime } from "../../sources/omnesis-notes/index.js";
import type { RouteApp } from "./types.js";

export interface NotesRoutesDeps {
  /** Resolve the notes runtime. The server defers boot until first use when no lifecycle owner exists. */
  runtime: OmnesisNotesRuntime | (() => OmnesisNotesRuntime);
}

const HISTORY_DEFAULT_LIMIT = 25;
const HISTORY_MAX_LIMIT = 100;

function clampHistoryLimit(raw: string | undefined): number {
  if (raw === undefined) return HISTORY_DEFAULT_LIMIT;
  // Strict digits: `parseInt` would silently coerce "25abc" → 25 and
  // "3.9" → 3, and its result is never Infinite, so the finiteness check
  // below could never fire on its own.
  if (!/^\d+$/.test(raw)) {
    throw new BadRequestError("limit must be a positive integer");
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed <= 0) {
    throw new BadRequestError("limit must be a positive integer");
  }
  return Math.min(parsed, HISTORY_MAX_LIMIT);
}

/**
 * Opaque history cursor: base64url of {c: captured_at, i: id}. Unsigned
 * by design: the feed is read-only over the caller's own readable
 * dataset, so the cursor encodes no authority — it is only a position,
 * and a forged one replays cleanly to a plain offset page.
 */
function encodeHistoryCursor(cursor: { capturedAt: string; id: string }): string {
  return Buffer.from(JSON.stringify({ c: cursor.capturedAt, i: cursor.id }), "utf8").toString(
    "base64url",
  );
}

function decodeHistoryCursor(raw: string | undefined): { capturedAt: string; id: string } | null {
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new BadRequestError("cursor is malformed");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { c?: unknown }).c !== "string" ||
    typeof (parsed as { i?: unknown }).i !== "string" ||
    (parsed as { c: string }).c.length === 0 ||
    (parsed as { i: string }).i.length === 0 ||
    Number.isNaN(Date.parse((parsed as { c: string }).c))
  ) {
    throw new BadRequestError("cursor is malformed");
  }
  return {
    capturedAt: (parsed as { c: string }).c,
    id: (parsed as { i: string }).i,
  };
}

export function mountNotesRoutes(app: RouteApp, deps: NotesRoutesDeps): void {
  const captureLimiter = notesRateLimiter();
  const runtime = (): OmnesisNotesRuntime =>
    typeof deps.runtime === "function" ? deps.runtime() : deps.runtime;

  app.post("/notes", scope.writeAny(), validateJson(createNoteBody), async (c) => {
    // Per-IP rate limit with the loopback exemption (a same-host client
    // already has full local access); the check reads the raw socket so
    // a forwarded IP can't spoof it. The ceiling is human-capture-scale
    // — it stops a pathological capture loop, never a human's cadence.
    if (!isLoopbackRequest(c) && captureLimiter.consume(clientIp(c))) {
      return c.json({ error: "Too many capture requests — try again later" }, 429, {
        "Retry-After": "60",
      });
    }
    const auth = c.get("auth");
    enforceWriteScopeForSource(auth.scopes, "omnesis-notes");
    const body = c.req.valid("json");
    const entry = await runtime().capture({
      id: body.id,
      text: body.text,
      capturedAt: body.capturedAt,
      capturedTimeZoneId: body.capturedTimeZoneId,
      capturedUtcOffsetSeconds: body.capturedUtcOffsetSeconds,
      surface: body.surface,
      deviceId: body.deviceId,
      latitude: body.latitude,
      longitude: body.longitude,
      placeName: body.placeName,
    });
    return c.json(entry, 201);
  });

  app.get("/notes", scope.read(), async (c) => {
    const day = c.req.query("day");
    if (day !== undefined && !DAY_KEY_RE.test(day)) {
      throw new BadRequestError("day must be YYYY-MM-DD");
    }
    const entries = runtime().listDay(day);
    return c.json({ day: day ?? dayKeyFor(new Date().toISOString()), entries });
  });

  // Newest-first cross-day history for the Tell Omnesis manager.
  // Bounded pages (`limit`, default 25, max 100) over a stable
  // (`captured_at` DESC, `id` ASC) order with an opaque cursor — a
  // concurrent wall-clock capture sorts before any live cursor, so
  // in-flight pages never shift. (Backdated captures can land inside an
  // already-served range and be missed by that page; a manager needing
  // completeness re-fetches from the head.) `day` seeds the first page
  // at that day (a Manage-notes link from an old daily document lands on
  // relevant notes even when the day itself is now empty). `day` and
  // `cursor` are mutually exclusive: a cursor already positions the
  // feed, so combining them would silently drop the seed.
  app.get("/notes/history", scope.read(), async (c) => {
    const day = c.req.query("day");
    if (day !== undefined && !DAY_KEY_RE.test(day)) {
      throw new BadRequestError("day must be YYYY-MM-DD");
    }
    const rawCursor = c.req.query("cursor");
    if (day !== undefined && rawCursor !== undefined) {
      throw new BadRequestError(
        "day and cursor are mutually exclusive; omit day when continuing a feed",
      );
    }
    const limit = clampHistoryLimit(c.req.query("limit"));
    const cursor = decodeHistoryCursor(rawCursor);
    const page = runtime().listHistory({
      limit,
      cursor,
      beforeDay: day ?? null,
    });
    return c.json({
      entries: page.entries,
      pageInfo: {
        hasMore: page.nextCursor !== null,
        limit,
        ...(page.nextCursor ? { nextCursor: encodeHistoryCursor(page.nextCursor) } : {}),
      },
    });
  });

  app.patch("/notes/:id", scope.writeAny(), validateJson(patchNoteBody), async (c) => {
    const auth = c.get("auth");
    enforceWriteScopeForSource(auth.scopes, "omnesis-notes");
    const { text } = c.req.valid("json");
    const entry = await runtime().edit(c.req.param("id"), text);
    if (!entry) throw new NotFoundError("Note entry not found");
    return c.json(entry);
  });

  app.delete("/notes/:id", scope.writeAny(), async (c) => {
    const auth = c.get("auth");
    enforceWriteScopeForSource(auth.scopes, "omnesis-notes");
    const removed = await runtime().remove(c.req.param("id"));
    if (!removed) throw new NotFoundError("Note entry not found");
    return c.body(null, 204);
  });
}
