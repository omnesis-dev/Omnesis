// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Pure form state for the history-import modal. A field carrying `when` is
// shown only while an earlier field holds the named value — so a form that
// branches on a leading `select` asks for one variant's fields, never all of
// them. Hidden fields are neither required nor sent, matching the CLI's
// `sources import-history`.

/** The fields to render for the current values, in declaration order. */
export function visibleImportFields(fields, values) {
  return (fields || []).filter((f) => !f.when || values[f.when.field] === f.when.equals);
}

/** Whether a visible required field is still empty. */
export function hasMissingRequired(fields, values) {
  return visibleImportFields(fields, values).some(
    (f) => f.required && !String(values[f.key] ?? "").trim(),
  );
}

/** The trimmed values of the visible fields — what the import is started with. */
export function importValues(fields, values) {
  return Object.fromEntries(
    visibleImportFields(fields, values).map((f) => [f.key, String(values[f.key] ?? "").trim()]),
  );
}
