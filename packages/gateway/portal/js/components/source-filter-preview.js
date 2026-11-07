// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { readFilterPreview } from "./source-filter-requests.js";
import { scopeDisplayLabel, useScopeLabelGeneration } from "./source-filter-labels.js";
import { scopeRefKey } from "./source-filter-state.js";

export function filterApiError(error, fallback) {
  return error?.serverMessage || fallback;
}

export function useSourceFilterPreview(sourceId, policy) {
  const [attempt, setAttempt] = useState(0);
  const generation = useScopeLabelGeneration();
  const identity = JSON.stringify([generation, sourceId, policy]);
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
  return { ...currentState, retry: () => setAttempt((value) => value + 1) };
}

export function FilterReadiness({ readiness = [] }) {
  const pending = readiness.filter((item) => !item.ready);
  return pending.length
    ? html`<div class="source-filter-readiness" role="status">
        ${pending.map(
          (item) =>
            html`<p key=${item.kind}>
              <strong>${item.kind}:</strong> ${item.message || "Waiting for source metadata."}
              ${Number.isFinite(item.processed) ? html`<small>${item.processed} processed${Number.isFinite(item.pending) ? `, ${item.pending} pending` : ""}.</small>` : null}
              ${item.behindCollectors?.length ? html`<small>Update these collectors: ${item.behindCollectors.map((collector) => collector.name).join(", ")}.</small>` : null}
            </p>`,
        )}
      </div>`
    : null;
}

export function FilterPreview({ preview, showSamples = true }) {
  if (preview.pending)
    return html`<p class="source-filter-pending" role="status">
      Calculating visible, hidden and unknown records…
    </p>`;
  if (preview.error)
    return html`<div class="source-filter-count-error" role="status">
      <p>Counts could not be loaded. Your restriction is unchanged.</p>
      <button type="button" class="btn-secondary" onClick=${preview.retry}>Retry counts</button>
      <details>
        <summary>Details</summary>
        ${preview.error}
      </details>
    </div>`;
  if (!preview.data) return null;
  const data = preview.data;
  const preparing = data.readiness?.some((item) => !item.ready);
  return html`<section class="source-filter-preview" aria-label="Filter preview">
    <${FilterReadiness} readiness=${data.readiness} />
    ${preparing ? html`<p role="status">Provisional counts — source metadata is still preparing. Applying this filter is blocked until it is ready.</p>` : null}
    <div class="source-filter-counts">
      <span><strong>${data.visible}</strong> visible</span
      ><span><strong>${data.hidden}</strong> hidden</span
      ><span><strong>${data.unknown}</strong> unknown</span>
    </div>
    <p class="source-filter-explanation">
      Unknown records are included in hidden. A record without the required source facts is never
      shared.
    </p>
    ${
      showSamples && data.samples?.length
        ? html`<details>
            <summary>Sample records (${data.samples.length})</summary>
            <ul class="source-filter-samples">
              ${data.samples.map((sample) => html`<li key=${sample.documentId}><span>${sample.title || "Untitled record"}</span><small>${sample.unknown ? "Unknown — hidden" : sample.visible ? "Visible" : "Hidden"}</small></li>`)}
            </ul>
          </details>`
        : null
    }
  </section>`;
}

export function SourcePolicySummary({ policy, source, capability }) {
  const preview = useSourceFilterPreview(policy.sourceId, policy);
  const labels = preview.data?.items ?? [];
  return html`<section
    class="source-policy-summary"
    aria-label=${`${capability} filter for ${source?.displayName || source?.name || "Unavailable account"}`}
  >
    <strong>${source?.displayName || source?.name || "Unavailable account"}</strong>
    ${(Array.isArray(policy.rules) ? policy.rules : []).map(
      (rule, index) =>
        html`<div key=${index}>
          <span
            >${rule.action === "share" ? "Share matches" : rule.action === "hide" ? "Hide matches" : `Saved action: ${rule.action}`}
            (${rule.match.length}):
          </span>
          <ul>
            ${rule.match.map((ref) => {
              const item = labels.find((entry) => scopeRefKey(entry.ref) === scopeRefKey(ref));
              return html`<li>
                ${scopeDisplayLabel(policy.sourceId, ref, source).label}${ref.kind === "participant" ? ` · ${ref.identifiers.map((id) => id.value).join(" or ")}` : ""}${item?.missing ? " — missing, decision retained" : ""}${item ? ` (${item.count})` : ""}
              </li>`;
            })}
          </ul>
        </div>`,
    )}
    <small>Everything else: ${policy.otherwise === "share" ? "share" : "hide"}.</small>
    <${FilterPreview} preview=${preview} showSamples=${false} />
  </section>`;
}
