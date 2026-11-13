// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { capitalized, fieldNoun } from "./source-filter-fields.js";

/** What a field holds on this record, in plain words: its items, "None", or the gateway's sentence. */
export function filterDetailValue(field) {
  if (field.state !== "present") return field.stateText || "Not recorded";
  const labels = (field.items ?? []).map((item) => item.label).filter(Boolean);
  return labels.length ? labels.join(", ") : "None";
}

/**
 * The details a filter decides this record by — its labels, folder, chat or
 * people, by name — and the source version that wrote it, so the owner can
 * see why a filter does or does not match it.
 */
export function DocumentFilterDetails({ details }) {
  if (!details) return null;
  return html`<section class="meta-section meta-filter-details" aria-label="Filter details">
    <div class="meta-section-title">Filter details</div>
    ${(details.fields ?? []).map((field) => {
      // "Chat", "People", "Labels: None"; a field the record cannot answer for is named once.
      const many = field.state === "present" && (field.items ?? []).length !== 1;
      const name = capitalized(fieldNoun(field, many));
      return html`<div class="meta-row" key=${field.field}>
        <span class="meta-key">${name}</span>
        <span class=${`meta-value meta-value-text${field.state === "present" ? "" : " meta-value-muted"}`}
          >${filterDetailValue(field)}</span
        >
      </div>`;
    })}
    <div class="meta-row">
      <span class="meta-key">Source version</span>
      <span class="meta-value meta-value-text">${details.sourceVersion}</span>
    </div>
  </section>`;
}
