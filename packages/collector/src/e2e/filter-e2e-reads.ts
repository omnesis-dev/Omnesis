// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The two sides a filter suite compares: what an external agent really reads
 * of an account, and what the owner's screens say about it.
 *
 * The agent side asks the way an agent asks: Direct `search_many` and
 * `fetch_many` over MCP with an OAuth credential, and, for Answer, the
 * Omnesis agent's own search and fetch, observed by a scripted model. The
 * owner side is the filter editor, its preview, the per-document routes and
 * the resync route. Levels are edited through the access-level route the
 * portal and the apps use.
 */

import { randomUUID } from "node:crypto";
import SqliteDatabase from "better-sqlite3";
import { expect } from "vitest";
import {
  accessOverview,
  authorizeMcpClient,
  loginPortal,
  portalJson,
  portalRequest,
  requestRule,
  type AuthorizedMcpClient,
  type PortalSession,
  type TestGrantRule,
} from "./mcp-oauth-helper.js";
import type { ScopeScriptedAgent } from "./scope-scripted-agent.js";
import type { HarnessDevice, SyntheticE2EHarness } from "./synth-harness.js";
import type { FilterRef, SourceFilter } from "@omnesis/types";

// ── Stored records ─────────────────────────────────────────────────────────

/** One stored record, named by a key the suite chooses. */
export interface StoredRecord {
  key: string;
  id: string;
  externalId: string;
  sourceId: string;
  streamId: string;
  version: number;
  /** A word only this record's text holds, for leak checks; empty when it has none. */
  marker: string;
  /** The record's text, which decides whether a search for a word can find it. */
  content: string;
}
export type RecordSet = Map<string, StoredRecord>;

/** A read of the gateway's document store; nothing here is served over HTTP. */
export function readStore<T>(
  harness: SyntheticE2EHarness,
  read: (db: SqliteDatabase.Database) => T,
): T {
  const db = new SqliteDatabase(harness.getDbPath(), { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

interface RecordRow {
  id: string;
  external_id: string;
  source_id: string;
  stream_id: string;
  source_version: number;
  content: string;
}

/**
 * Every record of the accounts, keyed by `keyOf`. A record `keyOf` names no
 * key for is left out; two records under one key fail the suite. When an
 * account keeps one stream per device, the device's roster id is appended
 * (`atlas@laptop`) so the copies on two computers are two records.
 */
export function readRecords(
  harness: SyntheticE2EHarness,
  sourceIds: readonly string[],
  keyOf: (row: { externalId: string; content: string }) => { key: string; marker: string } | null,
): RecordSet {
  const rows = readStore(harness, (db) =>
    db
      .prepare<string[], RecordRow>(
        `SELECT id, external_id, source_id, stream_id, source_version, content FROM documents
          WHERE source_id IN (${sourceIds.map(() => "?").join(",")})
          ORDER BY source_id, stream_id, external_id`,
      )
      .all(...sourceIds),
  );
  const devices = new Map(harness.getDevices().map((device) => [device.deviceId, device.rosterId]));
  const records: RecordSet = new Map();
  for (const row of rows) {
    const named = keyOf({ externalId: row.external_id, content: row.content });
    if (!named) continue;
    const key = row.stream_id
      ? `${named.key}@${devices.get(row.stream_id) ?? row.stream_id}`
      : named.key;
    if (records.has(key)) throw new Error(`Two stored records are named ${key}`);
    records.set(key, {
      key,
      id: row.id,
      externalId: row.external_id,
      sourceId: row.source_id,
      streamId: row.stream_id,
      version: row.source_version,
      marker: named.marker,
      content: row.content,
    });
  }
  return records;
}

/** Keys a record by the first match of `pattern` in its text: `BODY_ATLAS_ISSUE` → `atlas-issue`. */
export function markerKey(pattern: RegExp) {
  return ({ content }: { content: string }): { key: string; marker: string } | null => {
    const match = pattern.exec(content);
    if (!match?.[1]) return null;
    return { key: match[1].toLowerCase().replaceAll("_", "-"), marker: match[0] };
  };
}

/** The records' versions as stored now, by key. */
export function versionsOf(harness: SyntheticE2EHarness, records: RecordSet): Map<string, number> {
  const byId = new Map(
    readStore(harness, (db) =>
      db
        .prepare<[string], { id: string; source_version: number }>(
          "SELECT id, source_version FROM documents WHERE id IN (SELECT value FROM json_each(?))",
        )
        .all(JSON.stringify([...records.values()].map((record) => record.id))),
    ).map((row) => [row.id, row.source_version]),
  );
  return new Map([...records.values()].map((record) => [record.key, byId.get(record.id) ?? -1]));
}

/** Each record's id, by key: what a resync in place must leave as it was. */
export const identities = (records: RecordSet): Record<string, string> =>
  Object.fromEntries([...records.values()].map((record) => [record.key, record.id]));

// ── Access levels ──────────────────────────────────────────────────────────

export type AgentCapability = "direct" | "answer";
type Sources = { mode: "all" | "allowlist" | "denylist"; sourceIds: string[] };

/** A rule granting one capability over `sources`, Answer released without review. */
export function grantRule(capability: AgentCapability, sources: Sources = ALL): TestGrantRule {
  return capability === "answer"
    ? { capability, sources, release: { mode: "unreviewed" } }
    : { capability, sources };
}
const ALL: Sources = { mode: "all", sourceIds: [] };

/**
 * An agent connected over MCP on a level of its own, named `name` like the
 * agent, approved the way the portal approves one. Registering an OAuth client is rate limited, so a suite
 * opens its agents once and edits their levels between cases.
 */
export async function connectAgent(
  harness: SyntheticE2EHarness,
  name: string,
  rules: TestGrantRule[],
): Promise<AuthorizedMcpClient> {
  return authorizeMcpClient(harness, {
    principalName: name,
    grantName: `${name} connection`,
    credentialLabel: `${name} credential`,
    capabilities: rules.map((rule) => rule.capability),
    rules,
  });
}

export async function closeAgents(
  agents: ReadonlyArray<AuthorizedMcpClient | undefined>,
): Promise<void> {
  for (const agent of agents)
    if (agent) await Promise.allSettled([agent.client.close(), agent.transport.close()]);
}

/** The level an agent's connection is on, as the access overview serves it. */
export async function levelOf(harness: SyntheticE2EHarness, agent: AuthorizedMcpClient) {
  const overview = await accessOverview(harness.gatewayUrl, agent.portal);
  const grant = overview.principals
    .flatMap((principal) => principal.grants)
    .find((candidate) => candidate.id === agent.grantId);
  return levelById(harness, agent.portal, grant?.levelId ?? "");
}

async function levelById(harness: SyntheticE2EHarness, portal: PortalSession, levelId: string) {
  const overview = await accessOverview(harness.gatewayUrl, portal);
  const level = overview.levels?.find((candidate) => candidate.id === levelId);
  if (!level) throw new Error(`No access level ${levelId}`);
  return level;
}

/** A level no agent is connected to, created the way the portal creates one. */
export async function createLevel(
  harness: SyntheticE2EHarness,
  portal: PortalSession,
  name: string,
  rules: TestGrantRule[],
): Promise<string> {
  const created = await portalJson<{ level: { id: string } }>(
    harness.gatewayUrl,
    portal,
    "/admin/access/levels",
    { name, rules },
  );
  return created.level.id;
}

/** A filter on one account; the level and capability are filled in when it is saved. */
export function sourceFilter(
  sourceId: string,
  action: "share" | "hide",
  match: FilterRef[],
): SourceFilter {
  return {
    sourceId,
    audience: { accessLevel: "new", capability: "direct" },
    rules: [{ match, action }],
    otherwise: action === "share" ? "hide" : "share",
  };
}

function levelEdit(
  level: Awaited<ReturnType<typeof levelOf>>,
  filters: Partial<Record<AgentCapability, SourceFilter[]>>,
) {
  const expectedFilterRevisions: Record<string, number> = {};
  const rules = level.rules.map((served) => {
    const rule = requestRule(served);
    if (rule.capability === "notes") return rule;
    if (rule.filterRevision !== undefined)
      expectedFilterRevisions[rule.capability] = rule.filterRevision;
    const { filterRevision: _revision, ...sent } = rule;
    return {
      ...sent,
      scopePolicies: (filters[rule.capability] ?? []).map((filter) => ({
        ...filter,
        audience: { accessLevel: level.id, capability: rule.capability },
      })),
    };
  });
  return { expectedRevision: level.revision, expectedFilterRevisions, rules };
}

/** Replace the filters of the agent's level, per capability, as the portal saves them. */
export async function saveFilters(
  harness: SyntheticE2EHarness,
  agent: AuthorizedMcpClient,
  filters: Partial<Record<AgentCapability, SourceFilter[]>>,
): Promise<void> {
  const level = await levelOf(harness, agent);
  await saveLevelFilters(harness, agent.portal, level.id, filters);
}

/** Replace the filters of a level, per capability, as the portal saves them. */
export async function saveLevelFilters(
  harness: SyntheticE2EHarness,
  portal: PortalSession,
  levelId: string,
  filters: Partial<Record<AgentCapability, SourceFilter[]>>,
): Promise<void> {
  const level = await levelById(harness, portal, levelId);
  await portalJson(
    harness.gatewayUrl,
    portal,
    `/admin/access/levels/${level.id}`,
    levelEdit(level, filters),
    "PATCH",
  );
}

/**
 * Try to save filters the gateway is expected to refuse; returns the status,
 * the refusal's code and the sentence the owner is shown.
 */
export async function refusedSave(
  harness: SyntheticE2EHarness,
  agent: AuthorizedMcpClient,
  filters: Partial<Record<AgentCapability, SourceFilter[]>>,
): Promise<{ status: number; error: string; message?: string }> {
  const level = await levelOf(harness, agent);
  const result = await portalRequest(
    harness.gatewayUrl,
    agent.portal,
    "PATCH",
    `/admin/access/levels/${level.id}`,
    levelEdit(level, filters),
  );
  const body = result.body as { error?: unknown; message?: unknown } | null;
  return {
    status: result.status,
    error: String(body?.error ?? ""),
    ...(typeof body?.message === "string" ? { message: body.message } : {}),
  };
}

// ── What an agent reads ────────────────────────────────────────────────────

/**
 * Each credential has a per-minute budget of Direct tool calls. A suite can
 * make more than a minute's worth on one connection, so calls wait for room
 * instead of spending a refusal that would read as a withheld record.
 */
const DIRECT_CALLS_PER_MINUTE = 90;
/** Direct's `fetch_many` takes at most two documents a call. */
const FETCH_BATCH = 2;
const callTimes = new WeakMap<AuthorizedMcpClient, number[]>();

async function callTool(
  agent: AuthorizedMcpClient,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: unknown; structuredContent?: unknown; content?: unknown }> {
  const times = callTimes.get(agent) ?? [];
  callTimes.set(agent, times);
  for (;;) {
    const now = Date.now();
    while (times.length && times[0]! <= now - 61_000) times.shift();
    if (times.length < DIRECT_CALLS_PER_MINUTE) break;
    await new Promise((resolve) => setTimeout(resolve, times[0]! + 61_000 - now));
  }
  times.push(Date.now());
  const response = await agent.client.callTool({ name, arguments: args });
  expect(JSON.stringify(response.content ?? ""), `${name} was rate limited`).not.toContain(
    "Too many Omnesis",
  );
  return response;
}

/** The keys of the records a single Direct `fetch_many` returns as documents. */
export async function directFetched(
  agent: AuthorizedMcpClient,
  records: readonly StoredRecord[],
): Promise<string[]> {
  const fetched: string[] = [];
  for (let offset = 0; offset < records.length; offset += FETCH_BATCH) {
    const batch = records.slice(offset, offset + FETCH_BATCH);
    const response = await callTool(agent, "fetch_many", {
      documents: batch.map((record) => ({ documentId: record.id })),
    });
    expect(response.isError, `fetch_many failed: ${JSON.stringify(response.content)}`).not.toBe(
      true,
    );
    const items = (response.structuredContent as { items: Array<{ kind: string }> }).items;
    expect(items).toHaveLength(batch.length);
    for (const [index, record] of batch.entries()) {
      const item = JSON.stringify(items[index]);
      if (items[index]!.kind === "document") {
        expect(item, `fetch ${record.key}`).toContain(record.id);
        fetched.push(record.key);
      } else {
        expect(items[index]!.kind, `fetch ${record.key}`).toBe("error");
        if (record.marker) expect(item, `fetch ${record.key}`).not.toContain(record.marker);
      }
    }
  }
  return fetched;
}

/**
 * The keys of the records one Direct `search_many` returns. The search names
 * no account, so an account the agent cannot read is not asked for.
 */
export async function directSearched(
  agent: AuthorizedMcpClient,
  records: readonly StoredRecord[],
  query: string,
): Promise<{ keys: string[]; raw: string }> {
  const response = await callTool(agent, "search_many", {
    queries: [{ query, limit: 50 }],
  });
  expect(response.isError, `search_many failed: ${JSON.stringify(response.content)}`).not.toBe(
    true,
  );
  const raw = JSON.stringify(response.structuredContent);
  return { keys: records.filter((record) => raw.includes(record.id)).map((r) => r.key), raw };
}

/** Nothing of a withheld record — its id, or the word only its text holds — in `serialized`. */
function expectNoTrace(
  serialized: string,
  withheld: readonly StoredRecord[],
  shown: readonly StoredRecord[],
) {
  for (const record of withheld) {
    expect(serialized, `${record.key} leaked`).not.toContain(record.id);
    if (ownMarker(record, shown))
      expect(serialized, `${record.key} leaked`).not.toContain(record.marker);
  }
}

/**
 * Whether a withheld record's marker is its own: a marker a shown record
 * shares (the same file on two computers) proves nothing about this one.
 */
const ownMarker = (record: StoredRecord, shown: readonly StoredRecord[]): boolean =>
  record.marker !== "" && !shown.some((other) => other.marker === record.marker);

/**
 * Direct agrees on one boundary: fetching every record by id returns exactly
 * `expected`, and a search for `query` finds exactly the `expected` records
 * whose text holds it, with no trace of any other. Search shows one record
 * of several with the same text (the same file on two computers), so it is
 * compared by text: every text of an expected record is found, through
 * expected records only. Search is retried while the index copy catches up
 * with the corpus; a withheld record never appears in any attempt.
 */
export async function expectDirectReads(
  harness: SyntheticE2EHarness,
  agent: AuthorizedMcpClient,
  records: RecordSet,
  expected: readonly string[],
  query: string,
): Promise<void> {
  const all = [...records.values()];
  for (const key of expected) if (!records.has(key)) throw new Error(`Unknown record ${key}`);
  const want = [...expected].sort();
  const shown = all.filter((record) => expected.includes(record.key));
  const withheld = all.filter((record) => !expected.includes(record.key));
  expect((await directFetched(agent, all)).sort(), "Direct fetch").toEqual(want);
  // Each record stands for every record with its text: the first of them by key.
  const sameText = (key: string) =>
    all
      .filter((record) => record.content === records.get(key)!.content)
      .map((record) => record.key)
      .sort()[0]!;
  const texts = (keys: readonly string[]) => [...new Set(keys.map(sameText))].sort();
  const found = texts(
    shown
      .filter((record) => record.content.toLowerCase().includes(query.toLowerCase()))
      .map((record) => record.key),
  );
  let searched: string[] = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await directSearched(agent, all, query);
    expectNoTrace(result.raw, withheld, shown);
    for (const key of result.keys) expect(want, `search found ${key}`).toContain(key);
    searched = texts(result.keys);
    if (JSON.stringify(searched) === JSON.stringify(found)) break;
    await harness.reindexMissing();
    await harness.refreshSearchSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  expect(searched, "Direct search").toEqual(found);
}

/**
 * What the Omnesis agent answering for `agent` read of one account: it
 * searches the account for `query` and fetches every record by id, and the
 * scripted model records what its tools returned. `fetched` are the keys
 * that came back as documents, `searched` the keys whose id the search
 * returned. The model is never shown a withheld record.
 */
export async function answerReads(
  model: ScopeScriptedAgent,
  agent: AuthorizedMcpClient,
  records: RecordSet,
  query: string,
): Promise<{ fetched: string[]; searched: string[] }> {
  const all = [...records.values()];
  const sourceIds = [...new Set(all.map((record) => record.sourceId))];
  if (sourceIds.length !== 1) throw new Error("An Answer probe reads one account");
  const probe = model.register({
    sourceId: sourceIds[0]!,
    documentIds: all.map((record) => record.id),
    query,
  });
  const response = await agent.client.callTool({
    name: "ask_omnesis",
    arguments: {
      question: probe.question,
      requestId: randomUUID(),
      workflowName: "Invented filter check",
      workflowPurpose: "Read invented authorized evidence.",
    },
  });
  expect(response.isError, "ask_omnesis failed").not.toBe(true);
  let value = response.structuredContent as { status: string; taskId: string; answer?: string };
  for (let attempt = 0; attempt < 300 && ["running", "queued"].includes(value.status); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const polled = await agent.client.callTool({
      name: "get_answer_status",
      arguments: { taskId: value.taskId },
    });
    expect(polled.isError).not.toBe(true);
    value = polled.structuredContent as typeof value;
  }
  expect(value.status).toMatch(/^released/);
  const fetched = documentIdsIn(probe.observed.fetched);
  const readable = all.filter((record) => fetched.has(record.id));
  const withheld = all.filter((record) => !fetched.has(record.id));
  const inputs = probe.observed.modelInputs.join("\n");
  for (const record of withheld)
    if (ownMarker(record, readable))
      expect(inputs, `model input ${record.key}`).not.toContain(record.marker);
  const search = JSON.stringify(probe.observed.search ?? null);
  expectNoTrace(search, withheld, readable);
  return {
    fetched: readable.map((record) => record.key).sort(),
    searched: all
      .filter((record) => search.includes(record.id))
      .map((record) => record.key)
      .sort(),
  };
}

/** The keys the Omnesis agent answering for `agent` could fetch; see {@link answerReads}. */
export async function answerReadable(
  model: ScopeScriptedAgent,
  agent: AuthorizedMcpClient,
  records: RecordSet,
  query: string,
): Promise<string[]> {
  return (await answerReads(model, agent, records, query)).fetched;
}

/** Ids of the documents (not errors) in a fetch result. */
function documentIdsIn(value: unknown): Set<string> {
  const ids = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const item = node as Record<string, unknown>;
    const document = item.document as { id?: unknown } | undefined;
    if (item.kind === "document" && typeof document?.id === "string") ids.add(document.id);
    Object.values(item).forEach(walk);
  };
  walk(value);
  return ids;
}

// ── The owner's screens ────────────────────────────────────────────────────

export type FieldState =
  | { status: "ready" }
  | { status: "needs-resync"; cost: string | null; text: string }
  | { status: "resyncing"; processed: number; total: number | null; text: string }
  | { status: "collector-behind"; devices: Array<{ id: string; name: string }>; text: string }
  | { status: "gateway-behind"; text: string }
  | { status: "list-pending"; text: string };

export interface FieldCounts {
  tooOld: number;
  unmatched: number;
  tooOldText: string | null;
  unmatchedText: string | null;
}

export interface EditorField {
  field: string;
  capability: string;
  state: FieldState;
  counts: { status: "pending" } | ({ status: "ready" } & FieldCounts);
}

export async function editorField(
  harness: SyntheticE2EHarness,
  sourceId: string,
  field: string,
): Promise<EditorField> {
  const editor = await harness.gatewayJson<{ fields: EditorField[] }>(
    `/admin/access/source-filters/${encodeURIComponent(sourceId)}`,
  );
  const found = editor.fields.find((candidate) => candidate.field === field);
  if (!found) throw new Error(`The editor of ${sourceId} has no field ${field}`);
  return found;
}

/** The editor's two counts under a field, once the gateway has taken them. */
export async function fieldCounts(
  harness: SyntheticE2EHarness,
  sourceId: string,
  field: string,
): Promise<FieldCounts> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const { counts } = await editorField(harness, sourceId, field);
    if (counts.status === "ready") {
      const { status: _status, ...ready } = counts;
      return ready;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The editor never finished counting ${field} of ${sourceId}`);
}

export interface FilterPreview {
  total: number;
  visible: number;
  hidden: number;
  tooOld: number;
  unmatched: number;
  tooOldText: string | null;
  unmatchedText: string | null;
  items: Array<{ ref: FilterRef; label: string; count: number; missing?: boolean }>;
}

/** What a draft filter would leave of its account, as the editor's review shows it. */
export async function previewFilter(
  harness: SyntheticE2EHarness,
  portal: PortalSession,
  filter: SourceFilter,
): Promise<FilterPreview> {
  const path = `/admin/access/source-filters/${encodeURIComponent(filter.sourceId)}/preview`;
  for (let attempt = 0; attempt < 120; attempt++) {
    const preview = await portalJson<{ status: string } & FilterPreview>(
      harness.gatewayUrl,
      portal,
      path,
      { policy: filter },
    );
    if (preview.status === "ready") return preview;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The preview of a filter on ${filter.sourceId} never finished`);
}

export const ownerPortal = (harness: SyntheticE2EHarness): Promise<PortalSession> =>
  loginPortal(harness);

/**
 * One entry of a field's picker, searched for and found by the end of its
 * label, with the count of records it would share once that is taken. A
 * per-device field is searched on `device`.
 */
export async function pickEntry(
  harness: SyntheticE2EHarness,
  sourceId: string,
  field: string,
  labelEndsWith: string,
  device?: HarnessDevice,
): Promise<{ ref: FilterRef; label: string; count: number | null }> {
  const query = labelEndsWith.split("/").filter(Boolean).at(-1) ?? labelEndsWith;
  const path =
    `/admin/access/source-filters/${encodeURIComponent(sourceId)}/options` +
    `?field=${encodeURIComponent(field)}&q=${encodeURIComponent(query)}` +
    (device ? `&device=${encodeURIComponent(device.deviceId)}` : "");
  for (let attempt = 0; attempt < 120; attempt++) {
    const options = await harness.gatewayJson<{
      items: Array<{ ref: FilterRef; label: string; count: number | null }>;
      retryAfterMs?: number;
    }>(path);
    const item = options.items.find((candidate) => candidate.label.endsWith(labelEndsWith));
    if (!item) throw new Error(`${sourceId} offers no ${labelEndsWith} for ${field}`);
    if (item.count !== null) return item;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${sourceId} never counted ${labelEndsWith}`);
}

/** A phone number, address or domain as the editor reads one typed by the owner. */
export async function typedIdentifier(
  harness: SyntheticE2EHarness,
  portal: PortalSession,
  type: "phone" | "email" | "domain",
  value: string,
): Promise<{ type: "phone" | "email" | "domain"; value: string }> {
  const read = await portalJson<{
    identifier?: { type: "phone" | "email" | "domain"; value: string };
  }>(harness.gatewayUrl, portal, "/admin/access/source-filters/identifiers", { type, value });
  if (!read.identifier) throw new Error(`${value} was not read as a ${type}`);
  return read.identifier;
}

/** Each level's two verdicts on one document, as "Who can read this document?" gives them. */
export interface DocumentAudit {
  documentId: string;
  title: string;
  sourceId: string;
  sourceName: string;
  accountLabel: string | null;
  sourceVersion: number;
  notes: { answer: string; owner: string };
  levels: Array<{
    id: string;
    name: string;
    agents: Array<{ id: string; name: string; kind: string }>;
    answer: { readable: boolean; code: string; text: string };
    direct: { readable: boolean; code: string; text: string };
  }>;
}

export const documentAudit = (harness: SyntheticE2EHarness, record: StoredRecord) =>
  harness.gatewayJson<DocumentAudit>(`/admin/documents/${encodeURIComponent(record.id)}/access`);

// ── Writing records ────────────────────────────────────────────────────────

/**
 * Store documents in an account the way its host's sync page stores them, at
 * `version`, without moving the account's cursor.
 */
export async function pushAtVersion(
  harness: SyntheticE2EHarness,
  account: { sourceId: string; providerId: string },
  documents: ReadonlyArray<Record<string, unknown>>,
  version: number,
): Promise<void> {
  const path = `/sync-state/${encodeURIComponent(account.sourceId)}`;
  const state = await harness.gatewayJson<{ cursor?: unknown; wipeEpoch: number }>(path);
  const result = await harness.gatewayJson<{ rejected?: boolean }>("/documents/with-cursor", {
    method: "POST",
    body: JSON.stringify({
      providerId: account.providerId,
      sourceId: account.sourceId,
      documents,
      deletedExternalIds: [],
      cursor: state.cursor ?? {},
      wipeEpoch: state.wipeEpoch,
      hasMore: false,
      sourceVersion: version,
    }),
  });
  if (result.rejected) throw new Error(`The page for ${account.sourceId} was refused`);
}

/** The provider id an account's stored records carry. */
export function providerIdOf(harness: SyntheticE2EHarness, sourceId: string): string {
  const row = readStore(harness, (db) =>
    db
      .prepare<[string], { provider_id: string }>(
        "SELECT provider_id FROM documents WHERE source_id = ? LIMIT 1",
      )
      .get(sourceId),
  );
  if (!row) throw new Error(`${sourceId} holds no record`);
  return row.provider_id;
}

// ── Resync ─────────────────────────────────────────────────────────────────

/** Send the account (or one device's stream of it) back to the start, keeping every record. */
export async function resyncInPlace(
  harness: SyntheticE2EHarness,
  sourceId: string,
  device?: HarnessDevice,
): Promise<{ ok: boolean; mode: string; scope: string }> {
  return harness.gatewayJson(`/admin/sources/${encodeURIComponent(sourceId)}/resync`, {
    method: "POST",
    body: JSON.stringify({ mode: "in-place", ...(device ? { deviceId: device.deviceId } : {}) }),
  });
}

/** One state the editor showed for a field, with the sentence it showed. */
export interface ObservedState {
  status: FieldState["status"];
  text?: string;
}

/**
 * Resync an account in place and read it again, watching the editor's state
 * for `field` throughout: before the resync, after it, after the first page
 * of the read has been stored (the read is held there until the editor has
 * been asked), and until it is `ready`. Returns the states in the order they
 * were seen, each once.
 *
 * The read is the hosts' own sync, started the way the resync's command
 * starts it. Fixture twins page by `OMNESIS_SYNTH_BATCH_SIZE`, so a small
 * page makes the read span several pages; a source that reads everything in
 * one page is never seen `resyncing`.
 */
export async function resyncAndWatch(
  harness: SyntheticE2EHarness,
  sourceId: string,
  field: string,
  options: { device?: HarnessDevice; pageSize?: number; timeoutMs?: number } = {},
): Promise<ObservedState[]> {
  const seen: ObservedState[] = [];
  const look = async (): Promise<FieldState> => {
    const { state } = await editorField(harness, sourceId, field);
    const observed: ObservedState = {
      status: state.status,
      ...("text" in state ? { text: state.text } : {}),
    };
    const last = seen.at(-1);
    if (last?.status !== observed.status || last.text !== observed.text) seen.push(observed);
    return state;
  };
  await look();
  const answer = await resyncInPlace(harness, sourceId, options.device);
  expect(answer).toMatchObject({ ok: true, mode: "in-place" });
  await look();

  const hosts = options.device ? [options.device] : harness.devicesForSource(sourceId);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held: Array<Promise<void>> = [];
  const restores: Array<() => void> = [];
  for (const host of hosts) {
    const instance = host.engine.getSourcesById(sourceId)[0]!.instance;
    const original = instance.sync;
    let calls = 0;
    let entered!: () => void;
    held.push(
      new Promise<void>((resolve) => {
        entered = resolve;
      }),
    );
    instance.sync = async (...args) => {
      calls++;
      if (calls === 2) {
        entered();
        await gate;
      }
      return original.apply(instance, args);
    };
    restores.push(() => {
      instance.sync = original;
    });
  }
  const previousPageSize = process.env.OMNESIS_SYNTH_BATCH_SIZE;
  if (options.pageSize !== undefined)
    process.env.OMNESIS_SYNTH_BATCH_SIZE = String(options.pageSize);
  try {
    const reading = harness.triggerSyncAndWait(
      sourceId,
      options.timeoutMs ?? 120_000,
      options.device,
    );
    // Each host is either held after its first page or already done.
    await Promise.race([Promise.all(held), reading]);
    await look();
    release();
    await reading;
  } finally {
    release();
    for (const restore of restores) restore();
    if (previousPageSize === undefined) delete process.env.OMNESIS_SYNTH_BATCH_SIZE;
    else process.env.OMNESIS_SYNTH_BATCH_SIZE = previousPageSize;
  }
  for (let attempt = 0; attempt < 120; attempt++) {
    const state = await look();
    if (state.status !== "resyncing") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return seen;
}

/** The resync cost sentence the gateway stored for a source type, from its host. */
export function resyncCost(harness: SyntheticE2EHarness, sourceType: string): string | null {
  return readStore(
    harness,
    (db) =>
      db
        .prepare<[string], { resync_cost: string | null }>(
          "SELECT resync_cost FROM source_family_meta WHERE source_type = ?",
        )
        .get(sourceType)?.resync_cost ?? null,
  );
}

/** The version a source's hosts send by default: the output revision its definition declares. */
export function declaredVersion(harness: SyntheticE2EHarness, sourceId: string): number {
  const version = harness
    .deviceForSource(sourceId)
    .engine.getSourcesById(sourceId)[0]?.sourceVersion;
  if (version === undefined) throw new Error(`${sourceId} declares no version`);
  return version;
}
