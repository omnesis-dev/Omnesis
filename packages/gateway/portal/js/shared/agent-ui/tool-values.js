// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EPHEMERAL_TRAIL_DOCS_MAX } from "./lifecycle.js";

export function flattenTrailDocs(events) {
  const out = [];
  const seen = new Set();
  function push(doc) {
    if (!doc || !doc.documentId || seen.has(doc.documentId)) return;
    seen.add(doc.documentId);
    out.push({ documentId: doc.documentId, title: doc.title, sourceId: doc.sourceId });
  }
  for (const event of events) {
    push(event?.doc);
    for (const attachment of event?.attachments ?? []) {
      push(attachment?.doc);
    }
    if (out.length >= EPHEMERAL_TRAIL_DOCS_MAX) break;
  }
  return out.slice(0, EPHEMERAL_TRAIL_DOCS_MAX);
}

export function normaliseRow(row, n) {
  if (!Array.isArray(row)) return new Array(n).fill(null);
  if (row.length === n) return row;
  if (row.length > n) return row.slice(0, n);
  return row.concat(new Array(n - row.length).fill(null));
}

export function formatSqlCell(v) {
  if (v == null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  // DuckDB date/timestamp objects round-trip as { days } / { micros }.
  if (typeof v === "object") {
    if (v.days != null && Object.keys(v).length === 1) {
      const d = new Date(v.days * 86_400_000);
      return d.toISOString().slice(0, 10);
    }
    if (v.micros != null && Object.keys(v).length === 1) {
      const d = new Date(v.micros / 1000);
      return d.toISOString().replace("T", " ").slice(0, 16);
    }
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}
