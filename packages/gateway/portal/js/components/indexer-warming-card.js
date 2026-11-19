// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { navigate } from "../lib/router.js";

const EMBEDDING_SETTINGS_PATH = "/portal/settings/models/embedder";

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
 *   disabled       → keyword-only mode, model missing, or indexing turned off
 *
 * `status: "ready"` hides the card.
 */
export function IndexerWarmingCard({ readiness }) {
  const ix = readiness?.indexer;
  if (!ix || ix.status === "ready") return null;

  let title;
  let body;
  let tone = "warming";

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
    const reason = typeof ix.reason === "string" ? ix.reason : "";
    const missingModel = /model not found/i.test(reason);
    if (ix.keywordIndexingActive || missingModel) {
      const diagnostic = reason.replace(/; keyword indexing active$/, "");
      tone = "info";
      title = ix.keywordIndexingActive ? "Keyword-only search" : "Embedding model missing";
      body = html`
        <p>
          <a href=${EMBEDDING_SETTINGS_PATH} onClick=${(event) => {
            if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            navigate(EMBEDDING_SETTINGS_PATH);
          }}>Set up an embedding model</a> to search by meaning as well as by keyword.
        </p>
        ${diagnostic && diagnostic !== "Embedder assignment disabled" && html`
          <details>
            <summary class="indexer-warming-note">Technical details</summary>
            <pre class="indexer-warming-reason">${diagnostic}</pre>
          </details>
        `}
      `;
    } else {
      tone = "error";
      title = "Indexer disabled";
      body = html`
        <p>Indexing and vector search are unavailable.</p>
        <pre class="indexer-warming-reason">${ix.reason}</pre>
      `;
    }
  } else {
    return null;
  }

  return html`
    <div class=${`indexer-warming-card indexer-warming-${tone}`}>
      <div class="indexer-warming-header">
        ${tone !== "info" && html`
          <span class="indexer-warming-pill">${tone === "error" ? "INDEXER ERROR" : "WARMING UP"}</span>
        `}
        <span class="indexer-warming-title">${title}</span>
      </div>
      <div class="indexer-warming-body">${body}</div>
    </div>
  `;
}
