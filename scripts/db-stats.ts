#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Shows stats on the Omnesis database: document counts, sync state, recent documents, etc.
 *
 * Usage: npm run db:stats [path-to-db]
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { DEFAULT_CONFIG_DIR } from "@omnesis/core";

const dbPath =
  process.argv[2] ?? join(process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR, "omnesis.db");

if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

// --- Overall counts ---
const total = db.prepare<[], { count: number }>("SELECT COUNT(*) as count FROM documents").get();

console.log("=== Omnesis Database Stats ===\n");
console.log(`Database: ${dbPath}`);
console.log(`Total documents: ${total?.count ?? 0}\n`);

// --- Per provider/source breakdown ---
const breakdown = db
  .prepare<[], { provider_id: string; source_id: string; count: number }>(
    `SELECT provider_id, source_id, COUNT(*) as count
     FROM documents
     GROUP BY provider_id, source_id
     ORDER BY provider_id, source_id`,
  )
  .all();

if (breakdown.length > 0) {
  console.log("--- Documents by Provider / Source ---\n");
  console.log("Provider".padEnd(20) + "Source".padEnd(25) + "Count".padStart(8));
  console.log("-".repeat(53));
  for (const row of breakdown) {
    console.log(
      row.provider_id.padEnd(20) + row.source_id.padEnd(25) + String(row.count).padStart(8),
    );
  }
  console.log();
}

// --- Date range per source ---
const dateRanges = db
  .prepare<
    [],
    {
      source_id: string;
      earliest: string;
      latest: string;
    }
  >(
    `SELECT source_id,
            MIN(source_created_at) as earliest,
            MAX(source_created_at) as latest
     FROM documents
     GROUP BY source_id
     ORDER BY source_id`,
  )
  .all();

if (dateRanges.length > 0) {
  console.log("--- Date Range by Source ---\n");
  console.log("Source".padEnd(25) + "Earliest".padEnd(28) + "Latest".padEnd(28));
  console.log("-".repeat(81));
  for (const row of dateRanges) {
    console.log(
      row.source_id.padEnd(25) +
        (row.earliest ?? "n/a").padEnd(28) +
        (row.latest ?? "n/a").padEnd(28),
    );
  }
  console.log();
}

// --- Sync state ---
const syncStates = db
  .prepare<
    [],
    { source_id: string; cursor: string; last_synced_at: string }
  >("SELECT * FROM sync_state ORDER BY source_id")
  .all();

if (syncStates.length > 0) {
  console.log("--- Sync State ---\n");
  for (const state of syncStates) {
    const cursor = JSON.parse(state.cursor);
    const cursorSummary = Object.entries(cursor)
      .map(([k, v]) => {
        const val = typeof v === "object" ? JSON.stringify(v).slice(0, 60) : String(v);
        return `${k}=${val}`;
      })
      .join(", ");
    console.log(`  ${state.source_id}`);
    console.log(`    Last synced: ${state.last_synced_at}`);
    console.log(`    Cursor: ${cursorSummary}`);
  }
  console.log();
}

// --- 10 most recent documents ---
const recent = db
  .prepare<
    [],
    {
      source_id: string;
      title: string;
      source_created_at: string;
      external_id: string;
    }
  >(
    `SELECT source_id, title, source_created_at, external_id
     FROM documents
     ORDER BY ingested_at DESC
     LIMIT 10`,
  )
  .all();

if (recent.length > 0) {
  console.log("--- 10 Most Recently Ingested ---\n");
  for (const doc of recent) {
    const title = doc.title.length > 60 ? doc.title.slice(0, 57) + "..." : doc.title;
    console.log(`  [${doc.source_id}] ${title}`);
    console.log(`    Created: ${doc.source_created_at}  ID: ${doc.external_id}`);
  }
  console.log();
}

// --- Link graph stats ---
const hasLinksTable = db
  .prepare<
    [],
    { name: string }
  >("SELECT name FROM sqlite_master WHERE type='table' AND name='document_links'")
  .get();

if (hasLinksTable) {
  const totalDocs = total?.count ?? 0;
  const processed = db
    .prepare<
      [],
      { count: number }
    >("SELECT COUNT(*) as count FROM documents WHERE links_extracted_at IS NOT NULL")
    .get();
  const processedCount = processed?.count ?? 0;
  const remaining = totalDocs - processedCount;

  const totalLinks = db
    .prepare<[], { count: number }>("SELECT COUNT(*) as count FROM document_links")
    .get();
  const resolvedLinks = db
    .prepare<
      [],
      { count: number }
    >("SELECT COUNT(*) as count FROM document_links WHERE target_doc_id IS NOT NULL")
    .get();
  const linkCount = totalLinks?.count ?? 0;
  const resolvedCount = resolvedLinks?.count ?? 0;

  const byType = db
    .prepare<[], { link_type: string; total: number; resolved: number }>(
      `SELECT link_type,
              COUNT(*) as total,
              SUM(CASE WHEN target_doc_id IS NOT NULL THEN 1 ELSE 0 END) as resolved
       FROM document_links
       GROUP BY link_type`,
    )
    .all();

  console.log("--- Link Graph ---\n");
  console.log(
    `  Documents processed: ${processedCount} / ${totalDocs}${remaining > 0 ? ` (${remaining} remaining)` : ""}`,
  );
  console.log(`  Total links: ${linkCount}`);
  console.log(`  Resolved: ${resolvedCount}  Unresolved: ${linkCount - resolvedCount}`);
  if (byType.length > 0) {
    console.log();
    console.log("  " + "Type".padEnd(18) + "Total".padStart(8) + "Resolved".padStart(10));
    console.log("  " + "-".repeat(36));
    for (const row of byType) {
      console.log(
        "  " +
          row.link_type.padEnd(18) +
          String(row.total).padStart(8) +
          String(row.resolved).padStart(10),
      );
    }
  }
  console.log();
}

// --- Db file size ---
const { size } = statSync(dbPath);
const sizeMB = (size / 1024 / 1024).toFixed(2);
console.log(`Db size: ${sizeMB} MB`);

db.close();
