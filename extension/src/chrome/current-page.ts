// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { CaptureContentStatus, CaptureExclusionReason } from "./messages.js";

/** What the popup knows about the active tab; `state` is the contract, `label` the wording. */
type CurrentPageState =
  | "unpaired"
  | "check-failed"
  | "unavailable"
  | "access-missing"
  | "ineligible"
  | "watching"
  | "checking"
  | "handoff-delayed"
  | "excluded"
  | "policy-pending"
  | "not-attached";

export interface CurrentPageResult {
  state: CurrentPageState;
  label: string;
  warning?: string;
  /** The active tab's host when it is an HTTPS page, so the popup can offer to exclude it. */
  host?: string;
}

/**
 * What each refusal means to someone looking at the page it happened on. The
 * capture settings are shared, so a page can be excluded by a decision made in
 * another browser; saying which one removes the guesswork. Every reason is
 * required, so a new refusal cannot ship without wording.
 */
const EXCLUSION_LABELS: Record<CaptureExclusionReason, string> = {
  "excluded-domain": "Excluded — this site is on your list",
  "owned-domain": "Covered by another source",
  "skipped-path": "Sign-in or payment page",
  "password-field": "Password field on this page",
  "gateway-host": "This is your Omnesis gateway",
  "removed-page": "Deleted from your index",
  "invalid-url": "Not eligible",
  paused: "Capture paused",
  "no-policy": "Waiting for capture settings",
  unpaired: "Not paired",
};

/**
 * The wording for a reason the content script reported. The reply crosses a
 * process boundary and is not validated, so an unrecognized reason falls back
 * to the general wording rather than rendering as nothing.
 */
function exclusionLabel(reason: unknown): string {
  return typeof reason === "string" && reason in EXCLUSION_LABELS
    ? EXCLUSION_LABELS[reason as CaptureExclusionReason]
    : "Excluded by capture settings";
}

export interface CurrentPageDeps {
  queryActiveTab: () => Promise<{ id?: number; url?: string } | undefined>;
  readCaptureStatus: (tabId: number) => Promise<CaptureContentStatus>;
}

export interface CurrentPagePresentation {
  warning: string;
  activeFailure: boolean;
}

/** An active-tab attachment failure outranks a historical loss notice. */
export function currentPagePresentation(
  result: CurrentPageResult,
  existingWarning: string,
  existingActiveFailure = false,
): CurrentPagePresentation {
  return result.warning && !existingActiveFailure
    ? { warning: result.warning, activeFailure: true }
    : { warning: existingWarning, activeFailure: existingActiveFailure };
}

/** Inspect the active tab without exposing page content to the popup. */
export async function inspectCurrentPage(
  paired: boolean,
  hostPermissionOk: boolean,
  deps: CurrentPageDeps,
): Promise<CurrentPageResult> {
  if (!paired) return { state: "unpaired", label: "—" };
  // Without the HTTPS grant Chrome withholds every tab's URL, so no page can be
  // judged eligible; the popup's permission warning names the fix.
  if (!hostPermissionOk) return { state: "access-missing", label: "Access not granted" };
  let tab: { id?: number; url?: string } | undefined;
  try {
    tab = await deps.queryActiveTab();
  } catch {
    return { state: "check-failed", label: "Check failed" };
  }
  if (tab?.id === undefined) return { state: "unavailable", label: "Unavailable" };
  // Chrome only reveals a tab's URL when the extension holds host permission
  // for it. The extension has HTTPS access, so a tab with no URL is one it
  // cannot capture — a new-tab page, a chrome:// page, a plain-HTTP site, one
  // of its own pages — and asking it for capture status would only produce a
  // false "reload this page" warning.
  if (!tab.url || !tab.url.startsWith("https://")) {
    return { state: "ineligible", label: "Not eligible" };
  }
  let host: string;
  try {
    host = new URL(tab.url).hostname;
  } catch {
    return { state: "ineligible", label: "Not eligible" };
  }
  try {
    const response = await deps.readCaptureStatus(tab.id);
    switch (response?.state) {
      case "watching":
        return { state: "watching", label: "Attached (5s dwell)", host };
      case "checking":
        return { state: "checking", label: "Checking eligibility", host };
      case "handoff-delayed":
        return { state: "handoff-delayed", label: "Handoff delayed — retrying", host };
      case "policy-pending":
        return { state: "policy-pending", label: EXCLUSION_LABELS["no-policy"], host };
      default:
        return { state: "excluded", label: exclusionLabel(response?.reason), host };
    }
  } catch {
    return {
      state: "not-attached",
      label: "Not watched — reload page",
      warning: "Omnesis is not watching this already-open page. Reload the page to attach capture.",
      host,
    };
  }
}
