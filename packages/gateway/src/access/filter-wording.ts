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
  "“Can read” under Answer means Omnesis may use this document when answering that agent. Whether an answer is then released is decided by the privacy policy’s review.";

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
        ? `Included by: ${reason.via.noun} ${reason.via.label}`
        : reason.filtered
          ? "Not hidden by this level’s filter"
          : "This account is shared with all content";
    case "hidden-by-item":
      return reason.item
        ? `Hidden by: ${reason.item.noun} ${reason.item.label}`
        : "Hidden by this level’s filter";
    case "not-included":
      return "Not included by this level’s share-only filter";
    case "record-too-old":
      return "This record is too old for this filter and has not been resynced";
    case "detail-unknown":
      switch (reason.cause) {
        case "filter-unusable":
          return "This level’s filter cannot be applied by this version of Omnesis";
        case "not-listed":
          return reason.noun
            ? `Its ${reason.noun.one} is not in this account’s list of ${reason.noun.many}`
            : "Where it belongs is not in this account’s list";
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
    ? `1 record can’t be matched to ${withArticle(noun.one)} and stays hidden.`
    : `${count(records)} records can’t be matched to ${withArticle(noun.one)} and stay hidden.`;
}

/** Why an account’s filter can only be read, not changed. */
export const DISCONNECTED_ACCOUNT_TEXT =
  "This account is no longer connected. Its saved filter entries are kept until you remove them.";

/** "Studio Mac", "Studio Mac and Travel Laptop", "A, B and C". */
function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The sentence a filter editor shows for a field that cannot be used yet. */
export function filterFieldStateText(
  state:
    | { status: "needs-resync"; cost: string | null }
    | { status: "resyncing"; processed: number; total: number }
    | { status: "collector-behind"; devices: ReadonlyArray<{ name: string }> }
    | { status: "gateway-behind" }
    | { status: "list-pending" },
  context: { sourceName: string; noun: FilterNoun },
): string {
  const kind = `${capitalized(context.noun.one)} filters`;
  switch (state.status) {
    case "needs-resync":
      return needsResyncText(kind, context.sourceName, state.cost);
    case "resyncing":
      return `Resyncing ${context.sourceName}: ${count(state.processed)} of about ${count(state.total)}.`;
    case "collector-behind":
      return `Update Omnesis on ${nameList(state.devices.map((device) => device.name))} to use these filters.`;
    case "gateway-behind":
      return "Update this Omnesis gateway to use these filters.";
    case "list-pending":
      return `Waiting for ${context.sourceName} to send its list of ${context.noun.many}.`;
  }
}

/** "Label filters need Gmail to be resynced. Search keeps working meanwhile. This reads …" */
function needsResyncText(
  kind: string,
  sourceName: string,
  cost: string | null,
  contentNoun?: string,
): string {
  return [
    `${kind} need ${sourceName} to be resynced.`,
    contentNoun
      ? `Your ${contentNoun} stay searchable meanwhile.`
      : "Search keeps working meanwhile.",
    ...(cost ? [cost] : []),
  ].join(" ");
}

/**
 * The one sentence the editor shows for every field of an account that waits
 * on a resync: the fields named in the order given (people last), then what
 * stays available and what the resync costs. `contentNoun` is the source's
 * own word for what it holds ("emails"); without it the sentence stays
 * generic.
 */
export function accountResyncText(
  input:
    | {
        status: "needs-resync";
        sourceName: string;
        fields: ReadonlyArray<{ noun: FilterNoun; person: boolean }>;
        cost: string | null;
        contentNoun?: string;
      }
    | { status: "resyncing"; sourceName: string; processed: number; total: number },
): string {
  if (input.status === "resyncing")
    return `Resyncing ${input.sourceName}: ${count(input.processed)} of about ${count(input.total)}.`;
  const names = input.fields.map((field) => (field.person ? field.noun.many : field.noun.one));
  return needsResyncText(
    `${capitalized(nameList(names))} filters`,
    input.sourceName,
    input.cost,
    input.contentNoun,
  );
}

/** Why an account offers no filter at all, or `null` when it does. */
export function filterProfileText(
  profile: "declared" | "no-profile" | "collector-behind",
  devices: ReadonlyArray<{ name: string }>,
): string | null {
  switch (profile) {
    case "declared":
      return null;
    case "no-profile":
      return "Filters for this account are available after its first sync.";
    case "collector-behind":
      return devices.length
        ? `Update Omnesis on ${nameList(devices.map((device) => device.name))} to use filters on this account.`
        : "Update the Omnesis app that syncs this account to use filters on it.";
  }
}

/** "Includes the folders inside." */
export function filterInsideText(inside: FilterNoun): string {
  return `Includes the ${inside.many} inside.`;
}

/** What a document's own record says about one filterable field, when it is not simply present. */
export function documentFilterStateText(
  state: "present" | "too-old" | "unknown",
  noun: FilterNoun,
): string {
  switch (state) {
    case "present":
      return "";
    case "too-old":
      return `Written before this source recorded its ${noun.many}. Resync the source to add them.`;
    case "unknown":
      return "Not recorded";
  }
}
