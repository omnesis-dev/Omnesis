// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The morning digest's forward horizon: everything the substrate knows is
 * coming, over BOTH temporal origins.
 *
 * The digest is the one lane that composes editorially — its prompt tells the
 * agent the facts are already gathered and not to re-derive the world from the
 * corpus. So whatever this loader omits, the digest cannot recover: an omitted
 * item is simply absent from the user's morning read. That is why the horizon
 * goes through `TemporalQueryService` (source-owned projections AND
 * annotations) rather than reading the annotation table directly — a calendar
 * event is a projection, and the intake lane is explicitly forbidden from
 * re-stating a projection as an annotation, so an annotations-only horizon can
 * never see a plain meeting.
 *
 * Ranking, not just filtering, is load-bearing. The query pages in
 * interval-start order, so a long span that merely OVERLAPS the window (a
 * multi-year warranty, a months-long permit) sorts ahead of everything with a
 * boundary in the next few days. Under a display cap that ordering spends the
 * budget on background spans and cuts exactly what the digest exists to
 * surface. So the horizon walks the whole window, then re-ranks by what the
 * user can act on: items whose START or END falls inside it come first.
 */

import { hostTimeZone } from "@omnesis/core";
import type { TemporalItem, TemporalQueryInput } from "@omnesis/core";
import type { TemporalQueryService } from "../../enrichment/temporal/temporal-query-service.js";

/** How far ahead the digest's injected horizon reaches. */
export const DIGEST_HORIZON_DAYS = 3;

/** Display cap for the injected horizon — what the agent actually sees. */
export const DIGEST_HORIZON_MAX_ENTRIES = 30;

/**
 * Items per query. This is `TemporalQueryService`'s own per-page ceiling: it
 * clamps any larger `limit` down silently, so asking for more than this would
 * buy nothing while reading as though it had.
 */
const DIGEST_HORIZON_PAGE_LIMIT = 100;

/**
 * Pages to walk before giving up. The horizon must rank across the WHOLE
 * window, not the first page of it — a single page of a busy window can be
 * entirely long-running background spans, with every imminent item behind the
 * cursor. Bounded so a pathological corpus cannot stall the digest; at this
 * width the bound is far past any real three-day window.
 */
const DIGEST_HORIZON_MAX_PAGES = 5;

/** The horizon the digest composes from. */
export interface DigestHorizon {
  items: TemporalItem[];
  /** IANA zone the items' wall-clock times are rendered in. */
  timeZone: string;
  /**
   * More items overlapped the window than the page budget could read, so the
   * horizon is incomplete. Surfaced to the agent rather than swallowed: a
   * silently-clipped horizon reads exactly like a quiet few days.
   */
  truncated: boolean;
}

/**
 * The gateway's own IANA zone. The digest speaks in local time throughout — the
 * enqueuer fires it at a local hour and it expires at local end-of-day — so its
 * horizon is read and rendered in the same zone. Unlike a chat answer, a digest
 * has no caller to take a zone from: it is produced by a background run, so the
 * host's zone is the only one available.
 */
export function localTimeZone(): string {
  return hostTimeZone();
}

/**
 * How soon the user meets this item inside the window: its start when it has
 * yet to begin, otherwise its end. A warranty signed two years ago and expiring
 * on Thursday is a Thursday item — ranking it by its start would bury it behind
 * every trivial meeting, which is the opposite of what the digest is for.
 * Items with neither boundary in the window are ongoing background.
 */
function actionableBoundaryMs(
  item: TemporalItem,
  windowStartMs: number,
  windowEndMs: number,
): number | null {
  const startMs = Date.parse(item.start);
  if (startMs >= windowStartMs) return startMs;
  const endMs = Date.parse(item.endExclusive);
  return endMs <= windowEndMs ? endMs : null;
}

/**
 * Rank for display: items with a boundary inside the window first (what the
 * user actually meets), soonest boundary first; then ongoing background spans,
 * earliest-started first. On an exact tie a source-owned projection outranks an
 * inferred annotation, so the deterministic fact survives the cap over a guess
 * about the same moment. The id breaks any remaining tie, so a fixed corpus
 * renders a fixed prompt.
 */
function rankForDigest(
  items: readonly TemporalItem[],
  windowStartMs: number,
  windowEndMs: number,
): TemporalItem[] {
  const keyed = items.map((item) => ({
    item,
    boundary: actionableBoundaryMs(item, windowStartMs, windowEndMs),
    startMs: Date.parse(item.start),
  }));
  keyed.sort((a, b) => {
    const aBackground = a.boundary === null ? 1 : 0;
    const bBackground = b.boundary === null ? 1 : 0;
    if (aBackground !== bBackground) return aBackground - bBackground;
    const aRank = a.boundary ?? a.startMs;
    const bRank = b.boundary ?? b.startMs;
    if (aRank !== bRank) return aRank - bRank;
    const aInferred = a.item.origin === "projection" ? 0 : 1;
    const bInferred = b.item.origin === "projection" ? 0 : 1;
    if (aInferred !== bInferred) return aInferred - bInferred;
    return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
  });
  return keyed.map((entry) => entry.item);
}

/**
 * The digest horizon: live temporal items overlapping the next
 * {@link DIGEST_HORIZON_DAYS} days across both origins, ranked for display and
 * capped.
 *
 * Only `active` items are asked for. The section is headed "what is coming",
 * and a cancelled or completed item is not coming — the rendered line carries
 * no status, so an excluded one would be indistinguishable from a live one.
 *
 * The window end is the relative expression `+Nd`, which the range resolver
 * advances by calendar arithmetic in `timeZone`. A fixed span of milliseconds
 * would drift an hour against the local day across a DST transition, and every
 * other boundary in the digest lane is local.
 */
export async function loadDigestHorizon(
  temporalQuery: Pick<TemporalQueryService, "query">,
  now: number,
  timeZone: string,
): Promise<DigestHorizon> {
  const window: TemporalQueryInput = {
    from: new Date(now).toISOString(),
    to: `+${DIGEST_HORIZON_DAYS}d`,
    timeZone,
    origins: ["projection", "annotation"],
    statuses: ["active"],
    limit: DIGEST_HORIZON_PAGE_LIMIT,
  };
  const collected: TemporalItem[] = [];
  let cursor: string | undefined;
  let truncated = false;
  let windowEndMs = now;
  for (let page = 0; page < DIGEST_HORIZON_MAX_PAGES; page++) {
    const result = await temporalQuery.query(cursor === undefined ? window : { ...window, cursor });
    collected.push(...result.items);
    windowEndMs = Date.parse(result.window.endExclusive);
    // An intermediate page reporting `truncated` only means more pages remain,
    // and the loop reads them. The flag survives solely by falling out of the
    // loop with a page still unread — i.e. the page budget, not the window, is
    // what ended the walk.
    if (!result.truncated || result.nextCursor === undefined) {
      truncated = false;
      break;
    }
    cursor = result.nextCursor;
    truncated = true;
  }
  return {
    items: rankForDigest(collected, now, windowEndMs).slice(0, DIGEST_HORIZON_MAX_ENTRIES),
    timeZone,
    truncated,
  };
}

/**
 * One line per horizon item, with wall-clock times in the horizon's zone. Marks
 * each item's origin because the two carry different authority: a projection is
 * a deterministic source-owned fact the digest may state directly, while an
 * annotation is the agent's own derived entry and needs re-grounding
 * before it becomes a claim.
 *
 * Rendering in the local zone is not cosmetic. The digest writes prose the user
 * reads as their day ("your 15:00 with Maya"), so a UTC clock time would put
 * every summer meeting an hour early.
 */
export function renderDigestHorizonLines(horizon: DigestHorizon): string[] {
  const day = dayFormatter(horizon.timeZone);
  const time = timeFormatter(horizon.timeZone);
  return horizon.items.map((item) => {
    const when = formatInterval(item, day, time);
    const origin = item.origin === "projection" ? "source-owned" : "inferred";
    const docs = documentIdsOf(item);
    const cites = docs.length > 0 ? ` (docs: ${docs.join(", ")})` : "";
    return `- ${when} [${item.kind}] (${origin}): ${item.label}${cites}`;
  });
}

/** The documents grounding an item, whichever origin it came from. */
function documentIdsOf(item: TemporalItem): string[] {
  if (item.annotation) return item.annotation.documentIds;
  return item.projection?.documentId ? [item.projection.documentId] : [];
}

/**
 * A compact, absolute interval.
 *
 * Whole-day facts render as a bare date: their clock time is an artifact of
 * normalization, not something the user can act on. That covers `allDay` items
 * and the coarse precisions (`day`, `month`, `year`) — but NOT `range`, which
 * an annotation uses for a genuine timed span like "14:00 .. 16:00".
 *
 * A fact with no declared end is stored as an empty interval, so an end equal
 * to (or before) the start means an instant, not a zero-length meeting.
 */
function formatInterval(
  item: TemporalItem,
  day: Intl.DateTimeFormat,
  time: Intl.DateTimeFormat,
): string {
  const start = new Date(item.start);
  const endExclusive = new Date(item.endExclusive);
  const wholeDay =
    item.allDay ||
    item.precision === "day" ||
    item.precision === "month" ||
    item.precision === "year";
  if (wholeDay) {
    const startDay = day.format(start);
    // The end is exclusive; the last covered day is the instant before it.
    const lastDay = day.format(new Date(Math.max(endExclusive.getTime() - 1, start.getTime())));
    return startDay === lastDay ? startDay : `${startDay} .. ${lastDay}`;
  }
  const startDay = day.format(start);
  if (endExclusive.getTime() <= start.getTime()) return `${startDay} ${time.format(start)}`;
  const endDay = day.format(endExclusive);
  // An interval crossing midnight must name its end day, or "22:00–06:00" reads
  // as ending sixteen hours before it began.
  return endDay === startDay
    ? `${startDay} ${time.format(start)}–${time.format(endExclusive)}`
    : `${startDay} ${time.format(start)} – ${endDay} ${time.format(endExclusive)}`;
}

/** `en-CA` renders `YYYY-MM-DD`, the unambiguous form the rest of the prompt uses. */
function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** 24-hour `HH:mm`; `hourCycle` pins midnight to `00:00` rather than `24:00`. */
function timeFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}
