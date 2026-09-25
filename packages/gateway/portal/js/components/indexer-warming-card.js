// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { navigate } from "../lib/router.js";

/**
 * Rendered in the Search view while the indexer worker is still loading
 * its embedding model (typically ~15s after gateway start). Search still
 * answers during this window, but on keyword matching alone — the banner
 * warns the user before they form a wrong impression of the result
 * quality.
 *
 * States handled:
 *   spawning       → worker thread hasn't reported ready yet
 *   loading-model  → model is actively loading from disk
 *   failed         → init threw (e.g. DB open error); shows the reason
 *   disabled       → OMNESIS_INDEXER_ENABLED=false or model missing
 *
 * `status: "ready"` hides the card.
 */
export function IndexerWarmingCard({ readiness }) {
  const ix = readiness?.indexer;
  if (!ix || ix.status === "ready") return null;

  let title;
  let body;
  let tone = "warming"; // "warming" | "error"

  if (ix.status === "spawning" || ix.status === "loading-model") {
    const pct = typeof ix.progress === "number" ? Math.round(ix.progress * 100) : null;
    const stageLabels = {
      "hnsw-backfill": "Loading search index",
      "loading-model": "Loading model weights",
      "warmup": "Warming up",
      "initial-cycle": "Initial indexing",
    };
    const stageLabel = ix.stage ? stageLabels[ix.stage] || ix.stage : null;
    title = "Embedder warming up";
    body = html`
      <p>
        The indexer worker is still loading the embedding model. Vector search
        isn't available yet, so results come from keyword matching alone for now.
      </p>
      ${pct !== null && html`
        <div class="indexer-warming-progress-wrap">
          ${stageLabel && html`<span class="indexer-warming-stage">${stageLabel}</span>`}
          <div class="indexer-warming-progress-bar">
            <div class="indexer-warming-progress-fill" style=${{ width: `${pct}%` }} />
          </div>
          <span class="indexer-warming-progress-label">${pct}%</span>
        </div>
      `}
      ${ix.message ? html`<p class="indexer-warming-note">${ix.message}</p>` : null}
    `;
  } else if (ix.status === "failed") {
    tone = "error";
    title = "Indexer worker failed to start";
    body = html`
      <p>
        Vector search is unavailable. Results come from keyword matching alone.
      </p>
      <pre class="indexer-warming-reason">${ix.reason}</pre>
      <p class="indexer-warming-note">
        Restart the gateway. If the error repeats, check <code>~/.config/omnesis/</code> for the reported DB file.
      </p>
    `;
  } else if (ix.status === "disabled") {
    tone = "error";
    title = "Indexer disabled";
    const missingModel = typeof ix.reason === "string" && /model not found/i.test(ix.reason);
    body = html`
      <p>Indexing and vector search are unavailable.</p>
      <pre class="indexer-warming-reason">${ix.reason}</pre>
      ${missingModel && html`
        <p class="indexer-warming-note">
          Open the <a href="/portal/settings/models" onClick=${(e) => { e.preventDefault(); navigate("/portal/settings/models"); }}><strong>Models</strong> tab</a> to install an embedding model — the indexer will pick it up automatically.
        </p>
      `}
    `;
  } else {
    return null;
  }

  return html`
    <div class=${`indexer-warming-card indexer-warming-${tone}`}>
      <div class="indexer-warming-header">
        <span class="indexer-warming-pill">${tone === "error" ? "INDEXER ERROR" : "WARMING UP"}</span>
        <span class="indexer-warming-title">${title}</span>
      </div>
      <div class="indexer-warming-body">${body}</div>
    </div>
  `;
}
