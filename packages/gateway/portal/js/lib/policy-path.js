// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The address of one privacy policy's editor.
//
// A policy is named from three places — the Policies tab's own list, a grant
// lane on the Access tab, and a privacy review that ran under it — and all
// three must land on the same page, so they build the path here rather than
// each spelling it out.

export function policyEditorPath(policyFamilyId) {
  return `/portal/settings/policies/${encodeURIComponent(policyFamilyId)}`;
}
