// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { hashText } from "../capture/content-hash.js";
import type { DocumentInput } from "@omnesis/types";
import type { PageVisit } from "./types.js";

/**
 * Factories that turn capture inputs into the exact wire shapes the gateway
 * expects. These are the seam between the capture engine (which produces a
 * normalized URL, extracted text, and dwell) and the push client: the
 * capture engine calls `buildWebPageDocument` / `buildPageVisit` and hands the
 * result to `enqueueDocument` / `enqueueVisit`.
 *
 * Kept in the shared push module (not the chrome glue) so the same builders
 * back the headline E2E and the extension.
 */

/**
 * The provider + source id every web-page document is written under.
 *
 * The browser extension is the producer for the `web` source.
 *
 * It pushes with a `write:web` token (minted for the `browser` device kind);
 * the device kind stays `browser` (the physical client), but the source it
 * contributes to is `web`.
 */
export const WEB_PROVIDER_ID = "web";
export const WEB_SOURCE_ID = "web";

/**
 * Minimal, browser-bundle-safe mirror of `@omnesis/source-sdk`'s
 * `AnalyticsTableSchema` (only the fields the gateway's `/analytics/ingest`
 * reads on first ingest — table name, columns, primary key, and the
 * record-citation contract it validates). The real type lives in
 * `@omnesis/source-sdk`, which pulls Node-only deps and cannot bundle into a
 * browser content script under esbuild `platform: "browser"`.
 *
 * The `page_visits` schema is owned by the `web` source (its descriptor in
 * `@omnesis/provider-web` declares it); the analytics catalog
 * re-homes the schema owner on boot from the descriptor registry, so an ingest
 * carrying this schema under source `web` attributes the table to `web`.
 */
interface AnalyticsColumnLiteral {
  name: string;
  type: string;
  description: string;
  nullable?: boolean;
  references?: string;
}
export interface AnalyticsSchemaLiteral {
  tableName: string;
  displayName: string;
  description: string;
  columns: AnalyticsColumnLiteral[];
  primaryKey: string[];
  semanticTimeColumn: string | null;
  record: { titleColumns: string[]; keyColumns: string[]; titleTemplate?: string };
  exampleQueries?: string[];
}

/**
 * The `page_visits` analytics schema, sent with each `POST /analytics/ingest`
 * so the gateway can create the DuckDB table on first ingest (it auto-creates
 * a table only when an ingest carries its schema). It is a deliberate,
 * parity-tested mirror of the `pageVisitsSchema` exported by
 * `@omnesis/provider-web` (which the gateway registers and the harness
 * catalog renders); the two are kept byte-equal by the spawned-gateway E2E,
 * not by import — the same browser-bundle constraint, and the same approach,
 * as the URL-normalization and content-hash mirrors. Android's
 * Health Connect client carries its `Schemas.kt` the same way.
 */
export const PAGE_VISITS_SCHEMA: AnalyticsSchemaLiteral = {
  tableName: "page_visits",
  displayName: "Page Visits",
  description: "Web pages viewed in the browser, captured on focused dwell",
  columns: [
    {
      name: "url",
      type: "VARCHAR",
      description: "Normalized page URL (fragment dropped, tracking params stripped)",
      references: "url",
    },
    { name: "domain", type: "VARCHAR", description: "Host of the page (e.g. example.com)" },
    { name: "title", type: "VARCHAR", description: "Page title at capture time", nullable: true },
    { name: "visited_at", type: "TIMESTAMPTZ", description: "When the dwell was confirmed" },
    {
      name: "dwell_ms",
      type: "INTEGER",
      description: "Focused dwell time on the page, in milliseconds",
    },
    {
      name: "browser_device_id",
      type: "VARCHAR",
      description: "Paired-device ID reported by the extension for Chrome profile attribution",
      nullable: true,
    },
    {
      name: "browser_profile_label",
      type: "VARCHAR",
      description: "User-entered Chrome profile name at capture time",
      nullable: true,
    },
  ],
  primaryKey: ["url", "visited_at"],
  semanticTimeColumn: "visited_at",
  record: {
    titleColumns: ["title", "url"],
    keyColumns: ["url", "visited_at"],
  },
  exampleQueries: [
    "SELECT domain, COUNT(*) AS visits FROM page_visits WHERE visited_at >= CURRENT_DATE - INTERVAL '7 days' GROUP BY domain ORDER BY visits DESC LIMIT 10",
    "SELECT domain, SUM(dwell_ms)/60000.0 AS minutes FROM page_visits GROUP BY domain ORDER BY minutes DESC LIMIT 10",
    "SELECT url, title, browser_profile_label, visited_at, dwell_ms FROM page_visits ORDER BY visited_at DESC LIMIT 25",
  ],
};

interface BrowserProfileAttribution {
  /** Stable paired-device provenance hint; authorization still comes from the bearer token. */
  deviceId: string;
  /** User-entered Chrome profile name, used only as a human-readable label. */
  label: string | null;
}

export interface WebPageCapture {
  /** Normalized URL used to derive the hashed content-plane `externalId`. */
  normalizedUrl: string;
  /** Page title at capture time. */
  title: string;
  /** Client-side-extracted readable text (never raw HTML). */
  text: string;
  /** SHA-256 hex of `text` — re-push only when this changes. */
  contentHash: string;
  /** When the page was first observed this visit (ISO-8601). */
  visitedAt: string;
  browserProfile?: BrowserProfileAttribution;
}

/**
 * Build a `webpage` content document for the `web` source.
 *
 * `externalId = SHA256(normalizedUrl)` gives each canonical page URL a stable
 * identity. The extension hashes with Web Crypto (`hashText`).
 * Async because `crypto.subtle.digest` is async (it runs in the service worker,
 * where Web Crypto is available).
 *
 * `documentType: "webpage"` identifies the content type. `sourceUrl` is the
 * page itself so "Open in source" navigates back to it.
 */
export async function buildWebPageDocument(capture: WebPageCapture): Promise<DocumentInput> {
  const host = safeHost(capture.normalizedUrl);
  const externalId = await hashText(capture.normalizedUrl);
  return {
    providerId: WEB_PROVIDER_ID as DocumentInput["providerId"],
    sourceId: WEB_SOURCE_ID as DocumentInput["sourceId"],
    externalId,
    title: capture.title || capture.normalizedUrl,
    content: capture.text,
    contentHash: capture.contentHash,
    metadata: {
      documentType: "webpage",
      sourceUrl: capture.normalizedUrl,
      ...(host ? { tags: [host] } : {}),
      ...(capture.browserProfile
        ? {
            extra: {
              browserDeviceId: capture.browserProfile.deviceId,
              browserProfileLabel: capture.browserProfile.label,
            },
          }
        : {}),
    },
    sourceCreatedAt: capture.visitedAt,
    sourceUpdatedAt: capture.visitedAt,
  };
}

export interface PageVisitCapture {
  normalizedUrl: string;
  title: string;
  visitedAt: string;
  dwellMs: number;
  browserProfile?: BrowserProfileAttribution;
}

/** Build a single `page_visits` analytics row (PK `(url, visited_at)`). */
export function buildPageVisit(capture: PageVisitCapture): PageVisit {
  return {
    url: capture.normalizedUrl,
    domain: safeHost(capture.normalizedUrl) ?? "",
    title: capture.title || null,
    visited_at: capture.visitedAt,
    dwell_ms: Math.max(0, Math.round(capture.dwellMs)),
    ...(capture.browserProfile
      ? {
          browser_device_id: capture.browserProfile.deviceId,
          browser_profile_label: capture.browserProfile.label,
        }
      : {}),
  };
}

/** Best-effort host extraction; empty string if the URL won't parse. */
function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
