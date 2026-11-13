// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The one place a filter decision becomes a sentence.
 *
 * The gateway writes these sentences and the portal, iOS and Android show
 * them as received, so the three never word a decision differently. Nouns
 * come from the source's own declaration ("label", "project folder"); no
 * source is named here.
 */

import type { FilterNoun } from "@omnesis/types";
import type { AccessReason } from "./filter-decision.js";

/** Which of a level's two permissions a decision is about. */
export type AccessCapability = "answer" | "direct";

const CAPABILITY_NAMES: Record<AccessCapability, string> = { answer: "Answer", direct: "Direct" };

/** The noun a person filter uses where a field would use its own. */
export const PERSON_NOUN: FilterNoun = { one: "person", many: "people" };

/** Shown on the page that says who can read a document, under the Answer verdicts. */
export const ACCESS_AUDIT_ANSWER_NOTE =
  'For Answer, "readable" means the document is within what Omnesis may use when answering that agent. Whether a given answer is then released is decided separately, by the privacy policy\'s review.';

/** Shown on the page that says who can read a document. */
export const ACCESS_AUDIT_OWNER_NOTE =
  "This page is for you, the owner. It is never available to an external agent.";

/** "a folder", "an owner". */
function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

function count(value: number): string {
  return Math.max(0, Math.trunc(value)).toLocaleString("en-US");
}

/** The sentence for one decision about one document. */
export function accessReasonText(reason: AccessReason, capability: AccessCapability): string {
  switch (reason.code) {
    case "document-not-found":
      return "This document no longer exists";
    case "permission-not-granted":
      return `${CAPABILITY_NAMES[capability]} is not granted on this level`;
    case "account-not-shared":
      return "This account is not shared";
    case "readable":
      return reason.via
        ? `Readable: ${reason.via.noun} ${reason.via.label} lets it through`
        : "Readable";
    case "hidden-by-item":
      return reason.item
        ? `Hidden by: ${reason.item.noun} ${reason.item.label}`
        : "Hidden by this level's filter";
    case "not-included":
      return "Not included by this level's share-only filter";
    case "record-too-old":
      return "This record is too old for this filter and has not been resynced";
    case "detail-unknown":
      switch (reason.cause) {
        case "filter-unusable":
          return "This level's filter cannot be applied by this version of Omnesis";
        case "not-listed":
          return reason.noun
            ? `Its ${reason.noun.one} is not in this account's list of ${reason.noun.many}`
            : "Where it belongs is not in this account's list";
        case "person-unreadable":
          return "Someone it involves cannot be identified";
        case "device-unknown":
          return "The device it came from is unknown";
        case "parent-missing":
          return "The record it was attached to is missing";
        case "absent":
          return reason.person
            ? "The people it involves are unknown"
            : reason.noun
              ? `Its ${reason.noun.one} is unknown`
              : "Its details are unknown";
      }
  }
}

/** How many records are too old for a filter, as the filter review says it. */
export function tooOldCountText(records: number): string {
  return records === 1
    ? "1 older item could not be resynced and stays hidden from agents using this filter."
    : `${count(records)} older items could not be resynced and stay hidden from agents using this filter.`;
}

/** How many records cannot be placed for a field, as the filter review says it. */
export function unmatchedCountText(records: number, noun: FilterNoun): string {
  return records === 1
    ? `1 record can't be matched to ${withArticle(noun.one)} and stays hidden.`
    : `${count(records)} records can't be matched to ${withArticle(noun.one)} and stay hidden.`;
}
