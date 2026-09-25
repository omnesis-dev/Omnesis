// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Which document types enter the near-duplicate pipeline. Enforced at
 * two points: the writer-side enqueue (`enqueueInbox`) and the
 * compute-side drain (`fetchNearDupInbox` + `signDocBatch`).
 * Misconfiguring one place doesn't leak — the other catches it.
 *
 * Webpages are deliberately excluded (see the study report): they dedupe
 * upstream by canonical URL, and the remaining
 * content noise (navigation chrome, cookie banners, shared footers)
 * is uncalibrated under the production gate. v2 work to land a
 * dedicated config + algo_version for webpages.
 */

/**
 * Which document types make the corpus-wide weighting worth rebuilding
 * when one arrives. A subset of the eligible types above: everything
 * eligible takes part in detection, but files are what near-duplicate
 * detection is really for — they get re-uploaded, re-attached and synced
 * between sources — so their arrival is what the rebuild cadence tracks.
 * Mail and messages still take part; they just do not trigger.
 */
export const DEFAULT_FILE_LIKE_DOC_TYPES: readonly string[] = ["attachment", "file", "document"];

export const DEFAULT_ELIGIBLE_DOC_TYPES: readonly string[] = [
  "email",
  "attachment",
  "file",
  "document",
  "note",
  "conversation",
];

export function isEligibleForNearDup(
  docType: string | null | undefined,
  eligibleTypes: ReadonlySet<string>,
): boolean {
  if (docType == null) return false;
  return eligibleTypes.has(docType);
}
