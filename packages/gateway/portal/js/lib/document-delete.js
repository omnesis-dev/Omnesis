// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The two ways to delete a document, explained once for every delete prompt.
 * "For good" writes the gateway's durable tombstone; "this copy" leaves the
 * source free to bring the document back.
 */
export const DELETE_CHOICE_BODY =
  "Delete for good: removed, and a later sync or capture will not add it back. Delete this copy: removed now, but a later sync or capture may add it again.";

/**
 * Delete-confirm copy for document delete prompts (document page and
 * recent-items modal). Generated Notes day documents are read-only and
 * never reach this prompt — they are managed on Tell Omnesis instead.
 */
export function deleteConfirmCopy({ deleting = false } = {}) {
  return {
    body: DELETE_CHOICE_BODY,
    confirmLabel: deleting ? "Deleting…" : "Delete for good",
    secondaryLabel: "Delete this copy",
  };
}
