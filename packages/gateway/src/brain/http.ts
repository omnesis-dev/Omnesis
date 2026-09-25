// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP surface of the Briefs feature. Mounted unconditionally (so the
 * gate flips live, like `/status`), but every route re-checks the
 * feature gate per request. Brief feed reads and user triage remain available
 * whenever experimental mode is enabled, even while the background agent is
 * parked. Agent-driven routes still 404 when the feature is not active. The
 * read-only temporal window follows visibility so
 * synthetic demos can inspect seeded time data without enabling agent work;
 * production still requires experimental mode.
 *
 * Routes are `scope.admin()` like the rest of the agent surface. Three
 * groups: Briefs (the ranked feed GET, the cheap
 * unread-count GET for the drawer badge, the per-brief mark-read POST,
 * the dismiss POST, and the talk-back thread-open POST); temporal data (one
 * union window over projections + annotations, plus legacy annotation-only
 * reads); and `/loops*` list + detail reads. The other operator/debug surfaces
 * over the same tables live in admin-http.ts.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ACCEPTED_TEMPORAL_KINDS,
  canonicalTemporalKind,
  TEMPORAL_MODALITIES,
  TEMPORAL_ORIGINS,
  TEMPORAL_STATUSES,
} from "@omnesis/core";
import { buildPage, clampLimit } from "@omnesis/types";
import { validateJson } from "../http/validate.js";
import { scope } from "../http/scope.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  StalePageCursorError,
} from "../http/errors.js";
import { TEMPORAL_ANNOTATION_READ_MAX_LIMIT } from "../enrichment/temporal-annotations/storage.js";
import {
  TemporalQueryInputError,
  TemporalQueryService,
} from "../enrichment/temporal/temporal-query-service.js";
import { BRIEF_DISMISS_REASONS } from "./feedback.js";
import { buildBriefsFeed } from "./feed.js";
import {
  nextBriefFeedPageCursor,
  nextProductLoopPageCursor,
  parseBriefFeedPageCursor,
  parseProductLoopFilter,
  parseProductLoopPageCursor,
  productLoopStates,
} from "./product-pagination.js";
import {
  buildTemporalAnnotationEntry,
  buildTemporalAnnotationWindow,
  TEMPORAL_ANNOTATION_WINDOW_MAX_SPAN_MS,
  type TemporalAnnotationWindowEntry,
} from "./temporal-annotation-window.js";
import {
  BriefNotFoundError,
  TalkbackUnavailableError,
  type BriefTalkbackPort,
  type OpenThreadResult,
} from "./talkback/talkback-service.js";
import { briefReadSnapshot, countShowableUnreadBriefs } from "./storage/briefs.js";
import { ProductLoopQueryService } from "./product-loop-query-service.js";
import type { TemporalKind, TemporalModality, TemporalOrigin, TemporalStatus } from "@omnesis/core";
import type Database from "better-sqlite3";
import type { OpenLoopRow } from "./storage/types.js";
import type { BriefsFeatureStatus } from "./feature-gate.js";
import type { DismissBriefInput, DismissBriefResult } from "./feedback.js";
import type { MarkBriefReadResult } from "./storage/briefs.js";
import type { RouteApp } from "../http/routes/types.js";
import type { AnalyticsDb } from "../analytics-db.js";

const isoDateTime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 date-time");

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * A loop as the product surface serializes it — the user-meaningful
 * fields only. Engine bookkeeping (creating run, decay-check counters)
 * and the operator joins (linked docs, attached briefs, scheduled
 * checks) stay on the /admin/brain surface. `deadline` passes through
 * as the agent-owned opaque JSON; clients parse the recommended
 * `{ type, date?, note? }` shape leniently. `importance` (0-1) is the
 * agent's own weight — the Radar surface ranks by it.
 */
function loopDto(loop: OpenLoopRow) {
  return {
    id: loop.id,
    state: loop.state,
    title: loop.title,
    description: loop.description,
    importance: loop.importance,
    deadline: loop.deadline,
    createdAt: iso(loop.createdAt),
    lastUpdate: iso(loop.lastUpdate),
  };
}

/**
 * Actor refs for the Radar list — person refs enriched to `{ id, name }`
 * (a legacy raw ref matching no person keeps its raw value with
 * `name: null`), each flagged `isSelf` when it resolves to the user's own
 * person. `isSelf` is the signal the client groups on: a loop the user is
 * an actor on is "Your move"; one whose actors are all other people is
 * "Waiting on others". Only the server can compute it (it holds the
 * self-identity and merge graph), so it is resolved here.
 */
/**
 * Body of POST /briefs/:id/dismiss — the dismiss modal's payload.
 * `snoozeUntil` (ISO 8601) is the user-picked re-surface time for the
 * "pick a time" / "later today" / "tomorrow" snooze choices; a snooze
 * without it means "the agent decides". Reason/kind pairing and
 * snoozeUntil-only-with-snoozed are enforced in the dismissal write.
 */
const dismissBriefBody = z
  .object({
    reason: z.enum(BRIEF_DISMISS_REASONS as [string, ...string[]]),
    feedback: z.string().max(4000).optional(),
    snoozeUntil: isoDateTime.optional(),
  })
  .strict();

export interface MountBriefsRoutesOpts {
  /** Read handle for the feed's selection + ranking-signal queries. */
  db: Database.Database;
  /** Analytics projections; absent in lightweight tests, where document projections still work. */
  analyticsDb?: AnalyticsDb | undefined;
  writeGate: {
    dismissBrief(input: DismissBriefInput, now: number): Promise<DismissBriefResult>;
    markBriefRead(id: string, now: number): Promise<MarkBriefReadResult>;
  };
  /** Live feature-gate verdict; absent ⇒ the routes always 404. */
  getStatus?: (() => BriefsFeatureStatus) | undefined;
  /**
   * Decision clock. Defaults to the wall clock; the backtest mirror
   * passes its virtual clock so feed selection/ranking and dismissal
   * stamps live in replay time (a replay-expired brief would otherwise
   * vanish from the feed the operator inspects).
   */
  clock?: (() => number) | undefined;
  /**
   * Live handle to the talk-back port; wired by bootBriefs when the
   * feature is active. Absent/null ⇒ POST /briefs/:id/thread 404s like
   * every other gated route.
   */
  getTalkback?: (() => BriefTalkbackPort | null) | undefined;
}

export function mountBriefsRoutes(app: RouteApp, opts: MountBriefsRoutesOpts): void {
  const productLoops = new ProductLoopQueryService(opts.db);
  const requireActive = (): void => {
    if (!opts.getStatus?.().active) throw new NotFoundError("Not found");
  };
  const requireEnabled = (): void => {
    if (!opts.getStatus?.().enabled) throw new NotFoundError("Not found");
  };
  const requireVisible = (): void => {
    if (!opts.getStatus?.().visible) throw new NotFoundError("Not found");
  };
  const now = (): number => (opts.clock ?? Date.now)();

  const parseTemporalWindowMs = (c: {
    req: { query(name: string): string | undefined };
  }): { fromMs: number; toMs: number } => {
    const parseMs = (name: string): number => {
      const raw = c.req.query(name);
      const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
      if (!Number.isSafeInteger(n)) {
        throw new BadRequestError(`"${name}" must be a unix-ms integer`);
      }
      return n;
    };
    const fromMs = parseMs("from");
    const toMs = parseMs("to");
    if (fromMs >= toMs) throw new BadRequestError(`"from" must be earlier than "to"`);
    if (toMs - fromMs > TEMPORAL_ANNOTATION_WINDOW_MAX_SPAN_MS) {
      throw new BadRequestError(
        `window too wide (max ${TEMPORAL_ANNOTATION_WINDOW_MAX_SPAN_MS / 86_400_000} days)`,
      );
    }
    return { fromMs, toMs };
  };

  /**
   * Parse one CSV facet filter against the vocabulary it draws from.
   * `normalize` resolves each accepted spelling to the canonical one the
   * query layer matches on, so two spellings of the same value collapse to a
   * single filter entry rather than being passed down twice.
   */
  const parseCsv = <T extends string>(
    raw: string | undefined,
    allowed: ReadonlySet<string>,
    name: string,
    normalize?: (value: string) => T | null,
  ): T[] | undefined => {
    if (raw === undefined || raw.trim() === "") return undefined;
    const values = [
      ...new Set(
        raw
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    if (values.length > KINDS_FILTER_MAX) throw new BadRequestError(`too many "${name}"`);
    const invalid = values.find((value) => !allowed.has(value));
    if (invalid) throw new BadRequestError(`invalid "${name}" value: ${invalid}`);
    if (!normalize) return values as T[];
    const canonical: T[] = [];
    for (const value of values) {
      // Membership in `allowed` is already established, so this resolves.
      const resolved = normalize(value);
      if (resolved !== null) canonical.push(resolved);
    }
    return [...new Set(canonical)];
  };

  // The ranked feed the iOS Briefs page renders, first entry on top.
  // Selection + ordering live in feed.ts / ranking.ts; timestamps
  // serialize as ISO 8601; an empty array is the "no briefs to show"
  // state (never padded).
  app.get("/briefs/feed", scope.admin(), (c) => {
    requireEnabled();
    const limit = clampLimit(c.req.query("limit"), { default: 30, max: 100 });
    const cursor = parseBriefFeedPageCursor(c.req.query("cursor"));
    const snapshotNow = cursor?.snapshotNow ?? now();
    const snapshotReadAt = cursor?.snapshotReadAt ?? briefReadSnapshot(opts.db);
    const probe = buildBriefsFeed(opts.db, snapshotNow, {
      readSnapshot: snapshotReadAt,
      limit: limit + 1,
      ...(cursor ? { after: cursor.after } : {}),
    });
    const hasMore = probe.length > limit;
    const page = hasMore ? probe.slice(0, limit) : probe;
    const last = page.at(-1);
    const nextCursor =
      hasMore && last
        ? nextBriefFeedPageCursor(snapshotNow, snapshotReadAt, last.sortKey)
        : undefined;
    const briefs = page.map(({ brief, citations }) => ({
      id: brief.id,
      kind: brief.kind,
      state: brief.state,
      title: brief.title,
      description: brief.description,
      body: brief.body,
      confidence: brief.confidence,
      urgency: brief.urgency,
      createdAt: iso(brief.createdAt),
      eventAt: iso(brief.eventAt),
      relevantUntil: iso(brief.relevantUntil),
      citations,
      threadConversationId: brief.threadConversationId,
    }));
    return c.json({
      briefs,
      pageInfo: buildPage([], { hasMore, limit, nextCursor }).pageInfo,
    });
  });

  // The unread-count badge read for the iOS Briefs drawer entry: just the
  // number of showable UNREAD briefs (the feed's showable subset minus
  // already-read ones), so a client renders an "N awaiting" badge without
  // fetching the full feed. Gated + scoped exactly like the feed — 404
  // when experimental mode is disabled.
  app.get("/briefs/count", scope.admin(), (c) => {
    requireEnabled();
    return c.json({ unread: countShowableUnreadBriefs(opts.db, now()) });
  });

  // Mark a brief seen (`unread` → `read`) — sent by the client per brief
  // actually viewed, so `read` briefs sort last on return visits.
  app.post("/briefs/:id/read", scope.admin(), async (c) => {
    requireEnabled();
    const result = await opts.writeGate.markBriefRead(c.req.param("id"), now());
    switch (result.outcome) {
      case "marked":
      case "already_read":
        return c.json({ ok: true, state: "read" });
      case "not_found":
        throw new NotFoundError("Brief not found");
      case "not_markable":
        throw new ConflictError(
          `Brief is dismissed (${result.state}) — it is never shown, so it cannot be marked read`,
        );
    }
  });

  // Dismiss a brief: synchronously flip its dismissed_* state (durable on
  // return) and enqueue the async feedback run the Cognition Steward reacts
  // with. If its model is parked, that run remains pending until setup is fixed.
  app.post("/briefs/:id/dismiss", scope.admin(), validateJson(dismissBriefBody), async (c) => {
    requireEnabled();
    const body = c.req.valid("json");
    const result = await opts.writeGate.dismissBrief(
      {
        briefId: c.req.param("id"),
        reason: body.reason as DismissBriefInput["reason"],
        feedback: body.feedback ?? null,
        snoozeUntil: body.snoozeUntil !== undefined ? Date.parse(body.snoozeUntil) : null,
        feedbackRunId: randomUUID(),
      },
      now(),
    );
    switch (result.outcome) {
      case "dismissed":
        return c.json({ ok: true, state: result.state, feedbackRunId: result.feedbackRunId });
      case "not_found":
        throw new NotFoundError("Brief not found");
      case "already_terminal":
        throw new ConflictError(`Brief is already dismissed (${result.state})`);
      case "invalid":
        throw new BadRequestError(result.message);
    }
  });

  // Canonical Calendar read: one ordered, cursor-paginated view over immutable
  // source projections and LLM annotations. Callers use
  // unix-ms bounds; TemporalQueryService immediately normalizes them into the
  // same half-open contract exposed to the agent's `temporal_query` tool.
  app.get("/briefs/temporal/window", scope.admin(), async (c) => {
    requireVisible();
    const { fromMs, toMs } = parseTemporalWindowMs(c);
    const timeZone = c.req.query("timeZone");
    if (!timeZone?.trim()) throw new BadRequestError('"timeZone" must be an IANA time zone');
    const origins = parseCsv<TemporalOrigin>(
      c.req.query("origins"),
      new Set(TEMPORAL_ORIGINS),
      "origins",
    );
    // Kinds are the one facet with retired spellings still on the wire: accept
    // them from older clients and resolve each to its canonical kind here, so
    // nothing below this boundary sees more than one name for a kind.
    const kinds = parseCsv<TemporalKind>(
      c.req.query("kinds"),
      new Set(ACCEPTED_TEMPORAL_KINDS),
      "kinds",
      canonicalTemporalKind,
    );
    const modalities = parseCsv<TemporalModality>(
      c.req.query("modalities"),
      new Set(TEMPORAL_MODALITIES),
      "modalities",
    );
    const statuses = parseCsv<TemporalStatus>(
      c.req.query("statuses"),
      new Set(TEMPORAL_STATUSES),
      "statuses",
    );
    const limitRaw = c.req.query("limit");
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      const parsed = Number(limitRaw);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
        throw new BadRequestError('"limit" must be an integer 1..100');
      }
      limit = parsed;
    }
    // Only a TemporalQueryInputError is the caller's to fix. Everything else is
    // the gateway's own and propagates to the sanitized, logged 500 in
    // `app.onError`, which is where an internal fault belongs.
    const page = await new TemporalQueryService(opts.db, opts.analyticsDb)
      .query({
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
        timeZone,
        ...(origins ? { origins } : {}),
        ...(kinds ? { kinds } : {}),
        ...(modalities ? { modalities } : {}),
        ...(statuses ? { statuses } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(c.req.query("cursor") ? { cursor: c.req.query("cursor") } : {}),
      })
      .catch((error: unknown) => {
        if (error instanceof TemporalQueryInputError) throw new BadRequestError(error.message);
        throw error;
      });
    return c.json({
      nowMs: now(),
      window: page.window,
      items: page.items,
      coverage: page.coverage,
      truncated: page.truncated,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  });

  // Addressable Calendar detail. It uses the same timezone-aware service as
  // the window read, so opening an annotation directly cannot shift a coarse
  // date merely because its persisted anchor was written in another zone.
  app.get("/briefs/temporal/annotations/:id", scope.admin(), async (c) => {
    requireVisible();
    const timeZone = c.req.query("timeZone");
    if (!timeZone?.trim()) throw new BadRequestError('"timeZone" must be an IANA time zone');
    const item = await new TemporalQueryService(opts.db, opts.analyticsDb)
      .annotationById(c.req.param("id"), timeZone)
      .catch((error: unknown) => {
        if (error instanceof TemporalQueryInputError) throw new BadRequestError(error.message);
        throw error;
      });
    if (!item) throw new NotFoundError("Temporal annotation not found");
    return c.json({ item });
  });

  const serializeWindowEntry = (e: TemporalAnnotationWindowEntry) => ({
    id: e.id,
    intervalStartMs: e.intervalStartMs,
    intervalEndMs: e.intervalEndMs,
    // `granularity` is the shipped wire spelling of the interval's precision,
    // retained as the historical API contract. Do not align it with the
    // internal name.
    granularity: e.precision,
    canonical: e.canonical,
    sentence: e.sentence,
    kind: e.kind,
    createdAt: new Date(e.createdAt).toISOString(),
    updatedAt: new Date(e.updatedAt).toISOString(),
    documents: e.documents,
  });

  // Legacy annotation-only read retained alongside the unified
  // `/briefs/temporal/window`: live temporal
  // entries overlapping [from, to] (unix ms, inclusive), chronological,
  // grounding documents resolved for display. `kinds` (CSV) narrows to a
  // kind subset — the Upcoming rail passes deadline,expiry,reminder — and
  // `limit` (1..500, default 300) caps the page, with `truncated: true`
  // signalling the window held more (the client narrows or raises the
  // limit; an invisibly clipped calendar would render later days as
  // falsely empty). The client computes the window from its own timezone;
  // the gateway stays timezone-ignorant.
  app.get("/briefs/time-index/window", scope.admin(), (c) => {
    requireActive();
    const { fromMs, toMs } = parseTemporalWindowMs(c);
    const limitRaw = c.req.query("limit");
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      const n = Number(limitRaw);
      if (!Number.isSafeInteger(n) || n < 1 || n > TEMPORAL_ANNOTATION_READ_MAX_LIMIT) {
        throw new BadRequestError(
          `"limit" must be an integer 1..${TEMPORAL_ANNOTATION_READ_MAX_LIMIT}`,
        );
      }
      limit = n;
    }
    const kindsRaw = c.req.query("kinds");
    const kinds = kindsRaw
      ?.split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    if (kinds && kinds.length > KINDS_FILTER_MAX) throw new BadRequestError(`too many "kinds"`);
    const page = buildTemporalAnnotationWindow(opts.db, {
      fromMs,
      toMs,
      ...(kinds && kinds.length > 0 ? { kinds } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return c.json({
      nowMs: now(),
      truncated: page.truncated,
      entries: page.entries.map(serializeWindowEntry),
    });
  });

  // One live annotation in the same display-ready shape as the legacy window.
  app.get("/briefs/time-index/:id", scope.admin(), (c) => {
    requireActive();
    const entry = buildTemporalAnnotationEntry(opts.db, c.req.param("id"));
    if (!entry) throw new NotFoundError("Temporal annotation not found");
    return c.json({ entry: serializeWindowEntry(entry) });
  });

  // The brief thread-open flow: resolve the port, open, and map typed errors —
  // unknown brief → 404, harness/model
  // unavailable → 409. Callers derive the caller id with the same
  // convention as the /agent routes, so the thread's per-caller session
  // accounting lines up when it is later resumed.
  const callerIdOf = (c: unknown): string => {
    const auth = (c as { get(k: "auth"): { tokenId: string | null } }).get("auth");
    return `token:${auth?.tokenId ?? "unknown"}`;
  };
  const openAnchoredThread = async (
    open: (talkback: BriefTalkbackPort) => Promise<OpenThreadResult>,
    notFound: { errorClass: new (message?: string) => Error; message: string },
  ): Promise<OpenThreadResult> => {
    requireActive();
    const talkback = opts.getTalkback?.() ?? null;
    if (!talkback) throw new NotFoundError("Not found");
    try {
      return await open(talkback);
    } catch (err) {
      if (err instanceof notFound.errorClass) throw new NotFoundError(notFound.message);
      if (err instanceof TalkbackUnavailableError) throw new ConflictError(err.message);
      throw err;
    }
  };

  // Open (or return) the brief's follow-up thread — a conversation seeded
  // with the creating run's transcript, on which the user talks back to
  // the agent about this brief. Idempotent: one thread per brief, ever;
  // clients then drive the normal /agent session flow with the returned
  // conversation id.
  app.post("/briefs/:id/thread", scope.admin(), async (c) => {
    const result = await openAnchoredThread(
      (talkback) => talkback.openThread(callerIdOf(c), c.req.param("id")),
      { errorClass: BriefNotFoundError, message: "Brief not found" },
    );
    return c.json({ conversationId: result.conversationId, created: result.created });
  });

  // The Radar screen list — importance-ranked (ties break by most-recently
  // updated, then id). `state=active|resolved` matches the two product tabs;
  // omitted/`all` preserves the older all-state contract. Each page carries the
  // signals the client groups by: actors (with isSelf), involved, blockers and
  // deadline. The opaque cursor binds the state filter and full sort tuple.
  app.get("/loops", scope.admin(), (c) => {
    requireActive();
    const state = parseProductLoopFilter(c.req.query("state"));
    const limit = clampLimit(c.req.query("limit"), { default: 50, max: 100 });
    const revision = productLoops.paginationRevision();
    const cursor = parseProductLoopPageCursor(c.req.query("cursor"), state, revision);
    const states = productLoopStates(state);
    const probe = productLoops.list({
      ...(states ? { states } : {}),
      orderBy: "importance",
      limit: limit + 1,
      ...(cursor ? { afterImportance: cursor } : {}),
    });
    if (productLoops.paginationRevision() !== revision) throw new StalePageCursorError();
    const hasMore = probe.length > limit;
    const page = hasMore ? probe.slice(0, limit) : probe;
    const last = page.at(-1);
    const nextCursor =
      hasMore && last
        ? nextProductLoopPageCursor(state, revision, {
            importance: last.row.importance,
            lastUpdate: last.row.lastUpdate,
            id: last.row.id,
          })
        : undefined;
    const loops = page.map((loop) => ({
      ...loopDto(loop.row),
      actors: loop.actors,
      involved: loop.involved,
      blockedBy: loop.blockedBy,
    }));
    return c.json({
      loops,
      pageInfo: buildPage([], { hasMore, limit, nextCursor }).pageInfo,
    });
  });

  // One loop for the detail sheet: the product fields plus person refs
  // enriched to `{ id, name }` (a legacy raw ref matching no person keeps its
  // raw value with `name: null`). The legacy inline ledger is bounded to its
  // first 50 newest notes; current clients use the dedicated paginated admin
  // ledger route and can request `includeChildren=0` here.
  app.get("/loops/:id", scope.admin(), (c) => {
    requireActive();
    const loop = productLoops.get(c.req.param("id"));
    if (!loop) throw new NotFoundError("Loop not found");
    const includeChildren = c.req.query("includeChildren") !== "0";
    const ledgerLimit = 50;
    const ledgerProbe = includeChildren
      ? productLoops.listLedger(loop.row.id, {
          order: "desc",
          limit: ledgerLimit + 1,
        })
      : [];
    const ledgerHasMore = ledgerProbe.length > ledgerLimit;
    const ledger = ledgerHasMore ? ledgerProbe.slice(0, ledgerLimit) : ledgerProbe;
    return c.json({
      loop: {
        ...loopDto(loop.row),
        actors: loop.actors,
        involved: loop.involved,
        blockedBy: loop.blockedBy,
      },
      ...(includeChildren
        ? {
            ledger: ledger.map((entry) => ({
              seq: entry.seq,
              at: iso(entry.at),
              note: entry.note,
            })),
            ledgerTruncated: ledgerHasMore,
          }
        : {}),
    });
  });
}

/**
 * Ceiling on a CSV facet filter — comfortably above the accepted kind
 * vocabulary, the widest of the facets, so it only rejects junk, never a
 * legitimate filter.
 */
const KINDS_FILTER_MAX = 12;
