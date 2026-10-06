// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { truncateLexicalText } from "@omnesis/types";
import { layoutReplyText } from "../../ocr/http-vlm-ocr.js";

/**
 * Project rendered Markdown into vocabulary evidence without guessing who
 * authored it. Ambiguous prose, signatures and unmarked quoted replies stay.
 * Input and output are bounded independently of the caller's document cap.
 */
export function vocabularyText(content: string): string {
  const bounded = truncateLexicalText(content, 65536);
  const trimmed = bounded.trimStart();
  let prose = bounded;
  if (trimmed.startsWith("[")) {
    try {
      prose = layoutReplyText(trimmed);
      // A malformed layout whose first field is category or text is not handled by
      // the OCR parser's truncated-bbox recovery. Do not tokenize its schema.
      if (prose === trimmed && /^\[\s*\{\s*"(?:bbox|category|text)"/u.test(trimmed)) prose = "";
      else if (prose === trimmed) prose = bounded;
    } catch {
      // An invalid escape in a truncated region must neither abort the batch
      // nor turn raw JSON into vocabulary. This only affects hint extraction.
      prose = "";
    }
  }
  const lines = prose.split(/\r?\n/u);
  const metadata = /^\*\*[^*\n]{1,64}:\*\*[^\n]*$/u;
  const separator = /^\s{0,3}---\s*$/u;
  let start = 0;
  let end = lines.length;

  // A complete rendered preamble, not an arbitrary heading in the body.
  if (/^# [^\n]+$/u.test(lines[0] ?? "")) {
    let cursor = 1;
    let fields = 0;
    while (cursor < end && (lines[cursor].trim() === "" || metadata.test(lines[cursor]))) {
      if (metadata.test(lines[cursor])) fields++;
      cursor++;
    }
    if (fields >= 2 && separator.test(lines[cursor] ?? "")) start = cursor + 1;
  }

  // The shared attachment renderer appends a rule and one metadata line
  // containing parenthesized attributes ending in a numeric byte size.
  // Unknown-size markers remain ambiguous; ordinary prose footers stay.
  while (end > start && lines[end - 1].trim() === "") end--;
  if (
    end >= start + 2 &&
    separator.test(lines[end - 2]) &&
    metadata.test(lines[end - 1]) &&
    /^\*\*[^*\n]{1,64}:\*\* (?:[^()\n]+\([^()\n]+, \d{1,12}(?:\.\d{1,3})?[KMGT]?B\))(?:, [^()\n]+\([^()\n]+, \d{1,12}(?:\.\d{1,3})?[KMGT]?B\))*$/u.test(
      lines[end - 1],
    )
  ) {
    end -= 2;
  }

  const out: string[] = [];
  let fence: { character: string; length: number } | undefined;
  let previousWasMessage = false;
  let messageContext = false;
  let skippingTranscript = false;
  for (let i = start; i < end; i++) {
    let line = lines[i];
    // Transcript markup must not open a fence that hides the next written message.
    if (skippingTranscript && !/^\*\*\d{1,2}:\d{2}\*\* [^:\n]{1,256}: ?/u.test(line)) continue;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence.character &&
        marker[1].length >= fence.length &&
        marker[2].trim() === ""
      )
        fence = undefined;
      continue;
    }
    if (marker) {
      fence = { character: marker[1][0], length: marker[1].length };
      previousWasMessage = false;
      continue;
    }
    if (/^ {0,3}>/u.test(line)) continue;

    // Timestamp/byline markup is structural; the sender name is separately
    // grounded in the people graph. Never strip an ordinary prose byline.
    const message = /^\*\*\d{1,2}:\d{2}\*\* [^:\n]{1,256}: ?(.*)$/u.exec(line);
    if (message) {
      line = message[1];
      messageContext = true;
      skippingTranscript = false;
    } else if (previousWasMessage && /^ {2}→ /u.test(line)) {
      continue;
    }
    previousWasMessage = Boolean(message);
    // A transcript is rendered after a bracketed audio/duration marker inside
    // a timestamped message. Exclude its multiline tail until the next message;
    // removing only the marker would feed prior ASR errors back as vocabulary.
    // Original written body before an attachment marker remains independent.
    if (skippingTranscript) continue;
    if (messageContext) {
      const transcript = /(?:^|[ \t])\[(?:[^\]\n]{1,64}, (?:\d{1,3}:\d{2}|\?)|Audio)\]: ?/u.exec(
        line,
      );
      if (transcript) {
        line = line.slice(0, transcript.index);
        skippingTranscript = true;
      }
    }

    // Bounds prevent malformed delimiters from causing unbounded rescans.
    line = line
      .replace(/!\[[^\]\n]{0,512}\]\([^)\n]{0,2048}\)/gu, " ")
      .replace(/\[([^\]\n]{0,512})\]\([^)\n]{0,2048}\)/gu, "$1");
    out.push(line);
  }
  return out.join("\n");
}
