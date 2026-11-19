// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Plaud's own processing of a recording: its transcript and its summary.
 *
 * `GET /file/detail/{id}` lists the content Plaud produced, each item with a
 * type, a processing status and a presigned link, and carries some of it
 * inline. Which item is which follows Plaud's web app: the `data_type`
 * strings drift, so the `data_id` prefix decides as well. The summary's shape
 * matches what Riffado observed; the transcript's segment shape has not been
 * checked against a real recording, so it is read defensively — a shape this
 * does not recognise yields no transcript rather than a wrong one.
 */

import type { ContentItem, FileDetail } from "./schemas.js";

/** One spoken turn of Plaud's transcript. */
export interface TranscriptSegment {
  /** Offset from the start of the recording, in ms. */
  startMs?: number;
  speaker?: string;
  text: string;
}

export interface PlaudSummary {
  text: string;
  keyPoints: string[];
  actionItems: string[];
}

const TRANSCRIPT_TYPES = new Set(["transaction", "transcript"]);
const TRANSCRIPT_ID_PREFIX = "source_transaction:";
const PRIMARY_SUMMARY_TYPE = "auto_sum_note";
const PRIMARY_SUMMARY_ID_PREFIX = "auto_sum:";
const SUMMARY_TYPES = new Set([PRIMARY_SUMMARY_TYPE, "sum_multi_note", "summary", "ai_summary"]);
const SUMMARY_ID_PREFIXES = [PRIMARY_SUMMARY_ID_PREFIX, "sum_multi:"];
/** Plaud's processing status for finished content. */
const READY = 1;

/** The transcript and summary items of a recording, when Plaud has finished them. */
export function selectContent(detail: FileDetail): {
  transcript?: ContentItem;
  summary?: ContentItem;
} {
  let transcript: ContentItem | undefined;
  let primary: ContentItem | undefined;
  let secondary: ContentItem | undefined;
  for (const item of detail.content_list ?? []) {
    if (item.task_status !== READY) continue;
    const type = (item.data_type ?? "").toLowerCase();
    const id = item.data_id ?? "";
    if (TRANSCRIPT_TYPES.has(type) || id.startsWith(TRANSCRIPT_ID_PREFIX)) {
      transcript ??= item;
    } else if (type === PRIMARY_SUMMARY_TYPE || id.startsWith(PRIMARY_SUMMARY_ID_PREFIX)) {
      primary ??= item;
    } else if (SUMMARY_TYPES.has(type) || SUMMARY_ID_PREFIXES.some((p) => id.startsWith(p))) {
      secondary ??= item;
    }
  }
  const summary = primary ?? secondary;
  return { ...(transcript ? { transcript } : {}), ...(summary ? { summary } : {}) };
}

/**
 * The copy of an item Plaud delivered inline with the detail, parsed as JSON
 * when it is JSON. `undefined` when there is none and the link must be read.
 */
export function inlineContent(detail: FileDetail, item: ContentItem): unknown {
  if (!item.data_id) return undefined;
  const entry = (detail.pre_download_content_list ?? []).find((e) => e.data_id === item.data_id);
  if (typeof entry?.data_content !== "string") return undefined;
  try {
    return JSON.parse(entry.data_content) as unknown;
  } catch {
    return entry.data_content;
  }
}

/**
 * Plaud's transcript as spoken turns. Accepts a bare segment array or an
 * object wrapping one under `segments`, `transcript` or `data`. Returns an
 * empty list for anything else.
 */
export function parseTranscript(raw: unknown): TranscriptSegment[] {
  const list = segmentList(raw);
  const out: TranscriptSegment[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const s = entry as Record<string, unknown>;
    const text =
      typeof s.content === "string" ? s.content : typeof s.text === "string" ? s.text : "";
    if (!text.trim()) continue;
    const speaker =
      typeof s.speaker === "string" && s.speaker.trim()
        ? s.speaker.trim()
        : typeof s.speaker === "number" && Number.isFinite(s.speaker)
          ? `Speaker ${s.speaker}`
          : undefined;
    const startMs =
      typeof s.start_time === "number" && Number.isFinite(s.start_time) && s.start_time >= 0
        ? s.start_time
        : undefined;
    out.push({
      text: text.trim(),
      ...(speaker ? { speaker } : {}),
      ...(startMs !== undefined ? { startMs } : {}),
    });
  }
  return out;
}

function segmentList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  for (const key of ["segments", "transcript", "data"]) {
    if (Array.isArray(obj[key]) && obj[key].length > 0) return obj[key];
  }
  return [];
}

/**
 * Plaud's summary. A bare string is the summary; an object carries it under
 * `ai_content`, `summary` or `content`, with optional key points and action
 * items. `undefined` when there is no text.
 */
export function parseSummary(raw: unknown): PlaudSummary | undefined {
  if (typeof raw === "string") {
    return raw.trim() ? { text: raw.trim(), keyPoints: [], actionItems: [] } : undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const text = [obj.ai_content, obj.summary, obj.content].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  const keyPoints = strings(obj.key_points ?? obj.keyPoints);
  const actionItems = strings(obj.action_items ?? obj.actionItems);
  if (!text && keyPoints.length === 0 && actionItems.length === 0) return undefined;
  return { text: text?.trim() ?? "", keyPoints, actionItems };
}

function strings(v: unknown): string[] {
  return Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim())
    : [];
}
