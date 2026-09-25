// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { GranolaNoteDetail, GranolaTranscriptSegment } from "./types.js";

/** Label a transcript segment's speaker — diarization label, else the audio source. */
function speakerLabel(seg: GranolaTranscriptSegment): string {
  if (seg.speaker.diarization_label) return seg.speaker.diarization_label;
  return seg.speaker.source === "microphone" ? "Me" : "Them";
}

/**
 * Render a Granola note as Markdown for full-text search: title, a metadata
 * line, the AI summary, the attendee list, and the full transcript with
 * speaker attribution. The transcript is what makes meetings searchable by
 * what was actually said, so it goes in verbatim.
 */
export function renderNoteMarkdown(note: GranolaNoteDetail): string {
  const lines: string[] = [];
  const title = note.title?.trim() || "Untitled meeting";
  lines.push(`# ${title}`, "");

  const meta: string[] = [];
  const start = note.calendar_event?.start_time ?? note.transcript?.[0]?.start_time;
  if (start) meta.push(formatDate(start));
  if (note.attendees.length > 0) meta.push(`${note.attendees.length} attendees`);
  if (meta.length > 0) {
    lines.push(`> ${meta.join(" · ")}`, "");
  }

  const summary = note.summary_markdown?.trim() || note.summary_text?.trim();
  if (summary) {
    lines.push("## Summary", "", summary, "");
  }

  if (note.attendees.length > 0) {
    lines.push("## Attendees", "");
    for (const a of note.attendees) {
      const name = a.name?.trim();
      lines.push(name ? `- ${name} <${a.email}>` : `- ${a.email}`);
    }
    lines.push("");
  }

  if (note.transcript && note.transcript.length > 0) {
    lines.push("## Transcript", "");
    for (const seg of note.transcript) {
      const text = seg.text.trim();
      if (!text) continue;
      lines.push(`**${speakerLabel(seg)}:** ${text}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}
