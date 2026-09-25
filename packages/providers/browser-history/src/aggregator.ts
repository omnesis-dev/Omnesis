// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { extractDomain } from "./filters.js";
import type { RawVisit } from "./types.js";

interface DailyBrowserAggregate extends Record<string, unknown> {
  id: string;
  browser: string;
  profile: string;
  date: string;
  total_visits: number;
  unique_domains: number;
  unique_urls: number;
  total_duration_seconds: number | null;
  top_domain: string;
}

/**
 * Aggregate raw visits into daily per-browser-per-profile summaries.
 * If `dates` is provided, only aggregate visits matching those dates.
 */
export function aggregateDaily(visits: RawVisit[], dates?: Set<string>): DailyBrowserAggregate[] {
  // Group by browser:profile:date
  const groups = new Map<
    string,
    {
      browser: string;
      profile: string;
      date: string;
      urls: Set<string>;
      domains: Map<string, number>;
      totalDuration: number;
      visitCount: number;
    }
  >();

  for (const v of visits) {
    const date = new Date(v.timestamp).toISOString().slice(0, 10);
    if (dates && !dates.has(date)) continue;

    const key = `${v.browser}:${v.profile}:${date}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        browser: v.browser,
        profile: v.profile,
        date,
        urls: new Set(),
        domains: new Map(),
        totalDuration: 0,
        visitCount: 0,
      };
      groups.set(key, group);
    }

    group.visitCount++;
    group.urls.add(v.url);

    const domain = extractDomain(v.url);
    if (domain) {
      group.domains.set(domain, (group.domains.get(domain) ?? 0) + 1);
    }

    if (v.visitDuration && v.visitDuration > 0) {
      group.totalDuration += v.visitDuration;
    }
  }

  const results: DailyBrowserAggregate[] = [];
  for (const [key, group] of groups) {
    // Find top domain by visit count
    let topDomain = "";
    let topCount = 0;
    for (const [domain, count] of group.domains) {
      if (count > topCount) {
        topDomain = domain;
        topCount = count;
      }
    }

    results.push({
      id: key,
      browser: group.browser,
      profile: group.profile,
      date: group.date,
      total_visits: group.visitCount,
      unique_domains: group.domains.size,
      unique_urls: group.urls.size,
      total_duration_seconds: group.totalDuration > 0 ? group.totalDuration : null,
      top_domain: topDomain,
    });
  }

  return results;
}
