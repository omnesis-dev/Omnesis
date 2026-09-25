// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Synthetic browser history. Deterministic visits generated from a fixed
 * domain catalog + 14-day window. URLs overlap with the chrome-bookmarks
 * fixture so the cross-source search story stays coherent.
 */
import {
  sha256Hex,
  loadActiveUniverse,
  loadSourceFixtureJson,
} from "@omnesis/providers-synth-common";

interface DomainSpec {
  domain: string;
  /** Average visits/day. */
  weight: number;
  transition: "link" | "typed" | "bookmark" | "reload";
}

interface PageSpec {
  path: string;
  title: string;
  searchTerm?: string;
}

interface Fixture {
  browser: string;
  profile: string;
  domains: DomainSpec[];
  pages: Record<string, PageSpec[]>;
  days: string[];
}

let cached: Fixture | null = null;
function loadFixture(): Fixture {
  if (cached) return cached;
  cached = loadSourceFixtureJson<Fixture>(loadActiveUniverse(), "browser-history", "visits.json");
  return cached;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export interface VisitRow {
  id: string;
  browser: string;
  profile: string;
  timestamp: string;
  url: string;
  domain: string;
  title: string;
  visit_duration_seconds: number | null;
  transition_type: string | null;
  is_synced: boolean;
}

export interface DailyRow {
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

export interface SearchTermRow {
  id: string;
  browser: string;
  profile: string;
  timestamp: string;
  term: string;
  normalized_term: string;
  search_engine_domain: string;
}

let cachedVisits: VisitRow[] | null = null;
let cachedDaily: DailyRow[] | null = null;
let cachedSearches: SearchTermRow[] | null = null;

function generate(): {
  visits: VisitRow[];
  daily: DailyRow[];
  searches: SearchTermRow[];
} {
  const f = loadFixture();
  const visits: VisitRow[] = [];
  const searches: SearchTermRow[] = [];

  for (const day of f.days) {
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    const isWeekend = dow === 0 || dow === 6;
    for (const dom of f.domains) {
      const seed = hash(`${dom.domain}:${day}`);
      const target = Math.max(
        0,
        Math.round(dom.weight * (isWeekend ? 0.4 : 1.0) * (0.6 + seed * 0.8)),
      );
      const pages = f.pages[dom.domain] ?? [{ path: "/", title: dom.domain }];
      for (let i = 0; i < target; i++) {
        const j = hash(`${dom.domain}:${day}:${i}`);
        const page = pages[Math.floor(j * pages.length) % pages.length];
        // Spread visits between 07:00 and 23:00.
        const startSec = 7 * 3600 + Math.floor(j * 16 * 3600);
        const hour = Math.floor(startSec / 3600);
        const min = Math.floor((startSec % 3600) / 60);
        const timestamp = `${day}T${pad2(hour)}:${pad2(min)}:00.000Z`;
        const url = `https://${dom.domain}${page.path}`;
        const id = sha256Hex(`${f.browser}:${f.profile}:${timestamp}:${url}`).slice(0, 32);
        visits.push({
          id,
          browser: f.browser,
          profile: f.profile,
          timestamp,
          url,
          domain: dom.domain,
          title: page.title,
          visit_duration_seconds: Math.round(30 + j * 240),
          transition_type: dom.transition,
          is_synced: false,
        });
        if (page.searchTerm) {
          searches.push({
            id: sha256Hex(`${f.browser}:${f.profile}:${url}:${i}`).slice(0, 32),
            browser: f.browser,
            profile: f.profile,
            timestamp,
            term: page.searchTerm,
            normalized_term: page.searchTerm.toLowerCase(),
            search_engine_domain: dom.domain,
          });
        }
      }
    }
  }

  // Daily aggregates per browser/profile/date.
  const byDay = new Map<string, VisitRow[]>();
  for (const v of visits) {
    const date = v.timestamp.slice(0, 10);
    const key = `${v.browser}:${v.profile}:${date}`;
    const arr = byDay.get(key) ?? [];
    arr.push(v);
    byDay.set(key, arr);
  }
  const daily: DailyRow[] = [];
  for (const [key, rows] of byDay) {
    const [browser, profile, date] = key.split(":") as [string, string, string];
    const domains = new Set(rows.map((r) => r.domain));
    const urls = new Set(rows.map((r) => r.url));
    const topDomain = [...domains].sort(
      (a, b) =>
        rows.filter((r) => r.domain === b).length - rows.filter((r) => r.domain === a).length,
    )[0];
    daily.push({
      id: `${browser}:${profile}:${date}`,
      browser,
      profile,
      date,
      total_visits: rows.length,
      unique_domains: domains.size,
      unique_urls: urls.size,
      total_duration_seconds: rows.reduce((s, r) => s + (r.visit_duration_seconds ?? 0), 0),
      top_domain: topDomain ?? "",
    });
  }
  daily.sort((a, b) => a.date.localeCompare(b.date));
  return { visits, daily, searches };
}

function ensure(): void {
  if (cachedVisits === null) {
    const out = generate();
    cachedVisits = out.visits;
    cachedDaily = out.daily;
    cachedSearches = out.searches;
  }
}

export function allVisits(): VisitRow[] {
  ensure();
  return cachedVisits!;
}
export function allDaily(): DailyRow[] {
  ensure();
  return cachedDaily!;
}
export function allSearches(): SearchTermRow[] {
  ensure();
  return cachedSearches!;
}

export function browserSlug(): string {
  return loadFixture().browser;
}

export function profileName(): string {
  return loadFixture().profile;
}

export function fixtureDays(): string[] {
  return loadFixture().days;
}
