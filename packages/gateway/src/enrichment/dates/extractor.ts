// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Date extraction over document text — the compute half of the (experimental)
 * date-enrichment signal.
 *
 * Every document is run through Microsoft Recognizers-Text, with the
 * recognizer anchored to the document's last-edit date (`anchorAt`)
 * so that relative expressions ("tomorrow", "in 3 years", "next Tuesday")
 * resolve to absolute dates as of when the text was written — not as of now.
 *
 * Each document is parsed with exactly ONE recognizer culture, chosen by
 * language detection over its title + content head (see `language-route.ts`).
 * Running multiple cultures over one text is a measured precision disaster
 * (English "an" parses as French "an" = one year), so routing is
 * single-culture by design; a document in a language with no culture is
 * skipped (zero dates).
 *
 * Pure and stateless apart from the one-time per-culture model build; runs on
 * the CPU worker pool (`cpu.extractDatesFromDocs`), so it never touches the
 * main event loop, the writer, or a user-serving read handle.
 *
 * Library note: `@microsoft/recognizers-text-date-time` ships CommonJS/UMD
 * only, so it must be imported via NAMED imports (the `default` export is the
 * namespace object, not the recognizer class).
 */

import { DateTimeRecognizer } from "@microsoft/recognizers-text-date-time";
import { routeDateCulture, ENGLISH_CULTURE, type DateCulture } from "./language-route.js";
import type { ExtractedDate } from "@omnesis/types";

/** A document row handed to the extractor (pre-fetched; no DB access here). */
export interface DateExtractionDocRow {
  id: string;
  /** Document title — part of the language-detection sample (not scanned for dates). */
  title: string;
  content: string;
  /**
   * ISO 8601 anchor timestamp for relative-date and year resolution: the
   * document's last edit when known, else its emission date. For a living
   * document ("16 au 23 août" typed months after creation) the last edit is
   * the reference the writing resolves against.
   */
  anchorAt: string;
  /**
   * Full pre-truncation content length. The fetch hands over only the first
   * `maxCharsPerDoc` characters; this records how long the body really was,
   * so a truncated scan can be stamped as such. Absent when the caller
   * supplied untruncated content.
   */
  contentLength?: number;
}

/** Per-document extraction output. */
export interface DateExtractionResult {
  id: string;
  dates: ExtractedDate[];
  /** True when the scan covered only a truncated prefix of the document (absent = full scan). */
  truncated?: boolean;
}

export interface DateExtractionOptions {
  /**
   * Cap the characters fed to the recognizer per document; dates past the
   * cap are not extracted. Offsets stay valid (into the truncated prefix).
   */
  maxCharsPerDoc?: number;
  /** Cap the number of extracted dates stored per document. */
  maxDatesPerDoc?: number;
  /**
   * Budget for one document's scan in milliseconds of the scanning thread's
   * own cpu time (wall clock where per-thread cpu time is unavailable),
   * checked between chunks. When it runs out the dates already found are
   * kept and the scan stops, flagged `budgetExhausted` — a single
   * pathological document can cost at most one chunk past the budget,
   * never a pinned worker, and a busy pool never charges a document for
   * time it spent queued.
   */
  scanBudgetMs?: number;
}

/** What one document's scan produced, and whether it covered everything. */
export interface DateScanResult {
  dates: ExtractedDate[];
  /** True when the time budget stopped the scan before the (capped) text was fully covered. */
  budgetExhausted: boolean;
}

/**
 * Default cap on characters fed to the recognizer per document. Generous,
 * because the real cost bound is elsewhere: dense-span neutralization
 * removes the recognizer's pathological inputs (long digit runs, URLs)
 * before scanning, and the per-document wall-clock budget stops a scan that
 * still runs hot — so a long planning document is covered outright while a
 * worst-case document costs at most one chunk past the budget. A scan cut
 * short by either bound is stamped `dates_truncated` and disclosed to the
 * data run.
 */
export const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_MAX_DATES = 200;
/** Default per-document scan budget (see DateExtractionOptions.scanBudgetMs). */
export const DEFAULT_SCAN_BUDGET_MS = 3_000;

/**
 * Milliseconds of THIS THREAD's cpu time when available (Node 24+), else
 * wall clock. The scan budget must charge a document for its own parsing
 * cost only: under a saturated cpu pool, wall clock measures the queue, not
 * the work — a corpus-wide rescan at full parallelism once stamped ~38k
 * ordinary emails "truncated" purely from contention.
 */
const budgetClock: () => number = (() => {
  const threadCpu = (
    process as unknown as { threadCpuUsage?: () => { user: number; system: number } }
  ).threadCpuUsage;
  if (typeof threadCpu === "function") {
    return () => {
      const u = threadCpu.call(process);
      return (u.user + u.system) / 1000;
    };
  }
  return () => Date.now();
})();
/**
 * Chunk size for the scan. Each recognizer call sees at most this much text —
 * the granularity at which the scan budget can actually intervene, since a
 * synchronous parse cannot be interrupted mid-call. The recognizer's cost is
 * SUPERLINEAR in call length (its merge passes compare match pairs), so small
 * calls also bound total cost: a hostile date-dense page that takes >10s of
 * cpu as one 5k-char call scans fully in under 2s as 2k-char calls. Below
 * ~2k the per-call overhead and boundary re-coverage start to dominate.
 */
const SCAN_CHUNK_CHARS = 2_000;
/**
 * Chunks re-cover this much of their predecessor's tail so a date phrase
 * sitting on a boundary is seen whole by one of them; value-keyed dedup
 * collapses anything both chunks matched.
 */
const SCAN_CHUNK_OVERLAP = 128;

/**
 * Cheap pre-filter: skip the expensive recognizer entirely when the text has
 * no date-ish token. Must not produce FALSE NEGATIVES for the expressions we
 * care about — a false positive only wastes one recognizer call. Covers
 * digits (absolute dates, "3 years", "8/04/2024"), weekday/month names, and
 * the relative vocabulary the anchor resolves.
 */
const DATE_HINT =
  /\d|\b(?:today|tomorrow|yesterday|tonight|noon|midnight|morning|afternoon|evening|next|last|coming|following|soon|later|ago|week|weeks|weekend|month|months|year|years|day|days|hour|hours|minute|minutes|deadline|due|expires?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;

/** Markers that make a matched phrase "relative" (resolved against the anchor). */
const RELATIVE_MARKER =
  /\b(?:today|tomorrow|yesterday|tonight|next|last|this|coming|following|ago|soon|later|now|within|upcoming|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\bin\s+\d/i;

/**
 * Forward-pointing context immediately before a bare duration ("expires in 3
 * years"). Deliberately excludes "for" — "lived there for 3 years" is a
 * duration of activity, not a future date, and must not resolve forward.
 */
const FORWARD_DURATION_CONTEXT = /\b(?:in|within|after|expires?\s+in|due\s+in)\s*$/i;
/** Backward-pointing context ("3 years ago"). */
const BACKWARD_DURATION_CONTEXT = /^\s*(?:ago|earlier|before|prior)\b/i;

/**
 * Language-dependent text heuristics, keyed by routed culture. The recognizer
 * is culture-routed, and these guards read the raw text around its matches —
 * so they must speak the same language as the model that produced the match.
 * The English entries are the constants above, unchanged.
 */
interface CultureTextRules {
  /**
   * Cheap pre-filter: skip the recognizer entirely when the text has no
   * date-ish token; null = always run the recognizer. Only English carries
   * one — its non-digit date vocabulary is enumerable without false negatives
   * for the expressions we keep. For the other cultures no such guarantee is
   * maintainable ("demain", "mañana", "明天" carry no digit), and non-English
   * documents are a small share of a corpus, so they skip the pre-filter.
   */
  dateHint: RegExp | null;
  /** Markers that make a matched phrase "relative" (resolved against the anchor). */
  relativeMarker: RegExp;
  /** Forward-pointing context immediately BEFORE a bare duration. */
  forwardDurationBefore: RegExp | null;
  /**
   * Backward-pointing context immediately BEFORE a bare duration — French
   * "il y a 3 ans" and Spanish "hace 3 años" put the "ago" marker in front
   * of the duration (English has none).
   */
  backwardDurationBefore: RegExp | null;
  /** Backward-pointing context immediately AFTER a bare duration ("3 years ago"). */
  backwardDurationAfter: RegExp | null;
}

const CULTURE_RULES: Record<DateCulture, CultureTextRules> = {
  "en-us": {
    dateHint: DATE_HINT,
    relativeMarker: RELATIVE_MARKER,
    forwardDurationBefore: FORWARD_DURATION_CONTEXT,
    backwardDurationBefore: null,
    backwardDurationAfter: BACKWARD_DURATION_CONTEXT,
  },
  "fr-fr": {
    dateHint: null,
    relativeMarker:
      /\b(?:demain|hier|prochaine?|derni[eè]re?|maintenant|bient[oô]t|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b|aujourd['’]hui|\bil\s+y\s+a\b|\bdans\s+\d/i,
    forwardDurationBefore: /(?:\b(?:dans|sous|apr[eè]s)|d['’]ici)\s*$/i,
    backwardDurationBefore: /\bil\s+y\s+a\s*$/i,
    backwardDurationAfter: /^\s*(?:plus\s+t[oô]t|auparavant)\b/i,
  },
  "es-es": {
    dateHint: null,
    relativeMarker:
      /\b(?:mañana|ayer|hoy|ahora|pronto|pr[oó]xim[oa]s?|pasad[oa]s?|hace|dentro|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b|\ben\s+\d/i,
    forwardDurationBefore: /\b(?:en|dentro\s+de|tras)\s*$/i,
    backwardDurationBefore: /\bhace\s*$/i,
    backwardDurationAfter: /^\s*(?:atr[aá]s|antes)\b/i,
  },
  "zh-cn": {
    dateHint: null,
    relativeMarker:
      /今天|明天|昨天|后天|前天|现在|最近|下个?|上个?|之[后前]|以[后前]|[年月周天][后前]/,
    // The Chinese model resolves directional expressions ("3年后", "明天")
    // as dates directly — a bare duration reaching the duration path is
    // ambient, with no out-of-span directional marker to rescue it.
    forwardDurationBefore: null,
    backwardDurationBefore: null,
    backwardDurationAfter: null,
  },
};

/** The recognizer's result shape (its shipped typings are loose — narrow here). */
interface RtResolutionValue {
  timex?: string;
  type?: string;
  value?: string;
  start?: string;
  end?: string;
  Mod?: string;
}
interface RtModelResult {
  start: number;
  /** Index of the LAST matched char (inclusive). */
  end: number;
  text: string;
  /** e.g. "datetimeV2.date", "datetimeV2.daterange", "datetimeV2.duration". */
  typeName: string;
  resolution?: { values?: RtResolutionValue[] };
}
interface RtModel {
  parse(query: string, referenceDate?: Date): RtModelResult[];
}

// Build one recognizer model per culture per worker, lazily — each is a few
// MB and stateless; `parse(text, anchor)` takes the anchor per call, so one
// model per culture serves every document with its own emission date.
const _models = new Map<DateCulture, RtModel>();
function model(culture: DateCulture): RtModel {
  let m = _models.get(culture);
  if (!m) {
    // fallbackToDefaultCulture=false: a culture missing from the JS build
    // must throw loudly here, never silently parse with English.
    m = new DateTimeRecognizer(culture).getDateTimeModel(culture, false) as unknown as RtModel;
    _models.set(culture, m);
  }
  return m;
}

/**
 * Build the anchor `Date` from the document's ISO emission timestamp. The
 * recognizer resolves relative expressions against the anchor's LOCAL
 * year/month/day, so we pin the anchor to the emission's UTC calendar day
 * (constructed at local noon to sidestep DST edges) — deterministic and
 * independent of the host machine's timezone. Returns null for an unparseable
 * timestamp.
 */
export function anchorFromIso(iso: string): Date | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0, 0);
}

/** Parse an ISO-8601 duration TIMEX (PnYnMnWnDTnHnMnS) into components. */
function parseIsoDuration(
  timex: string,
): { years: number; months: number; days: number; ms: number } | null {
  const m =
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
      timex,
    );
  if (!m) return null;
  const [, y, mo, w, d, h, min, s] = m;
  const num = (v: string | undefined) => (v ? Number.parseInt(v, 10) : 0);
  return {
    years: num(y),
    months: num(mo),
    days: num(w) * 7 + num(d),
    ms: (num(h) * 3600 + num(min) * 60 + num(s)) * 1000,
  };
}

/**
 * Canonical calendar date from a TIMEX3. Returns `YYYY` | `YYYY-MM` |
 * `YYYY-MM-DD` at the coarsest granularity the TIMEX actually knows, or
 * `null` when no concrete date can be established.
 *
 * A TIMEX whose ONLY unknown is the year (`XXXX-08-16` — the human planning
 * convention: "August 16", "16 au 23 août") resolves through
 * `fallbackValue`, the recognizer's concrete candidate picked by
 * `pickForwardValue`: the NEXT occurrence on or after the anchor. "August
 * 16" written in June lands on that year's August; written in December it
 * lands on the following August. Always-forward is a deliberate planning
 * bias — retrospective prose ("dinner on August 16", written in September)
 * resolves a year ahead and carries `relative: true` as the flag of an
 * adopted year. Fragments missing the month or day too (`XXXX-XX-23`, bare
 * weekday `XXXX-WXX-1`, `PRESENT_REF`, bare clock times) stay dropped:
 * there is nothing concrete to anchor.
 */
function canonicalFromTimex(timex: string | undefined, fallbackValue?: string): string | null {
  const t = timex ?? "";
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  if (/^\d{4}-\d{2}$/.test(t)) return t;
  if (/^\d{4}$/.test(t)) return t;
  // A week TIMEX (e.g. 2024-W20) knows the year — use the concrete resolved day.
  if (/^\d{4}-W\d{2}/.test(t) && fallbackValue && /^\d{4}-\d{2}-\d{2}/.test(fallbackValue)) {
    return fallbackValue.slice(0, 10);
  }
  // Year-less but month/day-concrete: adopt the anchored candidate's year.
  // (Bare year-less months never reach here — the recognizer emits them as
  // dateranges, handled by the range arm's month-point branch.)
  if (/^XXXX-\d{2}-\d{2}/.test(t) && fallbackValue && /^\d{4}-\d{2}-\d{2}/.test(fallbackValue)) {
    return fallbackValue.slice(0, 10);
  }
  return null;
}

/**
 * True when a range TIMEX's only unknown is the calendar year — every `XXXX`
 * is followed by a concrete two-digit month. A weekday span (`XXXX-WXX-1`) or
 * a fully-unknown fragment (`XXXX-XX-23`) fails, and stays dropped.
 */
function onlyYearUnknown(timex: string): boolean {
  return /XXXX-\d{2}/.test(timex) && !/XXXX-XX|XXXX-W/.test(timex);
}

/**
 * Resolve a duration against the anchor (anchor ± duration), returned at the
 * duration's coarsest unit — `P3Y` → year, `P6M` → month, otherwise day. Always
 * carries a concrete year (from the anchor). Null on an unparseable TIMEX.
 */
function canonicalDuration(anchor: Date, timex: string, sign: 1 | -1): string | null {
  const parts = parseIsoDuration(timex);
  if (!parts) return null;
  const d = new Date(anchor.getTime());
  d.setFullYear(d.getFullYear() + sign * parts.years);
  d.setMonth(d.getMonth() + sign * parts.months);
  d.setDate(d.getDate() + sign * parts.days);
  d.setTime(d.getTime() + sign * parts.ms);
  const full = isoDay(d);
  if (parts.years > 0 && parts.months === 0 && parts.days === 0 && parts.ms === 0) {
    return full.slice(0, 4); // years only → year granularity
  }
  if (parts.days === 0 && parts.ms === 0 && (parts.years > 0 || parts.months > 0)) {
    return full.slice(0, 7); // months (± years) → month granularity
  }
  return full; // days / weeks / time → day granularity
}

/** Render a Date as an ISO-8601 date-only string in UTC-day terms. */
function isoDay(d: Date): string {
  const y = d.getFullYear().toString().padStart(4, "0");
  const mo = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

/** The `datetimeV2.<subtype>` tail of a result's typeName. */
function subtypeOf(typeName: string): string {
  const dot = typeName.lastIndexOf(".");
  return dot >= 0 ? typeName.slice(dot + 1) : typeName;
}

/**
 * When a temporal expression has multiple candidate resolutions (a bare
 * weekday resolves to both the prior and the upcoming occurrence), bias
 * forward: prefer the earliest candidate on/after the anchor, else the latest.
 * This matches the feature's forward-looking purpose (surfacing dates that are
 * still ahead) and typical forward intent ("let's meet Tuesday").
 */
function pickForwardValue(values: RtResolutionValue[], anchor: Date): RtResolutionValue {
  const anchorDay = isoDay(anchor);
  const keyed = values
    .map((v) => ({ v, k: v.value ?? v.start ?? v.end ?? "" }))
    .filter((x) => x.k.length > 0);
  if (keyed.length === 0) return values[0];
  const future = keyed.filter((x) => x.k >= anchorDay).sort((a, b) => a.k.localeCompare(b.k));
  if (future.length > 0) return future[0].v;
  return keyed.sort((a, b) => b.k.localeCompare(a.k))[0].v;
}

/** Normalize one recognizer result into zero or one ExtractedDate, or null when
 *  it has no concrete year (so it must be dropped). */
function normalizeResult(
  r: RtModelResult,
  anchor: Date,
  content: string,
  rules: CultureTextRules,
): ExtractedDate | null {
  const values = r.resolution?.values ?? [];
  if (values.length === 0) return null;
  const subtype = subtypeOf(r.typeName);
  const text = content.slice(r.start, r.end + 1);
  const base = {
    relative: rules.relativeMarker.test(text),
    text,
    charStart: r.start,
    charEnd: r.end + 1,
  };

  switch (subtype) {
    case "date":
    case "datetime":
    case "holiday": {
      const v = pickForwardValue(values, anchor);
      const canon = canonicalFromTimex(v.timex, v.value ?? v.start);
      if (!canon) return null; // no concrete date could be established → drop
      return {
        kind: "date",
        resolvedStart: canon,
        resolvedEnd: null,
        timex: v.timex ?? "",
        ...base,
        // A year adopted from the anchored candidate is an anchor
        // resolution, like "tomorrow" — the flag says so.
        relative: base.relative || /^XXXX/.test(v.timex ?? ""),
      };
    }
    case "daterange":
    case "datetimerange": {
      const v = pickForwardValue(values, anchor);
      // A year-less range whose bounds are month/day-concrete ("16 au 23
      // août") keeps the picked candidate's concrete start/end below — the
      // recognizer already resolved its year against the anchor. A bare
      // weekday span stays dropped; a bare month is stored as a month point
      // just below.
      const rangeTimex = v.timex ?? "";
      if (rangeTimex.includes("XXXX") && !onlyYearUnknown(rangeTimex)) return null;
      // A bare year-less month ("in May") arrives as a range over the whole
      // month. Store it as a MONTH point with the picked candidate's year —
      // the same shape a concrete "May 2026" takes below — so the two
      // spellings of one month share a representation.
      if (!("Mod" in v && v.Mod) && /^XXXX-\d{2}$/.test(rangeTimex)) {
        const start = v.start ?? "";
        if (!/^\d{4}-\d{2}/.test(start)) return null;
        return {
          kind: "date",
          resolvedStart: start.slice(0, 7),
          resolvedEnd: null,
          timex: rangeTimex,
          ...base,
          relative: true,
        };
      }
      const mod = v.Mod;
      // A bare year/month comes back as a range (2026 → [2026-01-01,2027-01-01]);
      // with no modifier it is really a coarse point, so store it as one.
      if (!mod && /^\d{4}(-\d{2})?$/.test(v.timex ?? "")) {
        return {
          kind: "date",
          resolvedStart: v.timex!,
          resolvedEnd: null,
          timex: v.timex ?? "",
          ...base,
        };
      }
      const start = v.start && /^\d{4}-\d{2}-\d{2}/.test(v.start) ? v.start.slice(0, 10) : null;
      const end = v.end && /^\d{4}-\d{2}-\d{2}/.test(v.end) ? v.end.slice(0, 10) : null;
      if (!start && !end) return null;
      return {
        kind: "range",
        resolvedStart: start,
        resolvedEnd: end,
        ...(mod ? { mod } : {}),
        timex: v.timex ?? "",
        ...base,
        relative: base.relative || rangeTimex.includes("XXXX"),
      };
    }
    case "duration": {
      // A bare duration ("in 3 years" → P3Y) only becomes a dated signal when
      // the surrounding text points a direction; anchor + duration then carries
      // a concrete year. An ambient duration ("took 3 years") has no year → drop.
      const v = values[0];
      const timex = v.timex ?? "";
      const before = content.slice(Math.max(0, r.start - 14), r.start);
      const after = content.slice(r.end + 1, r.end + 10);
      let canon: string | null = null;
      if (rules.forwardDurationBefore?.test(before)) canon = canonicalDuration(anchor, timex, 1);
      else if (rules.backwardDurationBefore?.test(before))
        canon = canonicalDuration(anchor, timex, -1);
      else if (rules.backwardDurationAfter?.test(after))
        canon = canonicalDuration(anchor, timex, -1);
      if (!canon) return null;
      return { kind: "date", resolvedStart: canon, resolvedEnd: null, timex, ...base };
    }
    // Recurrences (`set`) and bare clock times carry no concrete year → drop.
    default:
      return null;
  }
}

/**
 * Blank the recognizer's pathological inputs in place, preserving length so
 * every offset into the neutralized text is valid in the original:
 *
 *  - URLs — their path/query digits are identifiers, not calendar dates, and
 *    machine-generated pages carry thousands of them;
 *  - long dense digit runs — statement tables, card/IBAN blocks, number
 *    columns. Every number is a candidate date to the recognizer, and its
 *    backtracking on such text goes super-linear (a bank statement at a 20k
 *    cap has been observed to pin a cpu worker for hours). A real date is a
 *    few characters; only runs far longer than any date phrase are blanked,
 *    so "du 16 au 23 août 2026" and friends always survive.
 *
 * Newlines inside a blanked span are kept, so the text's line structure —
 * and every offset — survives blanking.
 *
 * Accepted loss: a run OF genuine date phrases (an ICS-like digest, a dense
 * date list) long and digit-heavy enough to match is blanked with the rest —
 * the region is indistinguishable from a table without parsing it, which is
 * the cost this pass exists to avoid.
 */
export function neutralizeDenseSpans(text: string): string {
  const blank = (span: string): string => span.replace(/[^\n]/g, " ");
  let out = text.replace(/\bhttps?:\/\/[^\s<>"')\]]{8,}/gi, blank);
  // Maximal digit-heavy runs: digits joined by whitespace/punctuation, at
  // least 64 chars long AND at least 20 digits — a table region, never a
  // date phrase (a full "from DD/MM/YYYY to DD/MM/YYYY" span is ~30 chars).
  out = out.replace(/[0-9][0-9\s.,:;/\\\-+*()€$£%|_'"]{62,}[0-9]/g, (span) => {
    const digits = span.replace(/[^0-9]/g, "").length;
    return digits >= 20 ? blank(span) : span;
  });
  return out;
}

/** Chunk starts covering [0, length) at a fixed step of
 *  `SCAN_CHUNK_CHARS - SCAN_CHUNK_OVERLAP`, so each chunk re-covers its
 *  predecessor's tail. */
function chunkStarts(length: number): number[] {
  const starts: number[] = [];
  for (let pos = 0; pos < length; pos += SCAN_CHUNK_CHARS - SCAN_CHUNK_OVERLAP) {
    starts.push(pos);
    if (pos + SCAN_CHUNK_CHARS >= length) break;
  }
  return starts;
}

/**
 * Scan a single document's text for resolved dates, anchored to `anchor` and
 * parsed with `culture`'s recognizer model (default English). Pure and
 * synchronous. The text (after the char cap and dense-span neutralization)
 * is scanned in overlapping chunks so the wall-clock budget can intervene
 * between recognizer calls; `budgetExhausted` reports a scan the budget cut
 * short. Matches are normalized against the ORIGINAL text, so stored
 * matched_text is what the document really says.
 */
export function scanDatesFromText(
  content: string,
  anchor: Date,
  opts: DateExtractionOptions = {},
  culture: DateCulture = ENGLISH_CULTURE,
): DateScanResult {
  if (!content) return { dates: [], budgetExhausted: false };
  const maxChars = opts.maxCharsPerDoc ?? DEFAULT_MAX_CHARS;
  const maxDates = opts.maxDatesPerDoc ?? DEFAULT_MAX_DATES;
  const budgetMs = opts.scanBudgetMs ?? DEFAULT_SCAN_BUDGET_MS;
  const text = content.length > maxChars ? content.slice(0, maxChars) : content;
  const scanText = neutralizeDenseSpans(text);
  const rules = CULTURE_RULES[culture];
  if (rules.dateHint && !rules.dateHint.test(scanText)) {
    return { dates: [], budgetExhausted: false };
  }

  const anchorDay = isoDay(anchor);
  const out: ExtractedDate[] = [];
  const seen = new Set<string>();
  const startedAt = budgetClock();
  let budgetExhausted = false;

  const starts = chunkStarts(scanText.length);
  for (const [index, base] of starts.entries()) {
    // The first chunk always runs — a budget of 0 still yields a bounded,
    // useful prefix scan rather than nothing. Only parses consume the
    // budget clock; hint-skipped chunks are effectively free.
    if (index > 0 && budgetClock() - startedAt > budgetMs) {
      budgetExhausted = true;
      break;
    }
    const chunk = scanText.slice(base, base + SCAN_CHUNK_CHARS);
    if (rules.dateHint && !rules.dateHint.test(chunk)) continue;

    let results: RtModelResult[];
    try {
      results = model(culture).parse(chunk, anchor);
    } catch {
      // A single malformed chunk must never sink the document.
      continue;
    }

    const isFinalChunk = index === starts.length - 1;
    for (const r of results) {
      // A match touching a cut edge may be the PARTIAL view of a phrase the
      // cut split ("2026-10" out of "2026-10-05") — a coarser date the
      // document never asserts, which value-keyed dedup cannot collapse
      // with the real one. The overlap re-covers every cut region whole, so
      // the neighbouring chunk supplies the genuine match: drop anything
      // ending on a non-final chunk's cut, or starting on a non-first
      // chunk's first character.
      if (!isFinalChunk && r.end >= chunk.length - 1) continue;
      if (index > 0 && r.start === 0) continue;
      const absolute = { ...r, start: r.start + base, end: r.end + base };
      const norm = normalizeResult(absolute, anchor, text, rules);
      if (!norm) continue;
      // Drop the document's own anchor-day date. The email `Date:` header
      // (and same-day adverbs like "today"/"now") resolve to the anchor day —
      // the timestamp the document row already holds, not a semantic date in
      // the prose. With a last-edit anchor this drops edit-day mentions on
      // edited documents, the same self-reference by another clock. A future
      // date can never equal the (past/present) anchor day, so this never
      // drops a forward-looking reference.
      if (norm.kind === "date" && !norm.mod && norm.resolvedStart === anchorDay) continue;
      // Dedupe by resolved VALUE (not text span): the same date mentioned
      // twice — or matched by two overlapping chunks — collapses to one
      // entry, the document's list of distinct semantic dates.
      const key = `${norm.kind}|${norm.resolvedStart}|${norm.resolvedEnd}|${norm.mod ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(norm);
      if (out.length >= maxDates) {
        // The cap stopped the scan: unless this was the final chunk's last
        // result, part of the text went unread — the same partial coverage
        // the budget flag reports, by another bound.
        const lastOfScan = isFinalChunk && r === results[results.length - 1];
        return { dates: out, budgetExhausted: budgetExhausted || !lastOfScan };
      }
    }
  }
  return { dates: out, budgetExhausted };
}

/**
 * The dates of {@link scanDatesFromText}, for callers that need no coverage
 * verdict.
 */
export function extractDatesFromText(
  content: string,
  anchor: Date,
  opts: DateExtractionOptions = {},
  culture: DateCulture = ENGLISH_CULTURE,
): ExtractedDate[] {
  return scanDatesFromText(content, anchor, opts, culture).dates;
}

/**
 * The `cpu.extractDatesFromDocs` handler. Synchronous (the CPU worker invokes
 * handlers inline). Routes each pre-fetched document row to its language's
 * recognizer culture, then extracts dates against the row's own anchor
 * (last edit, else emission). A row with an unparseable timestamp — or in a language the
 * recognizer has no culture for — yields an empty date list (still marked
 * processed by the writer so it isn't retried forever).
 */
export function extractDatesForDocs(
  rows: DateExtractionDocRow[],
  opts: DateExtractionOptions = {},
): DateExtractionResult[] {
  const maxChars = opts.maxCharsPerDoc ?? DEFAULT_MAX_CHARS;
  return rows.map((row) => {
    // contentLength counts SQLite code points, content.length UTF-16 units;
    // either exceeding the cap means part of the body went unscanned — and a
    // budget-exhausted scan is the same partial coverage by another bound.
    const charTruncated = (row.contentLength ?? 0) > maxChars || row.content.length > maxChars;
    const anchor = anchorFromIso(row.anchorAt);
    if (!anchor) return { id: row.id, dates: [], truncated: charTruncated };
    const culture = routeDateCulture(row.title, row.content);
    if (!culture) return { id: row.id, dates: [], truncated: charTruncated };
    const scan = scanDatesFromText(row.content, anchor, opts, culture);
    return {
      id: row.id,
      dates: scan.dates,
      truncated: charTruncated || scan.budgetExhausted,
    };
  });
}
