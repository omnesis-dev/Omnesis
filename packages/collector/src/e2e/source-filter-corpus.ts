// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the source-filter suites share: a synthetic account's records read as
 * a corpus a test can state exact sets of, filters saved on a live
 * connection's access level the way the portal saves them, the owner's
 * editor read the way a client polls it, and the two read surfaces an
 * external agent has — Direct and Answer — checked against an exact set.
 *
 * Exports, for every suite that needs them:
 * - {@link startFilterHarness}: a spawned experimental gateway (filters are
 *   gated on experimental mode) whose agent and privacy reviewer are a
 *   scripted model, with a short indexer cycle so the index's copy of filter
 *   details follows the corpus within seconds.
 * - {@link readFilterCorpus}: an account's stored records keyed by the marker
 *   their fixtures carry (`TITLE_X`, `BODY_X`, `PROMPT_X`), or by a caller's
 *   own description of each row.
 * - {@link openFilterContext} / {@link closeFilterContext}: three Direct
 *   connections and one Answer connection, each on its own access level, and
 *   an owner portal session.
 * - {@link filterPolicy}, {@link saveFilters}, {@link trySaveFilters}: build
 *   a `SourceFilter` and replace a level's filters through
 *   `PATCH /admin/access/levels/:id`.
 * - {@link expectDirectBoundary}, {@link expectAnswerBoundary},
 *   {@link expectFilterBoundary}: save one filter and check the exact set an
 *   agent reads through search, fetch by id and URL lookup (Direct), or
 *   through the internal agent's own tools and its released answer (Answer).
 * - {@link filterEditor}, {@link filterOptions}, {@link pickTreePath},
 *   {@link pickPerson}, {@link filterPreview}, {@link typedIdentifier}: the
 *   owner's editor routes, polled until their counts are ready.
 */

import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
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
} from "./mcp-oauth-helper.js";
import { SyntheticE2EHarness, type SyntheticHarnessOptions } from "./synth-harness.js";
import type { ScopeScriptedAgent } from "./scope-scripted-agent.js";
import type {
  FilterIdentifier,
  FilterIdentifierType,
  FilterRef,
  SourceFilter,
} from "@omnesis/types";

/** The word the invented records of the filter universes carry, so one query reaches them all. */
export const FILTER_QUERY = "zqfilter";

export type FilterAccess = "direct" | "answer";
export type FilterAction = "share" | "hide";

/**
 * A gateway for a filter suite: experimental mode (filter editing is gated on
 * it), the scripted model as the agent and the privacy reviewer, and an
 * indexer cycle of one second. Lists and version-only changes reach the
 * index's copy of filter details on the indexer's cycle, and a filtered
 * search draws its candidates from that copy.
 */
export function startFilterHarness(
  universe: string,
  model: ScopeScriptedAgent,
  options: Partial<Omit<SyntheticHarnessOptions, "gatewayMode" | "universe">> = {},
): SyntheticE2EHarness {
  return new SyntheticE2EHarness({
    gatewayMode: "experimental",
    universe,
    ...options,
    extraInference: {
      ...options.extraInference,
      backends: {
        ...options.extraInference?.backends,
        filterAgent: { type: "http", url: model.url },
      },
      assignments: {
        agent: `filterAgent/${model.modelId}`,
        "privacy-reviewer": `filterAgent/${model.modelId}`,
        ...options.extraInference?.assignments,
      },
    },
    extraGatewayEnv: {
      OMNESIS_INDEX_INTERVAL: "1s",
      ...(options.extraGatewayEnv as Record<string, string> | undefined),
    },
  });
}

// ── Corpus ──────────────────────────────────────────────────────────────────

export interface FilterRecord {
  key: string;
  id: string;
  externalId: string;
  /** Text only this record holds; an Answer built from the record contains it. */
  body: string;
  /** Everything of the record that must not reach an agent it is withheld from. */
  traces: string[];
  url?: string;
}

export interface FilterCorpus {
  sourceId: string;
  /** A search query that reaches every record of the corpus. */
  query: string;
  records: Map<string, FilterRecord>;
}

export interface StoredFilterRow {
  id: string;
  external_id: string;
  title: string;
  content: string;
  stream_id: string | null;
  url: string | null;
}

export interface FilterRowDescription {
  key: string;
  body: string;
  /** Extra text of the record that must stay withheld; the id, the external id and `body` always are. */
  traces?: string[];
}

/** The marker a filter-universe fixture puts in each record: `TITLE_X`, `BODY_X`, `PROMPT_X`. */
export function describeMarkedRow(row: StoredFilterRow): FilterRowDescription | null {
  const marker = /(?:TITLE|BODY|PROMPT|ANSWER)_([A-Z0-9_]+)/.exec(
    `${row.title}\n${row.content}`,
  )?.[1];
  if (!marker) return null;
  const traces = [
    `TITLE_${marker}`,
    `BODY_${marker}`,
    `PROMPT_${marker}`,
    `ANSWER_${marker}`,
  ].filter((trace) => row.title.includes(trace) || row.content.includes(trace));
  const body = traces.find((trace) => row.content.includes(trace));
  if (!body) return null;
  return { key: marker.toLowerCase().replaceAll("_", "-"), body, traces };
}

/**
 * The stored records of one account as a corpus. Each row is described by
 * `describe` (by default, its fixture marker); a row described as `null` is
 * left out, and two rows with one key are an error.
 */
export function readFilterCorpus(
  harness: SyntheticE2EHarness,
  sourceId: string,
  options: {
    describe?: (row: StoredFilterRow) => FilterRowDescription | null;
    query?: string;
  } = {},
): FilterCorpus {
  const describe = options.describe ?? describeMarkedRow;
  const reader = new Database(harness.getDbPath(), { readonly: true });
  try {
    const rows = reader
      .prepare<[string], StoredFilterRow>(
        `SELECT id, external_id, title, content, stream_id,
                json_extract(metadata, '$.sourceUrl') AS url
           FROM documents WHERE source_id = ? ORDER BY external_id, stream_id`,
      )
      .all(sourceId);
    const records = new Map<string, FilterRecord>();
    for (const row of rows) {
      const described = describe(row);
      if (!described) continue;
      if (records.has(described.key))
        throw new Error(`Two records of ${sourceId} are described as ${described.key}`);
      records.set(described.key, {
        key: described.key,
        id: row.id,
        externalId: row.external_id,
        body: described.body,
        traces: [...new Set([described.body, ...(described.traces ?? [])])],
        ...(row.url ? { url: row.url } : {}),
      });
    }
    return { sourceId, query: options.query ?? FILTER_QUERY, records };
  } finally {
    reader.close();
  }
}

function partition(corpus: FilterCorpus, shared: readonly string[]) {
  for (const key of shared)
    if (!corpus.records.has(key)) throw new Error(`Unknown record ${key} in ${corpus.sourceId}`);
  const all = [...corpus.records.values()];
  const allowed = all.filter((record) => shared.includes(record.key));
  // A text a shared record also holds (the same session read on two
  // computers, with the same external id) may appear; only what is the
  // withheld record's alone may not.
  const sharedText = new Set(allowed.flatMap((record) => [...record.traces, record.externalId]));
  const denied = all
    .filter((record) => !shared.includes(record.key))
    .map((record) => ({
      ...record,
      traces: record.traces.filter((trace) => !sharedText.has(trace)),
      externalIdShared: sharedText.has(record.externalId),
    }));
  return { all, allowed, denied };
}

type WithheldRecord = FilterRecord & { externalIdShared?: boolean };

function expectNoTrace(
  serialized: string,
  denied: readonly WithheldRecord[],
  surface: string,
  { idMayAppear = false }: { idMayAppear?: boolean } = {},
): void {
  for (const record of denied) {
    const traces = [
      ...record.traces,
      ...(idMayAppear ? [] : [record.id]),
      ...(idMayAppear || record.externalIdShared ? [] : [record.externalId]),
    ];
    for (const trace of traces)
      expect(serialized, `${surface} leaked ${record.key} (${trace})`).not.toContain(trace);
  }
}

// ── Connections and saved filters ───────────────────────────────────────────

export function filterPolicy(
  sourceId: string,
  access: FilterAccess,
  action: FilterAction,
  match: FilterRef[],
): SourceFilter {
  return {
    sourceId,
    audience: { accessLevel: "new", capability: access },
    rules: [{ match, action }],
    otherwise: action === "share" ? "hide" : "share",
  };
}

/** One connection on its own access level, reading every source with no filter. */
export async function openFilterConnection(
  harness: SyntheticE2EHarness,
  accesses: readonly FilterAccess[],
): Promise<AuthorizedMcpClient> {
  const name = `Invented filtered agent ${randomUUID().slice(0, 8)}`;
  return authorizeMcpClient(harness, {
    principalName: name,
    grantName: `${name} level`,
    credentialLabel: "Filtered connection",
    capabilities: [...accesses],
    rules: accesses.map((access) =>
      access === "answer"
        ? {
            capability: access,
            sources: { mode: "all" as const, sourceIds: [] },
            release: { mode: "unreviewed" as const },
          }
        : { capability: access, sources: { mode: "all" as const, sourceIds: [] } },
    ),
  });
}

/** The access level a connection's grant is on, as the overview serves it. */
export async function levelFor(harness: SyntheticE2EHarness, client: AuthorizedMcpClient) {
  const overview = await accessOverview(harness.gatewayUrl, client.portal);
  const grant = overview.principals
    .flatMap((principal) => principal.grants)
    .find((candidate) => candidate.id === client.grantId);
  const level = overview.levels?.find((candidate) => candidate.id === grant?.levelId);
  if (!level) throw new Error("The filtered connection has no access level.");
  return level;
}

export interface FilterSet {
  access: FilterAccess;
  policies: SourceFilter[];
}

function levelEdit(level: Awaited<ReturnType<typeof levelFor>>, filters: readonly FilterSet[]) {
  const expectedFilterRevisions: Record<string, number> = {};
  const rules = level.rules.map((served) => {
    const rule = requestRule(served);
    if (rule.capability === "notes") return rule;
    if (rule.filterRevision !== undefined)
      expectedFilterRevisions[rule.capability] = rule.filterRevision;
    const set = filters.find((candidate) => candidate.access === rule.capability);
    return {
      ...rule,
      sources: { mode: "all" as const, sourceIds: [] },
      scopePolicies: (set?.policies ?? []).map((policy) => ({
        ...policy,
        audience: { accessLevel: level.id, capability: rule.capability },
      })),
    };
  });
  return { expectedRevision: level.revision, expectedFilterRevisions, rules };
}

/**
 * Replace the filters of a connection's level, as the portal saves them. A
 * capability absent from `filters` is left with none: it reads all content.
 */
export async function saveFilters(
  harness: SyntheticE2EHarness,
  client: AuthorizedMcpClient,
  filters: readonly FilterSet[],
): Promise<void> {
  const level = await levelFor(harness, client);
  await portalJson(
    harness.gatewayUrl,
    client.portal,
    `/admin/access/levels/${level.id}`,
    levelEdit(level, filters),
    "PATCH",
  );
}

/** {@link saveFilters}, returning the gateway's status and body instead of throwing on a refusal. */
export async function trySaveFilters(
  harness: SyntheticE2EHarness,
  client: AuthorizedMcpClient,
  filters: readonly FilterSet[],
): Promise<{ status: number; body: unknown }> {
  const level = await levelFor(harness, client);
  return portalRequest(
    harness.gatewayUrl,
    client.portal,
    "PATCH",
    `/admin/access/levels/${level.id}`,
    levelEdit(level, filters),
  );
}

export interface FilterContext {
  harness: SyntheticE2EHarness;
  model: ScopeScriptedAgent;
  /** The owner's portal session. */
  portal: PortalSession;
  /** Several Direct connections, each on its own level, share a suite's tool-call load. */
  direct: AuthorizedMcpClient[];
  answer: AuthorizedMcpClient;
  turn: number;
}

/**
 * Registering an OAuth client is rate limited, so a suite opens its
 * connections once and edits their levels' filters for each case: every case
 * then also proves that a saved edit governs the next request of a
 * connection that was already live.
 */
export async function openFilterContext(
  harness: SyntheticE2EHarness,
  model: ScopeScriptedAgent,
): Promise<FilterContext> {
  const direct: AuthorizedMcpClient[] = [];
  for (let index = 0; index < 3; index++)
    direct.push(await openFilterConnection(harness, ["direct"]));
  return {
    harness,
    model,
    portal: await loginPortal(harness),
    direct,
    answer: await openFilterConnection(harness, ["answer"]),
    turn: 0,
  };
}

export async function closeConnection(client: AuthorizedMcpClient | undefined): Promise<void> {
  if (client) await Promise.allSettled([client.client.close(), client.transport.close()]);
}

export async function closeFilterContext(context: FilterContext | undefined): Promise<void> {
  for (const client of [...(context?.direct ?? []), context?.answer]) await closeConnection(client);
}

/** The Direct connection whose turn it is. */
export function nextDirect(context: FilterContext): AuthorizedMcpClient {
  return context.direct[context.turn++ % context.direct.length]!;
}

// ── Direct ──────────────────────────────────────────────────────────────────

/**
 * Each credential has a per-minute budget of Direct tool calls. A suite makes
 * more than a minute's worth on one connection, so calls wait for room
 * instead of spending a refusal that would read as a withheld record.
 */
const DIRECT_CALLS_PER_MINUTE = 100;
/** `fetch_many` takes at most two documents a call. */
const DIRECT_FETCH_BATCH = 2;
const directCallTimes = new WeakMap<AuthorizedMcpClient, number[]>();

export async function callDirect(
  client: AuthorizedMcpClient,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: unknown; structuredContent?: unknown; content?: unknown }> {
  const directCalls = directCallTimes.get(client) ?? [];
  directCallTimes.set(client, directCalls);
  for (;;) {
    const now = Date.now();
    while (directCalls.length && directCalls[0]! <= now - 61_000) directCalls.shift();
    if (directCalls.length < DIRECT_CALLS_PER_MINUTE) break;
    await new Promise((resolve) => setTimeout(resolve, directCalls[0]! + 61_000 - now));
  }
  directCalls.push(Date.now());
  const response = await client.client.callTool({ name, arguments: args });
  expect(JSON.stringify(response.content ?? ""), `${name} was rate limited`).not.toContain(
    "Too many Omnesis",
  );
  return response;
}

/** The ids of the corpus a Direct search returns for the corpus's query. */
export async function directSearchKeys(
  client: AuthorizedMcpClient,
  corpus: FilterCorpus,
  limit = 50,
): Promise<{ keys: string[]; serialized: string }> {
  const response = await callDirect(client, "search_many", {
    queries: [{ query: corpus.query, filters: { sourceIds: [corpus.sourceId] }, limit }],
  });
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
  const serialized = JSON.stringify(response.structuredContent);
  const keys = [...corpus.records.values()]
    .filter((record) => serialized.includes(record.id))
    .map((record) => record.key);
  return { keys, serialized };
}

/**
 * Every Direct read surface agrees on one boundary: search returns the
 * shared records and no other, a fetch by id returns each shared record and
 * refuses each withheld one, a URL lookup finds a shared record and none
 * withheld, and nothing of a withheld record rides along with a result, a
 * neighbour or a refusal.
 *
 * Search returns one record of several that hold the same text (the same
 * file read on two computers), so it is held to every shared text, through
 * shared records only. It draws its candidates from the index's copy of
 * filter details, which follows the corpus on the indexer's cycle; it is
 * asked again until it returns the shared set, and no answer on the way may
 * hold a withheld record.
 */
export async function expectDirectBoundary(
  harness: SyntheticE2EHarness,
  client: AuthorizedMcpClient,
  corpus: FilterCorpus,
  shared: readonly string[],
): Promise<void> {
  const { all, allowed, denied } = partition(corpus, shared);
  const bodies = (keys: readonly string[]) =>
    [...new Set(keys.map((key) => corpus.records.get(key)!.body))].sort();
  const expected = bodies(allowed.map((record) => record.key));
  let found: string[] = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    const search = await directSearchKeys(client, corpus);
    expectNoTrace(search.serialized, denied, "search");
    found = search.keys.sort();
    if (JSON.stringify(bodies(found)) === JSON.stringify(expected)) break;
    await harness.refreshSearchSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  for (const key of found) expect(shared, `search of ${corpus.sourceId}`).toContain(key);
  expect(bodies(found), `search of ${corpus.sourceId}`).toEqual(expected);

  const items: Array<{ kind: string }> = [];
  for (let offset = 0; offset < all.length; offset += DIRECT_FETCH_BATCH) {
    const response = await callDirect(client, "fetch_many", {
      documents: all
        .slice(offset, offset + DIRECT_FETCH_BATCH)
        .map((record) => ({ documentId: record.id, includeNeighbors: true })),
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    items.push(...(response.structuredContent as { items: Array<{ kind: string }> }).items);
  }
  expect(items).toHaveLength(all.length);
  for (const [index, record] of all.entries()) {
    const visible = allowed.includes(record);
    const fetched = JSON.stringify(items[index]);
    expect(items[index]!.kind, `fetch ${record.key}`).toBe(visible ? "document" : "error");
    if (visible) expect(fetched).toContain(record.body);
    // A refusal may name the id it was asked for; nothing else of a withheld
    // record may ride along, and nothing of another withheld record either.
    expectNoTrace(
      fetched,
      denied.filter((other) => other.key === record.key),
      `fetch ${record.key}`,
      { idMayAppear: true },
    );
    expectNoTrace(
      fetched,
      denied.filter((other) => other.key !== record.key),
      `fetch ${record.key}`,
    );
  }

  // Every withheld address is looked up; one shared address proves the lookup works.
  const lookedUp = [
    ...denied.filter((record) => record.url),
    ...allowed.filter((record) => record.url).slice(0, 1),
  ];
  for (const record of lookedUp) {
    const lookup = await callDirect(client, "lookup_document_by_url", { url: record.url });
    const found = JSON.stringify(lookup.structuredContent ?? lookup.content);
    if (allowed.some((candidate) => candidate.key === record.key))
      expect(found, `URL lookup ${record.key}`).toContain(record.id);
    // The reply names the address it was asked for, which may hold the
    // record's external id; nothing else of the record may appear.
    else
      expectNoTrace(
        found.replaceAll(JSON.stringify(record.url).slice(1, -1), ""),
        [record],
        `URL lookup ${record.key}`,
      );
  }
}

// ── Answer ──────────────────────────────────────────────────────────────────

export interface AnswerResult {
  answer: string;
  status: string;
  taskId: string;
}

/** Ask through `ask_omnesis` and wait for the released answer. */
export async function askFiltered(
  client: AuthorizedMcpClient,
  question: string,
): Promise<AnswerResult> {
  const response = await client.client.callTool({
    name: "ask_omnesis",
    arguments: {
      question,
      requestId: randomUUID(),
      workflowName: "Invented filter check",
      workflowPurpose: "Read only the invented records this connection may use.",
    },
  });
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
  let value = response.structuredContent as AnswerResult;
  for (let attempt = 0; attempt < 300 && ["running", "queued"].includes(value.status); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const polled = await client.client.callTool({
      name: "get_answer_status",
      arguments: { taskId: value.taskId },
    });
    expect(polled.isError).not.toBe(true);
    value = polled.structuredContent as AnswerResult;
  }
  expect(value.status).toMatch(/^released/);
  return value;
}

/**
 * The internal agent answering for an external one is confined to the same
 * boundary: its own search returns only shared records, its fetch by id of
 * every record returns only shared ones, no model input ever contains a
 * withheld record, and the released answer — also as re-read from its status
 * — is built from shared records alone.
 */
export async function expectAnswerBoundary(
  model: ScopeScriptedAgent,
  client: AuthorizedMcpClient,
  corpus: FilterCorpus,
  shared: readonly string[],
): Promise<void> {
  const { all, allowed, denied } = partition(corpus, shared);
  const probe = model.register({
    sourceId: corpus.sourceId,
    documentIds: all.map((record) => record.id),
    query: corpus.query,
  });
  const result = await askFiltered(client, probe.question);
  for (const record of allowed)
    expect(result.answer, `answer ${record.key}`).toContain(record.body);
  expectNoTrace(result.answer, denied, "answer");
  expectNoTrace(JSON.stringify(probe.observed.search), denied, "agent search");
  // The scripted agent asks for every id by name, so a refusal may echo it.
  expectNoTrace(JSON.stringify(probe.observed.fetched), denied, "agent fetch", {
    idMayAppear: true,
  });
  const inputs = probe.observed.modelInputs.join("\n");
  for (const record of denied)
    for (const trace of record.traces)
      expect(inputs, `model input ${record.key}`).not.toContain(trace);
  const status = await client.client.callTool({
    name: "get_answer_status",
    arguments: { taskId: result.taskId },
  });
  expectNoTrace(JSON.stringify(status.structuredContent), denied, "answer status");
}

/** Save one filter on the capability's live connection and check its whole boundary. */
export async function expectFilterBoundary(
  context: FilterContext,
  corpus: FilterCorpus,
  access: FilterAccess,
  action: FilterAction | "all",
  match: FilterRef[],
  shared: readonly string[],
): Promise<void> {
  const client = access === "direct" ? nextDirect(context) : context.answer;
  await saveFilters(
    context.harness,
    client,
    action === "all"
      ? []
      : [{ access, policies: [filterPolicy(corpus.sourceId, access, action, match)] }],
  );
  if (access === "direct") await expectDirectBoundary(context.harness, client, corpus, shared);
  else await expectAnswerBoundary(context.model, client, corpus, shared);
}

// ── The owner's editor ──────────────────────────────────────────────────────

export type FilterFieldStatus =
  | { status: "ready" }
  | { status: "needs-resync"; cost: string | null; text: string }
  | { status: "resyncing"; processed: number; total: number | null; text: string }
  | { status: "collector-behind"; devices: Array<{ id: string; name: string }>; text: string }
  | { status: "gateway-behind"; text: string }
  | { status: "list-pending"; text: string };

export interface FilterEditorField {
  field: string;
  capability: "membership" | "tree" | "person";
  noun: { one: string; many: string };
  levels?: Array<{ one: string; many: string }>;
  inside?: { one: string; many: string };
  insideText?: string;
  picker: "search" | "tree";
  scope: "global" | "device";
  identifiers?: FilterIdentifierType[];
  state: FilterFieldStatus;
  counts:
    | { status: "pending" }
    | {
        status: "ready";
        tooOld: number;
        unmatched: number;
        tooOldText: string | null;
        unmatchedText: string | null;
      };
}

export interface FilterEditor {
  sourceId: string;
  sourceType: string;
  devices: Array<{ id: string; name: string }>;
  showDeviceLevel: boolean;
  profile: "declared" | "no-profile" | "collector-behind";
  profileText: string | null;
  fields: FilterEditorField[];
  retryAfterMs?: number;
}

export interface FilterOption {
  ref: FilterRef;
  label: string;
  shortLabel: string;
  count: number | null;
  parentId?: string;
  hasChildren?: boolean;
  depth?: number;
  personId?: string;
}

export interface FilterOptionsPage {
  sourceId: string;
  field: string;
  items: FilterOption[];
  nextCursor?: string;
  retryAfterMs?: number;
}

export type FilterPreview =
  | { status: "pending"; retryAfterMs: number }
  | {
      status: "ready";
      sourceId: string;
      total: number;
      visible: number;
      hidden: number;
      tooOld: number;
      unmatched: number;
      tooOldText: string | null;
      unmatchedText: string | null;
      items: Array<{ ref: FilterRef; label: string; count: number; missing?: boolean }>;
    };

const sourcePath = (sourceId: string) =>
  `/admin/access/source-filters/${encodeURIComponent(sourceId)}`;

async function untilSettled<T extends { retryAfterMs?: number }>(
  read: () => Promise<T>,
  what: string,
): Promise<T> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const value = await read();
    if (value.retryAfterMs === undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, Math.min(value.retryAfterMs!, 500)));
  }
  throw new Error(`${what} never settled`);
}

/** The editor of one account, asked again until no count is pending. */
export async function filterEditor(
  harness: SyntheticE2EHarness,
  portal: PortalSession,
  sourceId: string,
): Promise<FilterEditor> {
  return untilSettled(
    () => portalJson<FilterEditor>(harness.gatewayUrl, portal, sourcePath(sourceId)),
    `The editor of ${sourceId}`,
  );
}

/** One page of a field's entries, asked again until every count is in. */
export async function filterOptions(
  harness: SyntheticE2EHarness,
  portal: PortalSession,
  sourceId: string,
  query: { field: string; q?: string; parentId?: string; device?: string; cursor?: string },
): Promise<FilterOptionsPage> {
  const params = new URLSearchParams(
    Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return untilSettled(
    () =>
      portalJson<FilterOptionsPage>(
        harness.gatewayUrl,
        portal,
        `${sourcePath(sourceId)}/options?${params}`,
      ),
    `The ${query.field} entries of ${sourceId}`,
  );
}

/**
 * Walk a field's tree from its top level down the given short names, as a
 * person opening it would, and return the last entry.
 */
export async function pickTreePath(
  harness: SyntheticE2EHarness,
  portal: PortalSession,
  sourceId: string,
  field: string,
  names: readonly string[],
  device?: string,
): Promise<FilterOption> {
  let parentId: string | undefined;
  let current: FilterOption | undefined;
  for (const name of names) {
    const page = await filterOptions(harness, portal, sourceId, { field, parentId, device });
    current = page.items.find((item) => item.shortLabel === name || item.label === name);
    if (!current)
      throw new Error(
        `No ${name} in ${parentId ?? "the top level"} of ${sourceId}: ` +
          page.items.map((item) => item.label).join(", "),
      );
    if (current.ref.capability === "person") throw new Error("A tree holds no person.");
    parentId = current.ref.id === "" ? undefined : current.ref.id;
    if (current.ref.id === "") device = current.ref.device;
  }
  if (!current) throw new Error("An empty path picks nothing.");
  return current;
}

/** The entry the editor's person list offers for a search, by one identifier it carries. */
export async function pickPerson(
  harness: SyntheticE2EHarness,
  portal: PortalSession,
  sourceId: string,
  query: string,
  identifier: string,
): Promise<FilterOption> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const page = await filterOptions(harness, portal, sourceId, { field: "$people", q: query });
    const picked = page.items.find(
      (item) =>
        item.ref.capability === "person" &&
        item.ref.identifiers.some((candidate) => candidate.value === identifier),
    );
    if (picked) return picked;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The person list of ${sourceId} never offered ${identifier} for "${query}"`);
}

/** The preview of a draft filter, sent again until it is counted. */
export async function filterPreview(
  harness: SyntheticE2EHarness,
  portal: PortalSession,
  policy: SourceFilter,
): Promise<Extract<FilterPreview, { status: "ready" }>> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const preview = await portalJson<FilterPreview>(
      harness.gatewayUrl,
      portal,
      `${sourcePath(policy.sourceId)}/preview`,
      { policy },
    );
    if (preview.status === "ready") return preview;
    await new Promise((resolve) => setTimeout(resolve, Math.min(preview.retryAfterMs, 500)));
  }
  throw new Error(`The preview of a filter on ${policy.sourceId} never settled`);
}

/** A typed phone number, address or domain, read by the gateway as a filter entry holds it. */
export async function typedIdentifier(
  harness: SyntheticE2EHarness,
  portal: PortalSession,
  type: FilterIdentifierType,
  value: string,
): Promise<{ identifier: FilterIdentifier } | { error: string }> {
  return portalJson(harness.gatewayUrl, portal, "/admin/access/source-filters/identifiers", {
    type,
    value,
  });
}

/** A person entry from identifiers typed by the owner, each read by the gateway. */
export async function typedPerson(
  harness: SyntheticE2EHarness,
  portal: PortalSession,
  label: string,
  typed: ReadonlyArray<[FilterIdentifierType, string]>,
): Promise<FilterRef> {
  const identifiers: FilterIdentifier[] = [];
  for (const [type, value] of typed) {
    const read = await typedIdentifier(harness, portal, type, value);
    if (!("identifier" in read)) throw new Error(`"${value}" was refused: ${read.error}`);
    identifiers.push(read.identifier);
  }
  return { capability: "person", label, identifiers };
}
