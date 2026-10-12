// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";

/** Transcript/run usage is already normalized: promptTokens includes cached input. */
export function formatRecordedUsage(usage) {
  if (!usage || !Number.isFinite(usage.promptTokens) || !Number.isFinite(usage.completionTokens))
    return null;
  const cached = usage.cacheReadTokens ?? 0;
  const created = usage.cacheCreationTokens ?? 0;
  return `${usage.promptTokens.toLocaleString()} input${cached ? ` (${cached.toLocaleString()} cached)` : ""}${created ? ` (${created.toLocaleString()} cache creation)` : ""} / ${usage.completionTokens.toLocaleString()} output`;
}

export function runUsageLabel(run, transcripts) {
  if (transcripts.length) return "Reported usage is shown with each transcript attempt below.";
  const usage = formatRecordedUsage(run?.usage);
  return usage ? `Run record: ${usage}` : "Not reported";
}

/** Each selected attempt is a separate receipt; missing attempts are never zero spend. */
export function TranscriptUsage({ transcript }) {
  const usage = formatRecordedUsage(transcript.usage);
  return html`<div class="cognition-transcript-meta">
    <strong>Attempt ${transcript.attempt} tokens:</strong>
    ${usage ?? "Not reported"}
    <span class="cognition-dim"> · ${usage ? "Reported for this attempt only; not a run total." : "Missing usage does not mean zero tokens."}</span>
  </div>`;
}
