// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { readFilterPreview } from "./source-filter-requests.js";
import { useScopeLabelGeneration } from "./source-filter-labels.js";
import { CountingRecords } from "./source-filter-table.js";
import { filterApiError } from "./source-filter-fields.js";

/** How long to wait before asking again for counts, when the gateway names no time. */
const COUNT_POLL_MS = 2000;

/** What a failed count reads, wherever counts are shown. */
export const COUNTS_UNAVAILABLE = "Counts could not be loaded.";

/** The button that asks again for counts that could not be loaded. */
export const RETRY_COUNTS_LABEL = "Try again";

/**
 * The whole-account counts of `policy`. While the gateway is still counting
 * it answers `pending`, and the same draft is sent again after the time it
 * names; `pending` stays true until real counts arrive. Counts never decide
 * whether a filter can be applied or saved.
 */
export function useSourceFilterPreview(sourceId, policy) {
  const [attempt, setAttempt] = useState(0);
  const generation = useScopeLabelGeneration();
  const identity = JSON.stringify([generation, sourceId, policy]);
  const current = useRef(identity);
  current.current = identity;
  const [state, setState] = useState({ identity, pending: Boolean(policy), data: null, error: "" });
  useEffect(() => {
    const controller = new AbortController();
    setState((old) =>
      old.identity === identity && old.data
        ? old
        : { identity, pending: Boolean(policy), data: null, error: "" },
    );
    if (policy)
      readFilterPreview(sourceId, policy, controller.signal)
        .then((data) => {
          if (controller.signal.aborted || current.current !== identity) return;
          if (data?.status === "pending")
            setState({ identity, pending: true, data: null, error: "", retryAfterMs: data.retryAfterMs });
          else if (data?.sourceId === sourceId)
            setState({ identity, pending: false, data, error: "" });
        })
        .catch((error) => {
          if (!controller.signal.aborted && current.current === identity)
            setState({
              identity,
              pending: false,
              data: null,
              error: filterApiError(error, COUNTS_UNAVAILABLE),
            });
        });
    return () => controller.abort();
  }, [identity, attempt]);
  const currentState =
    state.identity === identity
      ? state
      : { identity, pending: Boolean(policy), data: null, error: "" };
  const waiting = currentState.pending && Number.isFinite(currentState.retryAfterMs);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(
      () => setAttempt((value) => value + 1),
      Math.max(250, currentState.retryAfterMs || COUNT_POLL_MS),
    );
    return () => clearTimeout(timer);
  }, [identity, waiting, currentState.retryAfterMs]);
  return { ...currentState, retry: () => setAttempt((value) => value + 1) };
}

/** Counts that could not be loaded, with the one way to ask again. */
export function CountsUnavailable({ onRetry }) {
  return html`<span class="source-filter-count-error" role="status"
    ><span>${COUNTS_UNAVAILABLE}</span
    ><button type="button" class="btn-secondary" onClick=${onRetry}>${RETRY_COUNTS_LABEL}</button></span
  >`;
}

/**
 * The gateway's sentences about records a filter keeps hidden whatever it
 * says: those too old to carry what the filter needs, and those whose detail
 * is unknown. Each appears only when its count is not zero.
 */
export function HiddenRecordLines({ data }) {
  const lines = [data?.tooOldText, data?.unmatchedText].filter(
    (line) => typeof line === "string" && line.trim(),
  );
  return lines.length
    ? html`<div class="source-filter-unchecked">${lines.map((line) => html`<p key=${line}>${line}</p>`)}</div>`
    : null;
}

/** The result of a draft filter: how much it shares and hides, and what stays hidden regardless. */
export function FilterPreview({ preview }) {
  if (preview.pending)
    return html`<p class="source-filter-pending" role="status"><${CountingRecords} /></p>`;
  if (preview.error) return html`<${CountsUnavailable} onRetry=${preview.retry} />`;
  const data = preview.data;
  // A gone account has nothing to count; its preview only names the saved entries.
  if (!data || data.connected === false) return null;
  return html`<section class="source-filter-preview" aria-label="Filter preview">
    <div class="source-filter-counts" role="status">
      <span><strong>${data.visible.toLocaleString()}</strong> shared</span
      ><span><strong>${data.hidden.toLocaleString()}</strong> hidden</span>
    </div>
    <${HiddenRecordLines} data=${data} />
  </section>`;
}
