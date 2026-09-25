// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Backend model-list curation for the capability model picker.
 *
 * The OpenAI-compatible `/v1/models` endpoint a probed HTTP backend speaks can
 * return hundreds of model ids (a full OpenAI account lists ~300). Dumping all
 * of them into a flat list is unusable, so this module curates the candidates
 * for a given capability into three buckets and a capped, searchable view:
 *
 *   1. `suggested`  — models whose name-heuristic role (computed server-side by
 *                     `classifyModelRoles`, shipped as `status.modelRoles`)
 *                     matches the capability tab the user is on. These are the
 *                     ones that actually make sense to pick here.
 *   2. `others`     — every other model the backend serves (chat models on the
 *                     Embedder tab, etc.). Hidden behind a toggle / surfaced
 *                     only when the user searches for them.
 *   3. free text    — the picker always keeps a free-text box so any id can be
 *                     typed by hand; this module only governs what's *listed*.
 *
 * `filterBackendModels` is a pure function: given the candidate id → roles map,
 * the active role, a search query, and a render cap, it returns the curated,
 * length-bounded lists the picker renders (ids are inherently unique, being
 * object keys). Keeping it pure makes the "300 models" curation unit-testable
 * without a DOM.
 */

import { fuzzyMatchModelId } from "./fuzzy-match.js";

/** Default ceiling on how many rows the picker renders per group. */
export const DEFAULT_MODEL_RENDER_CAP = 50;

/**
 * Curate a backend's probed/known models for one capability.
 *
 * @param {Record<string, string[]>} modelRoles
 *   id → suggested roles, as shipped on `BackendStatus.modelRoles`.
 * @param {string} role  active capability role (e.g. "embedder").
 * @param {object} [opts]
 * @param {string} [opts.query=""]  fuzzy token filter on the id
 *   (see `fuzzy-match.js`).
 * @param {boolean} [opts.includeOthers=false]
 *   when false, only role-matching models are listed unless a non-empty query
 *   is given (a query searches across *all* models so a user can always find a
 *   model the heuristic mis-bucketed).
 * @param {number} [opts.cap=DEFAULT_MODEL_RENDER_CAP]  max rows per group.
 * @returns {{
 *   suggested: string[],
 *   others: string[],
 *   suggestedCount: number,
 *   othersCount: number,
 *   suggestedTruncated: boolean,
 *   othersTruncated: boolean,
 *   totalCandidates: number,
 * }}
 *   `suggested`/`others` are the capped, sorted ids to render; the `*Count`
 *   fields are the pre-cap totals so the UI can say "showing 50 of 312".
 */
export function filterBackendModels(modelRoles, role, opts = {}) {
  const { query = "", includeOthers = false, cap = DEFAULT_MODEL_RENDER_CAP } = opts;
  const ids = Object.keys(modelRoles ?? {});
  const q = query.trim().toLowerCase();

  const matchesQuery = (id) => fuzzyMatchModelId(id, query);
  const hasRole = (id) => Array.isArray(modelRoles[id]) && modelRoles[id].includes(role);

  // Partition by whether the heuristic puts the model in this capability.
  const suggestedAll = ids.filter((id) => hasRole(id) && matchesQuery(id)).sort(byId);

  // "Others" is everything not suggested for this role. It's only surfaced when
  // the user explicitly asks (toggle) OR is actively searching — a search must
  // be able to reach a mis-classified model, so a non-empty query always spans
  // the full set regardless of the toggle.
  const showOthers = includeOthers || q !== "";
  const othersAll = showOthers
    ? ids.filter((id) => !hasRole(id) && matchesQuery(id)).sort(byId)
    : [];

  return {
    suggested: suggestedAll.slice(0, cap),
    others: othersAll.slice(0, cap),
    suggestedCount: suggestedAll.length,
    othersCount: othersAll.length,
    suggestedTruncated: suggestedAll.length > cap,
    othersTruncated: othersAll.length > cap,
    totalCandidates: ids.length,
  };
}

/** Stable, case-insensitive id sort so the picker order is deterministic. */
function byId(a, b) {
  return a.toLowerCase().localeCompare(b.toLowerCase());
}
