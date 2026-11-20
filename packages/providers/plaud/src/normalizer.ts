// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { computeContentHash } from "@omnesis/core";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";
import type { PlaudSummary, TranscriptSegment } from "./content.js";
import type { FileSummary } from "./schemas.js";

/** Where a document's transcript came from. */
type TranscriptSource = "local" | "plaud" | "none";

/** The transcript a recording is rendered with. */
export type RecordingTranscript =
  | { source: "local"; text: string; language?: string }
  | { source: "plaud"; segments: TranscriptSegment[] };

export interface RecordingContent {
  file: FileSummary;
  /** The recorder's name, when the account's device list names its serial. */
  deviceName?: string;
  transcript?: RecordingTranscript;
  summary?: PlaudSummary;
}

/**
 * A Plaud timestamp as ISO 8601. Plaud writes milliseconds on most fields and
 * seconds on some; a value too small to be a millisecond time this century is
 * read as seconds.
 */
export function plaudTime(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const ms = value < 1e11 ? value * 1000 : value;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** `[hh:mm:ss]` for an offset in ms. */
function offset(ms: number): string {
  const total = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `[${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}]`;
}

/** The speakers Plaud's transcript names, in order of first appearance. */
function speakersOf(transcript: RecordingTranscript | undefined): string[] {
  if (transcript?.source !== "plaud") return [];
  return [...new Set(transcript.segments.flatMap((s) => (s.speaker ? [s.speaker] : [])))];
}

function renderContent(content: RecordingContent): string {
  const sections: string[] = [];
  const { summary, transcript } = content;
  if (summary) {
    const lines = ["## Summary"];
    if (summary.text) lines.push("", summary.text);
    if (summary.keyPoints.length > 0) {
      lines.push("", "### Key points", ...summary.keyPoints.map((p) => `- ${p}`));
    }
    if (summary.actionItems.length > 0) {
      lines.push("", "### Action items", ...summary.actionItems.map((a) => `- ${a}`));
    }
    sections.push(lines.join("\n"));
  }
  if (transcript?.source === "local" && transcript.text.trim()) {
    sections.push(`## Transcript\n\n${transcript.text.trim()}`);
  } else if (transcript?.source === "plaud" && transcript.segments.length > 0) {
    const turns = transcript.segments.map((s) => {
      const at = s.startMs !== undefined ? `${offset(s.startMs)} ` : "";
      return `${at}${s.speaker ? `${s.speaker}: ` : ""}${s.text}`;
    });
    sections.push(`## Transcript\n\n${turns.join("\n")}`);
  } else {
    sections.push("## Transcript\n\nNo transcript of this recording is available yet.");
  }
  return sections.join("\n\n");
}

/** One `conversation` document for a Plaud recording. */
export function recordingToDocument(
  content: RecordingContent,
  ctx: { providerId: ProviderId; sourceId: SourceId; accountEmail: string },
): DocumentInput {
  const { file, deviceName, transcript, summary } = content;
  const body = renderContent(content);
  const createdAt = plaudTime(file.start_time) ?? new Date(0).toISOString();
  const updatedAt = plaudTime(file.version_ms) ?? plaudTime(file.edit_time) ?? createdAt;
  const durationMs = file.duration ?? (file.end_time ? file.end_time - file.start_time : undefined);
  const transcriptSource: TranscriptSource =
    transcript?.source === "local" && transcript.text.trim()
      ? "local"
      : transcript?.source === "plaud" && transcript.segments.length > 0
        ? "plaud"
        : "none";
  const speakers = speakersOf(transcript);
  const keywords = (file.keywords ?? []).map((k) => k.trim()).filter(Boolean);
  const language = transcript?.source === "local" ? transcript.language : undefined;

  return {
    providerId: ctx.providerId,
    sourceId: ctx.sourceId,
    externalId: file.id,
    title: file.filename?.trim() || "Untitled recording",
    content: body,
    contentHash: computeContentHash(body),
    metadata: {
      documentType: "conversation",
      tags: ["plaud"],
      // The account owner made the recording; who else spoke is known only
      // by the labels Plaud gave the speakers, which name nobody reliably.
      people: [{ role: "owner", emails: [ctx.accountEmail], isSelf: true }],
      extra: {
        ...(typeof durationMs === "number" && durationMs > 0
          ? { durationSeconds: Math.round(durationMs / 1000) }
          : {}),
        ...(deviceName ? { device: deviceName } : {}),
        transcriptSource,
        hasSummary: summary !== undefined,
        ...(speakers.length > 0 ? { speakers } : {}),
        ...(keywords.length > 0 ? { keywords } : {}),
        ...(language ? { language } : {}),
      },
    },
    sourceCreatedAt: createdAt,
    sourceUpdatedAt: updatedAt,
  };
}
