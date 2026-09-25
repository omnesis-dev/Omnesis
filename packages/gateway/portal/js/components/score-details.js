// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";

export function ScoreDetails({ breakdown }) {
  if (!breakdown) return null;

  return html`
    <div class="score-details">
      ${breakdown.bm25Rank != null && html`<span>BM25: #${breakdown.bm25Rank}</span>`}
      ${breakdown.vectorRank != null && html`<span>Vec: #${breakdown.vectorRank}</span>`}
      ${breakdown.rrfScore != null && html`<span>RRF: ${breakdown.rrfScore.toFixed(4)}</span>`}
      ${breakdown.rankBonus != null && html`<span>Rank bonus: +${breakdown.rankBonus.toFixed(3)}</span>`}
      ${breakdown.typeBoost != null && html`<span>Type: ${breakdown.typeBoost.toFixed(3)}x</span>`}
      ${breakdown.relevanceBoost != null && html`<span>Relevance: ${breakdown.relevanceBoost.toFixed(3)}x</span>`}
      ${breakdown.finalScore != null && html`<span>Final: ${breakdown.finalScore.toFixed(4)}</span>`}
    </div>
  `;
}
