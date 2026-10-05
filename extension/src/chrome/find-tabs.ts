// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { browserIdentity, browserUrl, type FindResult } from "./find-results.js";
import type { UrlCanonicalizerSpec } from "@omnesis/core/url-normalize";
export { browserIdentity } from "./find-results.js";

export function findOpenTab(
  result: Pick<FindResult, "url">,
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
