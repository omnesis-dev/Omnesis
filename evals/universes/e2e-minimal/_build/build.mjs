#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Generates the `e2e-minimal` universe by shrinking the `default` universe's
 * fixtures to the smallest size that still exercises every code path E2E
 * tests care about (discovery, paginated sync, cursor advancement,
 * `presentExternalIds` reconcile, structured-data ingest, search snapshot
 * refresh). Total document count drops from ~199 to ~50, sync time per
 * source from ~1.5s to ~0.4s.
 *
 * Re-run:
 *   ./evals/universes/e2e-minimal/_build/build.mjs
 *   (or `node ./evals/universes/e2e-minimal/_build/build.mjs` via tsx)
 *
 * What the generator does:
 *
 * - Unstructured array fixtures (gmail, calendars, drive, contacts,
 *   notes, reminders, imessage, outlook, obsidian, things, chrome,
 *   notion-pages, whatsapp): take the first N entries (default 3).
 *   With BATCH_SIZE=5 in the sync helper, N=3 still tests the
 *   single-page case AND the final-page `presentExternalIds` snapshot.
 *
 * - notion-databases: keep the first database with the first 3 of its
 *   rows, so the schema + summary doc + row docs all materialize.
 *
 * - strava-activities: keep the first 3 activities + only their
 *   matching zone rows (zones reference activity ids by foreign key).
 *
 * - apple-health: shrink each metric's value array to 3 days,
 *   keep first 2 sleep nights / mindful sessions / workouts.
 *
 * - browser-history, screen-time: shrink the `days` list to 3.
 *
 * Determinism: every operation is `slice(0, N)` over a sorted JSON file,
 * so re-running the build always produces the same output.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_UNIVERSE = join(HERE, "..", "..", "default");
const DST_UNIVERSE = join(HERE, "..");

const UNSTRUCTURED_KEEP = 3;
const STRUCTURED_KEEP_DAYS = 3;
const STRUCTURED_KEEP_ACTIVITIES = 3;
const STRUCTURED_KEEP_NIGHTS_OR_SESSIONS = 2;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function srcPath(sourceKey, file) {
  return join(SRC_UNIVERSE, "sources", sourceKey, file);
}

function dstPath(sourceKey, file) {
  return join(DST_UNIVERSE, "sources", sourceKey, file);
}

// ── Unstructured array-of-entries fixtures ────────────────────────────

const UNSTRUCTURED_FIXTURES = [
  ["gmail", "messages.json"],
  ["google-calendar", "events.json"],
  ["google-drive", "files.json"],
  ["google-contacts", "contacts.json"],
  ["outlook-email", "emails.json"],
  ["outlook-calendar", "events.json"],
  ["onedrive", "items.json"],
  ["apple-notes", "notes.json"],
  ["apple-reminders", "reminders.json"],
  ["apple-imessage", "messages.json"],
  ["apple-contacts", "contacts.json"],
  ["apple-calendar", "events.json"],
  ["apple-call-log", "calls.json"],
  ["apple-voicemail", "voicemails.json"],
  ["core-location-visits", "visits.json"],
  ["android-call-log", "calls.json"],
  ["notion-pages", "pages.json"],
  ["chrome-bookmarks", "bookmarks.json"],
  ["obsidian-notes", "notes.json"],
  ["things", "tasks.json"],
  ["whatsapp-messages", "messages.json"],
];

for (const [sourceKey, file] of UNSTRUCTURED_FIXTURES) {
  const all = readJson(srcPath(sourceKey, file));
  if (!Array.isArray(all)) {
    throw new Error(`${sourceKey}/${file} is not a JSON array — expected unstructured shape`);
  }
  const slimmed = all.slice(0, UNSTRUCTURED_KEEP);
  writeJson(dstPath(sourceKey, file), slimmed);
  console.log(`  ${sourceKey}/${file}: ${all.length} → ${slimmed.length}`);
}

// ── notion-databases: nested rows, keep first DB + first 3 rows ───────

{
  const dbs = readJson(srcPath("notion-databases", "databases.json"));
  if (!Array.isArray(dbs) || dbs.length === 0) {
    throw new Error("notion-databases/databases.json should be a non-empty array");
  }
  const first = { ...dbs[0], rows: (dbs[0].rows ?? []).slice(0, UNSTRUCTURED_KEEP) };
  const slimmed = [first];
  writeJson(dstPath("notion-databases", "databases.json"), slimmed);
  console.log(
    `  notion-databases/databases.json: ${dbs.length} dbs → 1, rows ${dbs[0].rows?.length ?? 0} → ${first.rows.length}`,
  );
}

// ── strava-activities: zones reference activity ids ───────────────────

{
  const activities = readJson(srcPath("strava-activities", "activities.json"));
  const zones = readJson(srcPath("strava-activities", "zones.json"));
  if (!Array.isArray(activities) || !Array.isArray(zones)) {
    throw new Error("strava fixtures should be arrays");
  }
  // Zones only exist for a subset of activities in the default fixture
  // (HR-rich ones at the end). To exercise both the with-zones and
  // without-zones paths in E2E, keep 1 activity from the start (no
  // zones) + the activities-with-zones (so the zones path materializes).
  const activitiesWithZones = new Set(zones.map((z) => z.activityId));
  const withoutZones = activities.find((a) => !activitiesWithZones.has(a.id));
  const withZones = activities
    .filter((a) => activitiesWithZones.has(a.id))
    .slice(0, STRUCTURED_KEEP_ACTIVITIES - 1);
  const keptActivities = withoutZones ? [withoutZones, ...withZones] : withZones;
  const keptIds = new Set(keptActivities.map((a) => a.id));
  const keptZones = zones.filter((z) => keptIds.has(z.activityId));
  writeJson(dstPath("strava-activities", "activities.json"), keptActivities);
  writeJson(dstPath("strava-activities", "zones.json"), keptZones);
  console.log(
    `  strava-activities/activities.json: ${activities.length} → ${keptActivities.length} (${keptIds.size} kept, ${keptZones.length > 0 ? "with+without" : "all-bare"} zones)`,
  );
  console.log(`  strava-activities/zones.json: ${zones.length} → ${keptZones.length}`);
}

// ── apple-health: shrink each metric's value array + sleep/mindful/workouts ──

{
  const h = readJson(srcPath("apple-health", "health.json"));
  const shrinkSpec = (spec) => ({ ...spec, values: spec.values.slice(0, STRUCTURED_KEEP_DAYS) });
  const slimmed = {
    ...h,
    body: h.body.map(shrinkSpec),
    activity: h.activity.map(shrinkSpec),
    vitals: h.vitals.map(shrinkSpec),
    nutrition: h.nutrition.map(shrinkSpec),
    environment: h.environment.map(shrinkSpec),
    sleep: h.sleep.slice(0, STRUCTURED_KEEP_NIGHTS_OR_SESSIONS),
    mindful: h.mindful.slice(0, STRUCTURED_KEEP_NIGHTS_OR_SESSIONS),
    workouts: h.workouts.slice(0, STRUCTURED_KEEP_NIGHTS_OR_SESSIONS),
  };
  writeJson(dstPath("apple-health", "health.json"), slimmed);
  console.log(
    `  apple-health/health.json: ${h.body[0]?.values.length}d → ${STRUCTURED_KEEP_DAYS}d, sleep ${h.sleep.length} → ${slimmed.sleep.length}, workouts ${h.workouts.length} → ${slimmed.workouts.length}`,
  );
}

// ── enable-banking-accounts: per-account balance/transaction groups ────
//
// Keep the first account plus only its balance group and its first 3
// transactions, so account ↔ balances ↔ transactions referential
// integrity survives the shrink (the synth twin throws on transactions
// referencing an unknown account_key).

{
  const accounts = readJson(srcPath("enable-banking-accounts", "accounts.json"));
  const balances = readJson(srcPath("enable-banking-accounts", "balances.json"));
  const txns = readJson(srcPath("enable-banking-accounts", "transactions.json"));
  if (!Array.isArray(accounts) || !Array.isArray(balances) || !Array.isArray(txns)) {
    throw new Error("enable-banking-accounts fixtures should be arrays");
  }
  const keptAccounts = accounts.slice(0, 1);
  const keptKeys = new Set(keptAccounts.map((a) => a.account_key));
  const keptBalances = balances.filter((g) => keptKeys.has(g.account_key));
  const keptTxns = txns
    .filter((g) => keptKeys.has(g.account_key))
    .map((g) => ({ ...g, transactions: g.transactions.slice(0, UNSTRUCTURED_KEEP) }));
  writeJson(dstPath("enable-banking-accounts", "accounts.json"), keptAccounts);
  writeJson(dstPath("enable-banking-accounts", "balances.json"), keptBalances);
  writeJson(dstPath("enable-banking-accounts", "transactions.json"), keptTxns);
  const txnCount = keptTxns.reduce((n, g) => n + g.transactions.length, 0);
  console.log(
    `  enable-banking-accounts: ${accounts.length} accounts → ${keptAccounts.length}, transactions → ${txnCount}`,
  );
}

// ── lunchflow-accounts: per-account balance/transaction groups ────────
//
// Keep the first TWO accounts — Lunch Flow's headline is multi-account
// fanout from one API key, so the minimal universe must still exercise more
// than one account — plus their balances and first 2 transactions each, so
// account ↔ balances ↔ transactions referential integrity survives the
// shrink (the synth twin throws on transactions referencing an unknown
// account). The first account's first transaction is a debit with a
// merchant; one of account two's kept transactions has a null id, so the
// content-hash key fallback stays covered.

{
  const accounts = readJson(srcPath("lunchflow-accounts", "accounts.json"));
  const balances = readJson(srcPath("lunchflow-accounts", "balances.json"));
  const txns = readJson(srcPath("lunchflow-accounts", "transactions.json"));
  if (!Array.isArray(accounts) || !Array.isArray(balances) || !Array.isArray(txns)) {
    throw new Error("lunchflow-accounts fixtures should be arrays");
  }
  const keptAccounts = accounts.slice(0, 2);
  const keptIds = new Set(keptAccounts.map((a) => String(a.id)));
  const keptBalances = balances.filter((g) => keptIds.has(String(g.account_id)));
  const keptTxns = txns
    .filter((g) => keptIds.has(String(g.account_id)))
    .map((g) => ({ ...g, transactions: g.transactions.slice(0, 2) }));
  writeJson(dstPath("lunchflow-accounts", "accounts.json"), keptAccounts);
  writeJson(dstPath("lunchflow-accounts", "balances.json"), keptBalances);
  writeJson(dstPath("lunchflow-accounts", "transactions.json"), keptTxns);
  const txnCount = keptTxns.reduce((n, g) => n + g.transactions.length, 0);
  console.log(
    `  lunchflow-accounts: ${accounts.length} accounts → ${keptAccounts.length}, transactions → ${txnCount}`,
  );
}

// ── coinbase: a single-portfolio canned-response corpus ───────────────
//
// The Coinbase synth twin feeds canned multi-page API responses into the REAL
// provider's HTTP client (one `responses.json` corpus, not row arrays), so the
// minimal universe just carries the default corpus verbatim — it is already
// small (one portfolio, a handful of orders/fills/transactions) and shrinking
// it further would drop the multi-page balances/orders paths the E2E asserts.

{
  const responses = readJson(srcPath("coinbase", "responses.json"));
  writeJson(dstPath("coinbase", "responses.json"), responses);
  console.log(
    `  coinbase/responses.json: ${responses.accountsPages.length} accounts page(s), ${responses.ordersPages.length} orders page(s) (verbatim)`,
  );
}

// ── plaid: a single-item canned-response corpus ───────────────────────
//
// The Plaid synth twin feeds canned API responses into the REAL provider's
// HTTP client (one `responses.json` corpus: a transactions delta page plus the
// point-in-time balance/holdings reads), so the minimal universe carries the
// default corpus verbatim — it is already small (one item, a couple of
// transactions, three accounts, two holdings) and exercises every phase.

{
  const responses = readJson(srcPath("plaid", "responses.json"));
  writeJson(dstPath("plaid", "responses.json"), responses);
  console.log(
    `  plaid/responses.json: ${responses.transactionsSyncPages.length} txn page(s), ${responses.accountsGet.accounts.length} account(s) (verbatim)`,
  );
}

// ── browser-history + screen-time: shrink the `days` list ─────────────

for (const sourceKey of ["browser-history", "screen-time"]) {
  const fname = sourceKey === "browser-history" ? "visits.json" : "apps.json";
  const f = readJson(srcPath(sourceKey, fname));
  if (!Array.isArray(f.days)) {
    throw new Error(`${sourceKey}/${fname} should have a 'days' array`);
  }
  const slimmed = { ...f, days: f.days.slice(0, STRUCTURED_KEEP_DAYS) };
  writeJson(dstPath(sourceKey, fname), slimmed);
  console.log(`  ${sourceKey}/${fname}: ${f.days.length}d → ${slimmed.days.length}d`);
}

console.log(`\nDone. Outputs under ${DST_UNIVERSE}/sources/`);
if (!existsSync(join(DST_UNIVERSE, "universe.json"))) {
  console.log(
    "Reminder: write universe.json next to cast.json — name, cast, the devices roster, and sources with their device.",
  );
}
