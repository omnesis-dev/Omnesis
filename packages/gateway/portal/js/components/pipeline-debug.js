// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";

/** Renders a filter value as a pill-style tag. */
function FilterPill({ label, value }) {
  return html`<span class="filter-pill">${label}:${value}</span>`;
}

/**
 * Map a PersonFilter's role-bucket signature back onto the original
 * filter token so the debug pill reads `from:`/`to:`/`with:` the way
 * the user typed it. Unknown role shapes (caller-supplied custom
 * filters via the HTTP body) fall back to a generic `person:` label.
 */
function pillLabelForPersonFilter(roles) {
  if (!roles) return "with";
  if (roles.length === 2 && roles.includes("recipient") && roles.includes("attendee")) {
    return "to";
  }
  if (
    roles.length === 3 &&
    roles.includes("sender") &&
    roles.includes("author") &&
    roles.includes("owner")
  ) {
    return "from";
  }
  return "person";
}

/** Formats filters object into an array of {label, value} pairs. */
function formatFilters(filters) {
  if (!filters) return [];
  const pills = [];
  if (filters.documentTypes) {
    for (const t of filters.documentTypes) pills.push({ label: "type", value: t });
  }
  if (filters.sourceIds) {
    for (const p of filters.sourceIds) pills.push({ label: "source", value: p });
  }
  if (filters.personFilters) {
    for (const pf of filters.personFilters) {
      const label = pillLabelForPersonFilter(pf.roles);
      for (const r of pf.refs) pills.push({ label, value: r });
    }
  }
  if (filters.tags) {
    for (const t of filters.tags) pills.push({ label: "tag", value: t });
  }
  if (filters.dateFrom) pills.push({ label: "after", value: filters.dateFrom });
  if (filters.dateTo) pills.push({ label: "before", value: filters.dateTo });
  return pills;
}

/** Render a single stage row. Shows "skipped — <reason>" when applicable. */
function StageRow({ branch, label, report, modelId }) {
  if (!report) return null;
  if (report.status === "skipped") {
    return html`
      <div class="pipeline-row">
        <span class="pipeline-branch">${branch}</span>
        <span class="pipeline-key">${label}:</span>
        <span class="pipeline-val pipeline-skipped">
          skipped${report.reason ? html` — <span class="pipeline-skipped-reason">${report.reason}</span>` : null}
        </span>
      </div>
    `;
  }
  const parts = [];
  if (modelId) parts.push(modelId);
  if (report.candidates != null) parts.push(`${report.candidates} candidates`);
  if (report.durationMs != null) parts.push(`${report.durationMs}ms`);
  // Vector stage carries an `embedMs` + `sqlMs` split — surface it
  // inline as `(embed=Xms, sql=Yms)` so users can tell whether a
  // slow vector stage was embedder contention or HNSW search + JOIN.
  if (report.embedMs != null || report.sqlMs != null) {
    const sub = [];
    if (report.embedMs != null) sub.push(`embed=${report.embedMs}ms`);
    if (report.sqlMs != null) sub.push(`sql=${report.sqlMs}ms`);
    parts.push(`(${sub.join(", ")})`);
  }
  return html`
    <div class="pipeline-row">
      <span class="pipeline-branch">${branch}</span>
      <span class="pipeline-key">${label}:</span>
      <span class="pipeline-val">${parts.join(" · ") || "ran"}</span>
    </div>
  `;
}

/** Render the fusion row, showing RRF parameters when the fusion method is rrf. */
function FusionRow({ branch, report }) {
  if (!report || report.status !== "ran") return null;
  let summary;
  if (report.method === "rrf") {
    const weights = [];
    if (report.bm25Weight != null) weights.push(`bm25=${report.bm25Weight}`);
    if (report.vectorWeight != null) weights.push(`vector=${report.vectorWeight}`);
    const params = [];
    if (report.rrfK != null) params.push(`k=${report.rrfK}`);
    if (weights.length) params.push(weights.join(", "));
    summary = html`RRF(${params.join(", ")}) → ${report.resultCount} results`;
  } else if (report.method === "bm25-only") {
    summary = html`BM25-only → ${report.resultCount} results`;
  } else {
    summary = `${report.resultCount} results`;
  }
  return html`
    <div class="pipeline-row">
      <span class="pipeline-branch">${branch}</span>
      <span class="pipeline-key">Fusion:</span>
      <span class="pipeline-val">${summary}</span>
    </div>
  `;
}

export function PipelineDebug({ response }) {
  if (!response) return null;

  const { query, timing, models, results, stages } = response;
  const embeddingModel = models?.embedding;
  const filters = formatFilters(query.parsedFilters);
  const resultCount = results ? results.length : 0;

  // Which stages does the response claim to have considered? `stages` is
  // the structured report; when absent (older server / unit tests) we
  // fall back to inferring from timing.
  const bm25Stage = stages?.bm25 ?? (timing.bm25Ms != null
    ? { status: "ran", durationMs: timing.bm25Ms, candidates: timing.bm25Candidates }
    : null);
  const vectorStage = stages?.vector ?? (timing.vectorMs != null
    ? { status: "ran", durationMs: timing.vectorMs, candidates: timing.vectorCandidates }
    : null);
  const fusionStage = stages?.fusion;

  // Pick the last-visible stage in order [bm25, vector, fusion] so we
  // draw "└─" instead of "├─" on the terminal row for a clean tree.
  const visibleStages = [
    bm25Stage ? "bm25" : null,
    vectorStage ? "vector" : null,
    fusionStage ? "fusion" : null,
  ].filter(Boolean);
  const lastStage = visibleStages[visibleStages.length - 1];
  const branch = (name) => (name === lastStage ? "└─" : "├─");

  return html`
    <div class="pipeline-debug">
      <div class="pipeline-header">Pipeline</div>

      <div class="pipeline-section">
        <div class="pipeline-label">Query</div>
        <div class="pipeline-tree">
          <div class="pipeline-row">
            <span class="pipeline-branch">├─</span>
            <span class="pipeline-key">Original:</span>
            <span class="pipeline-val">"${query.original}"</span>
          </div>
          ${query.effectiveText && html`
            <div class="pipeline-row">
              <span class="pipeline-branch">├─</span>
              <span class="pipeline-key">Effective:</span>
              <span class="pipeline-val">"${query.effectiveText}"</span>
            </div>
          `}
          <div class="pipeline-row">
            <span class="pipeline-branch">└─</span>
            <span class="pipeline-key">Filters:</span>
            ${filters.length > 0
              ? html`<span class="pipeline-filters">${filters.map(f => html`<${FilterPill} label=${f.label} value=${f.value} />`)}</span>`
              : html`<span class="pipeline-val pipeline-none">none</span>`
            }
          </div>
        </div>
      </div>

      <div class="pipeline-section">
        <div class="pipeline-label">Stages</div>
        <div class="pipeline-tree">
          <${StageRow} branch=${branch("bm25")} label="BM25" report=${bm25Stage} />
          <${StageRow} branch=${branch("vector")} label="Vector" report=${vectorStage} modelId=${embeddingModel} />
          <${FusionRow} branch=${branch("fusion")} report=${fusionStage} />
          ${visibleStages.length === 0 && html`
            <div class="pipeline-row">
              <span class="pipeline-branch">└─</span>
              <span class="pipeline-val pipeline-none">no stages ran</span>
            </div>
          `}
        </div>
      </div>

      <div class="pipeline-footer">
        ${resultCount} result${resultCount !== 1 ? "s" : ""} in ${timing.totalMs}ms
      </div>
    </div>
  `;
}
