// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { browserUrlIdentity, type UrlCanonicalizerSpec } from "@omnesis/core/url-normalize";
import { browserUrl, type FindResult } from "./find-service.js";

/** Preserve unknown routing/account parameters; only provider-declared rewrites may collapse them. */
export function browserIdentity(value: string, canonicalizers: UrlCanonicalizerSpec[]): string {
  const url = new URL(value);
  const spec = canonicalizers.find((spec) => spec.hosts.includes(url.hostname));
  return browserUrlIdentity(value, spec);
}
export function findOpenTab(
  result: FindResult,
  tabs: chrome.tabs.Tab[],
  canonicalizers: UrlCanonicalizerSpec[],
): chrome.tabs.Tab | undefined {
  const identity = browserIdentity(result.url, canonicalizers);
  return tabs.find(
    (tab) =>
      tab.id !== undefined &&
      !tab.incognito &&
      !!browserUrl(tab.url) &&
      browserIdentity(tab.url!, canonicalizers) === identity,
  );
}

/** URLs are compared locally; no tab title, URL or history is sent to Omnesis. */
export async function activateFindResult(
  result: FindResult,
  canonicalizers: UrlCanonicalizerSpec[],
  newCopy = false,
): Promise<void> {
  const url = browserUrl(result.url);
  if (!url) throw new Error("This result cannot open in a browser");
  if (!newCopy) {
    const tab = findOpenTab(result, await chrome.tabs.query({}), canonicalizers);
    if (tab?.id !== undefined) {
      try {
        await chrome.tabs.update(tab.id, { active: true });
      } catch {
        // A tab closed between matching and activation; open the source instead.
        await chrome.tabs.create({ url });
        return;
      }
      if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      return;
    }
  }
  await chrome.tabs.create({ url });
}
