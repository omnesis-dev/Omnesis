// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { readFilterPreview } from "./source-filter-requests.js";
import { useScopeLabelGeneration } from "./source-filter-labels.js";
import { CountingRecords, RETRY_COUNTS_LABEL } from "./source-filter-table.js";
import { unreadyKinds } from "./source-filter-state.js";

export function filterApiError(error, fallback) {
  return error?.serverMessage || fallback;
}

/** How long to wait before asking again for counts that are still being worked out. */
export const COUNT_POLL_MS = 2000;

export function useSourceFilterPreview(sourceId, policy) {
  const [attempt, setAttempt] = useState(0);
  const generation = useScopeLabelGeneration();
  const identity = JSON.stringify([generation, sourceId, policy, attempt]);
  const current = useRef(identity);
  current.current = identity;
  const [state, setState] = useState({ identity, pending: Boolean(policy), data: null, error: "" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ identity, pending: Boolean(policy), data: null, error: "" });
    if (policy)
      readFilterPreview(sourceId, policy, controller.signal)
        .then((data) => {
          if (
            !controller.signal.aborted &&
            current.current === identity &&
            data.sourceId === sourceId
          )
            setState({ identity, pending: false, data, error: "" });
        })
        .catch((error) => {
          if (!controller.signal.aborted && current.current === identity)
            setState({
              identity,
              pending: false,
              data: null,
              error: filterApiError(
                error,
                "The filter preview is unavailable. Your selection is retained.",
              ),
            });
        });
    return () => controller.abort();
  }, [identity, attempt]);
  const currentState =
    state.identity === identity
      ? state
      : { identity, pending: Boolean(policy), data: null, error: "" };
  // Counts that are still being worked out are asked for again until they arrive.
  const counting = unreadyKinds(policy, currentState.data?.readiness).length > 0;
  useEffect(() => {
    if (!counting) return;
    const timer = setTimeout(() => setAttempt((value) => value + 1), COUNT_POLL_MS);
    return () => clearTimeout(timer);
  }, [identity, counting]);
  return { ...currentState, retry: () => setAttempt((value) => value + 1) };
}

const COUNTING = html`<p class="source-filter-pending" role="status"><${CountingRecords} /></p>`;

/**
 * Records a filter cannot be compared with yet: the gateway does not have, or
 * is still updating, the details a filter on their source matches them
 * on, so they stay hidden until those details arrive.
 */
function uncheckedLine(count) {
  return count === 1
    ? "1 record stays hidden until its details finish syncing."
    : `${count.toLocaleString()} records stay hidden until their details finish syncing.`;
}
const UNCHECKED_DETAIL =
  "Omnesis doesn’t have the details it needs to check them yet. Nothing is shared by mistake while they sync.";

/** The result of `policy`: how much it shares and hides, once the counts are in. */
export function FilterPreview({ preview, policy }) {
  if (preview.pending) return COUNTING;
  if (preview.error)
    return html`<div class="source-filter-count-error" role="status">
      <p>Counts are unavailable. Your selection is retained.</p>
      <button type="button" class="btn-secondary" onClick=${preview.retry}>${RETRY_COUNTS_LABEL}</button>
    </div>`;
  if (!preview.data) return null;
  const data = preview.data;
  if (unreadyKinds(policy, data.readiness).length) return COUNTING;
  return html`<section class="source-filter-preview" aria-label="Filter preview">
    <div class="source-filter-counts" role="status">
      <span><strong>${data.visible.toLocaleString()}</strong> shared</span
      ><span><strong>${data.hidden.toLocaleString()}</strong> hidden</span>
    </div>
    ${data.unknown > 0 ? html`<div class="source-filter-unchecked">
          <p>${uncheckedLine(data.unknown)}</p>
          <p class="source-filter-unchecked-detail">${UNCHECKED_DETAIL}</p>
        </div>` : null}
  </section>`;
}
