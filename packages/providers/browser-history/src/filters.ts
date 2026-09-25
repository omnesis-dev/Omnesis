// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { canonicalDomain } from "@omnesis/core";
import { INTERNAL_URL_PREFIXES } from "./paths.js";
import type { RawVisit, BrowserHistoryConfig } from "./types.js";

// Chromium transition core types (transition & 0xFF)
const TRANSITION_AUTO_SUBFRAME = 3;
const TRANSITION_MANUAL_SUBFRAME = 4;

// Chromium transition qualifier flags (high bits)
const QUALIFIER_SERVER_REDIRECT = 0x08000000;
const QUALIFIER_CLIENT_REDIRECT = 0x10000000;
const QUALIFIER_CHAIN_END = 0x20000000;

/**
 * Map a Chromium transition bitmask to a human-readable type.
 * Only the low 8 bits determine the core type.
 */
export function mapTransitionType(raw: number): string {
  const core = raw & 0xff;
  switch (core) {
    case 0:
      return "link";
    case 1:
      return "typed";
    case 2:
      return "bookmark";
    case 3:
      return "auto_subframe";
    case 4:
      return "manual_subframe";
    case 5:
      return "generated";
    case 6:
      return "start_page";
    case 7:
      return "form_submit";
    case 8:
      return "reload";
    case 9:
      return "keyword";
    case 10:
      return "keyword_generated";
    default:
      return "other";
  }
}

/**
 * Extract the hostname from a URL. Returns empty string for invalid URLs.
 *
 * Thin pass-through to `core.canonicalDomain` — kept exported because the
 * normalizer falls back to it for the visit-line title when both the
 * original `<title>` and the URL itself are blank.
 */
export function extractDomain(url: string): string {
  return canonicalDomain(url);
}

/**
 * Reason a visit was dropped, or `null` to include. The set of strings is
 * stable and used as keys for the per-reason debug aggregate the source
 * logs once per cycle.
 */
export type VisitDropReason =
  | "internal_url"
  | "hidden"
  | "subframe"
  | "redirect_midchain"
  | "exclude_domain"
  | "exclude_pattern"
  | "exclude_localhost"
  | "exclude_profile";

/**
 * Single source of truth for drop classification — both
 * `shouldIncludeVisit` and the per-reason aggregator funnel through here.
 */
export function visitDropReason(
  visit: RawVisit,
  config?: BrowserHistoryConfig,
): VisitDropReason | null {
  const url = visit.url;

  for (const prefix of INTERNAL_URL_PREFIXES) {
    if (url.startsWith(prefix)) return "internal_url";
  }

  if (visit.hidden) return "hidden";

  if (visit.transitionRaw !== undefined) {
    const core = visit.transitionRaw & 0xff;
    if (core === TRANSITION_AUTO_SUBFRAME || core === TRANSITION_MANUAL_SUBFRAME) {
      return "subframe";
    }
    const hasRedirect =
      (visit.transitionRaw & QUALIFIER_SERVER_REDIRECT) !== 0 ||
      (visit.transitionRaw & QUALIFIER_CLIENT_REDIRECT) !== 0;
    const isChainEnd = (visit.transitionRaw & QUALIFIER_CHAIN_END) !== 0;
    if (hasRedirect && !isChainEnd) return "redirect_midchain";
  }

  if (!config) return null;

  const domain = visit.domain || extractDomain(url);

  if (config.excludeDomains?.length && domain) {
    for (const excluded of config.excludeDomains) {
      if (domain === excluded || domain.endsWith(`.${excluded}`)) return "exclude_domain";
    }
  }

  if (config.excludeUrlPatterns?.length) {
    for (const pattern of config.excludeUrlPatterns) {
      const regex = new RegExp(
        "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
      );
      if (regex.test(url)) return "exclude_pattern";
    }
  }

  if (config.excludeLocalhost) {
    if (
      domain === "localhost" ||
      domain === "127.0.0.1" ||
      domain === "0.0.0.0" ||
      domain === "::1"
    ) {
      return "exclude_localhost";
    }
  }

  if (config.excludeProfiles?.length) {
    if (config.excludeProfiles.includes(visit.profile)) return "exclude_profile";
  }

  return null;
}

/** Determine whether a visit should be included based on filtering rules. */
export function shouldIncludeVisit(visit: RawVisit, config?: BrowserHistoryConfig): boolean {
  return visitDropReason(visit, config) === null;
}
