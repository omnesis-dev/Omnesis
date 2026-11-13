// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { expect } from "vitest";
import {
  authorizeMcpClient,
  portalJson,
  requestRule,
  type AuthorizedMcpClient,
} from "./mcp-oauth-helper.js";
import { askScoped, levelFor } from "./source-scope-external-helpers.js";
import { prepareScopeSearch } from "./source-scope-fixtures.js";
import type { ScopeScriptedAgent } from "./scope-scripted-agent.js";
import type { SyntheticE2EHarness, PushDocumentInput } from "./synth-harness.js";
import type { DocumentMetadata, ScopePolicy, ScopeRef } from "@omnesis/types";

/** Every invented record carries this word, so one query reaches the whole account. */
export const FILTER_QUERY = "zqfilter";
const URL_BASE = "https://example.org/zqfilter";

export interface FilterAccount<TType extends string = string> {
  type: TType;
  sourceId: string;
  providerId: string;
}
export interface FilterRecordInput {
  key: string;
  documentType: string;
  metadata?: DocumentMetadata;
  /** The record this one is an attachment of. */
  attachmentOf?: string;
}
export interface FilterRecord {
  key: string;
  id: string;
  externalId: string;
  title: string;
  body: string;
  url?: string;
}
export type FilterCorpus = Map<string, FilterRecord>;
export type FilterCapability = "direct" | "answer";
export type FilterAction = "share" | "hide";

const marker = (key: string) => key.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_");

/**
 * An empty account of a real source type beside the universe's own, so a test
 * can state the exact set of records a filter leaves. It is added the way the
 * portal adds one, on the device that hosts the universe's account of the type.
 */
export async function createFilterAccount(
  harness: SyntheticE2EHarness,
  type: string,
  accountId: string,
): Promise<FilterAccount> {
  const seeded = harness.getSourceIds().find((id) => id.startsWith(`${type}:`));
  if (!seeded) throw new Error(`Missing synthetic source ${type}`);
  await harness.triggerSyncAndWait(seeded);
  const reader = new Database(harness.getDbPath(), { readonly: true });
  let providerId: string;
  let deviceId: string;
  try {
    const row = reader
      .prepare<[string], { provider_id: string; device_id: string }>(
        `SELECT d.provider_id, s.device_id FROM documents d JOIN sources s ON s.id=d.source_id
         WHERE d.source_id=? LIMIT 1`,
      )
      .get(seeded);
    if (!row) throw new Error(`Synthetic source ${type} produced no documents`);
    providerId = row.provider_id;
    deviceId = row.device_id;
  } finally {
    reader.close();
  }
  await harness.gatewayJson("/admin/sources", {
    method: "POST",
    body: JSON.stringify({ type, accountId, deviceId, enabled: false }),
  });
  return { type, sourceId: `${type}:${accountId}`, providerId };
}

/** Push invented records; each has a title and a body no other record shares. */
export async function pushFilterRecords(
  harness: SyntheticE2EHarness,
  account: FilterAccount,
  records: readonly FilterRecordInput[],
): Promise<FilterCorpus> {
  const external = (key: string) => `${FILTER_QUERY}-${key}`;
  const inputs: PushDocumentInput[] = records.map((record) => {
    const externalId = record.attachmentOf
      ? `${external(record.attachmentOf)}/att/${record.key}`
      : external(record.key);
    return {
      sourceId: account.sourceId,
      providerId: account.providerId,
      externalId,
      title: `${FILTER_QUERY} TITLE_${marker(record.key)}`,
      content: `${FILTER_QUERY} invented record BODY_${marker(record.key)}`,
      metadata: {
        documentType: record.documentType,
        ...(record.attachmentOf
          ? { extra: { parentExternalId: external(record.attachmentOf), mimeType: "text/plain" } }
          : { sourceUrl: `${URL_BASE}/${account.type}/${record.key}` }),
        ...record.metadata,
      },
    };
  });
  await harness.pushDocuments(inputs);
  const corpus: FilterCorpus = new Map();
  const reader = new Database(harness.getDbPath(), { readonly: true });
  try {
    for (const [index, record] of records.entries()) {
      const input = inputs[index]!;
      const row = reader
        .prepare<[string, string], { id: string }>(
          "SELECT id FROM documents WHERE source_id=? AND external_id=?",
        )
        .get(account.sourceId, input.externalId!);
      if (!row) throw new Error(`Missing invented record ${record.key}`);
      corpus.set(record.key, {
        key: record.key,
        id: row.id,
        externalId: input.externalId!,
        title: `TITLE_${marker(record.key)}`,
        body: `BODY_${marker(record.key)}`,
        ...(record.attachmentOf ? {} : { url: `${URL_BASE}/${account.type}/${record.key}` }),
      });
    }
  } finally {
    reader.close();
  }
  return corpus;
}

export async function readyFilterAccounts(
  harness: SyntheticE2EHarness,
  accounts: readonly FilterAccount[],
): Promise<void> {
  await prepareScopeSearch(harness, accounts);
}

export function filterPolicy(
  account: FilterAccount,
  capability: FilterCapability,
  action: FilterAction,
  match: ScopeRef[],
): ScopePolicy {
  return {
    sourceId: account.sourceId,
    audience: { accessLevel: "new", capability },
    rules: [{ match, action }],
    otherwise: action === "share" ? "hide" : "share",
  };
}

export interface FilterSet {
  capability: FilterCapability;
  policies: ScopePolicy[];
}

/**
 * One connection on its own access level. Registering an OAuth client is rate
 * limited, so a suite opens a connection once and edits its level's filters
 * for each case: every case then also proves that a saved edit governs the
 * next request of a connection that was already live.
 */
export async function openFilterConnection(
  harness: SyntheticE2EHarness,
  capabilities: readonly FilterCapability[],
): Promise<AuthorizedMcpClient> {
  const name = `Invented filtered agent ${randomUUID().slice(0, 8)}`;
  return authorizeMcpClient(harness, {
    principalName: name,
    grantName: `${name} level`,
    credentialLabel: "Filtered connection",
    capabilities: [...capabilities],
    rules: capabilities.map((capability) =>
      capability === "answer"
        ? {
            capability,
            sources: { mode: "all" as const, sourceIds: [] },
            release: { mode: "unreviewed" as const },
          }
        : { capability, sources: { mode: "all" as const, sourceIds: [] } },
    ),
  });
}

/** Replace the level's filters through the portal's API; a refused save rejects with its reason. */
export async function saveFilters(
  harness: SyntheticE2EHarness,
  client: AuthorizedMcpClient,
  filters: readonly FilterSet[],
): Promise<void> {
  const level = await levelFor(harness, client);
  const expectedFilterRevisions: Record<string, number> = {};
  const rules = level.rules.map((served) => {
    const rule = requestRule(served);
    if (rule.capability === "notes") return rule;
    if (rule.filterRevision !== undefined)
      expectedFilterRevisions[rule.capability] = rule.filterRevision;
    const filter = filters.find((candidate) => candidate.capability === rule.capability);
    return {
      ...rule,
      sources: { mode: "all" as const, sourceIds: [] },
      scopePolicies: (filter?.policies ?? []).map((policy) => ({
        ...policy,
        audience: { accessLevel: level.id, capability: rule.capability },
      })),
    };
  });
  await portalJson(
    harness.gatewayUrl,
    client.portal,
    `/admin/access/levels/${level.id}`,
    { expectedRevision: level.revision, expectedFilterRevisions, rules },
    "PATCH",
  );
}

function partition(corpus: FilterCorpus, shared: readonly string[]) {
  for (const key of shared) if (!corpus.has(key)) throw new Error(`Unknown record ${key}`);
  const all = [...corpus.values()];
  return {
    all,
    allowed: all.filter((record) => shared.includes(record.key)),
    denied: all.filter((record) => !shared.includes(record.key)),
  };
}
function expectNoTrace(serialized: string, denied: readonly FilterRecord[], surface: string) {
  for (const record of denied) {
    for (const trace of [record.id, record.body, record.title, record.externalId])
      expect(serialized, `${surface} leaked ${record.key}`).not.toContain(trace);
  }
}

/**
 * Each credential has a per-minute budget of Direct tool calls. A suite makes
 * more than a minute's worth on one connection, so calls wait for room instead
 * of spending a refusal that would read as a withheld record.
 */
const DIRECT_CALLS_PER_MINUTE = 100;
const DIRECT_FETCH_BATCH = 2;
const directCallTimes = new WeakMap<AuthorizedMcpClient, number[]>();
async function callDirect(
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

/**
 * Every Direct read surface agrees on one boundary: search returns exactly the
 * shared records, and a withheld record's id, title, body and source address
 * appear nowhere — not in a result, a neighbour, a fetch by id or a URL lookup.
 */
export async function expectDirectBoundary(
  harness: SyntheticE2EHarness,
  client: AuthorizedMcpClient,
  account: FilterAccount,
  corpus: FilterCorpus,
  shared: readonly string[],
): Promise<void> {
  const { all, allowed, denied } = partition(corpus, shared);
  let search = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await callDirect(client, "search_many", {
      queries: [{ query: FILTER_QUERY, filters: { sourceIds: [account.sourceId] }, limit: 50 }],
    });
    expect(response.isError).not.toBe(true);
    search = JSON.stringify(response.structuredContent);
    if (allowed.every((record) => search.includes(record.id))) break;
    await harness.refreshSearchSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  expect(
    all.filter((record) => search.includes(record.id)).map((record) => record.key),
    "search results",
  ).toEqual(allowed.map((record) => record.key));
  expectNoTrace(search, denied, "search");
  const items: Array<{ kind: string }> = [];
  for (let offset = 0; offset < all.length; offset += DIRECT_FETCH_BATCH) {
    const response = await callDirect(client, "fetch_many", {
      documents: all
        .slice(offset, offset + DIRECT_FETCH_BATCH)
        .map((record) => ({ documentId: record.id, includeNeighbors: true })),
    });
    expect(response.isError).not.toBe(true);
    items.push(...(response.structuredContent as { items: Array<{ kind: string }> }).items);
  }
  expect(items).toHaveLength(all.length);
  // Every withheld address is looked up; one shared address proves the lookup works.
  const lookedUp = new Set([...denied, ...allowed.filter((record) => record.url).slice(0, 1)]);
  for (const [index, record] of all.entries()) {
    const visible = allowed.includes(record);
    const fetched = JSON.stringify(items[index]);
    expect(items[index]!.kind, `fetch ${record.key}`).toBe(visible ? "document" : "error");
    if (visible) expect(fetched).toContain(record.body);
    else {
      expect(fetched).not.toContain(record.body);
      expect(fetched).not.toContain(record.title);
    }
    // A refusal may name the id it was asked for; nothing else of a withheld
    // record may ride along with a neighbour or a parent.
    expectNoTrace(
      fetched,
      denied.filter((other) => other !== record),
      `fetch ${record.key}`,
    );
    if (!record.url || !lookedUp.has(record)) continue;
    const lookup = await callDirect(client, "lookup_document_by_url", { url: record.url });
    const found = JSON.stringify(lookup.structuredContent ?? lookup.content);
    if (visible) expect(found, `URL lookup ${record.key}`).toContain(record.id);
    else {
      expect(found, `URL lookup ${record.key}`).not.toContain(record.id);
      expect(found).not.toContain(record.body);
      expect(found).not.toContain(record.title);
    }
  }
}

/**
 * One look through Direct at a moment the boundary is still forming — facts
 * for stored records are arriving — when the set a filter leaves is not yet
 * the one it will settle on. Whatever the moment, a record the settled filter
 * withholds shows nowhere: not in search, not fetched by id. Returns the keys
 * search returned.
 */
export async function expectNoDirectLeak(
  client: AuthorizedMcpClient,
  account: FilterAccount,
  corpus: FilterCorpus,
  shared: readonly string[],
): Promise<string[]> {
  const { all, denied } = partition(corpus, shared);
  const response = await callDirect(client, "search_many", {
    queries: [{ query: FILTER_QUERY, filters: { sourceIds: [account.sourceId] }, limit: 50 }],
  });
  expect(response.isError).not.toBe(true);
  const search = JSON.stringify(response.structuredContent);
  expectNoTrace(search, denied, "search");
  for (let offset = 0; offset < denied.length; offset += DIRECT_FETCH_BATCH) {
    const batch = denied.slice(offset, offset + DIRECT_FETCH_BATCH);
    const fetched = await callDirect(client, "fetch_many", {
      documents: batch.map((record) => ({ documentId: record.id, includeNeighbors: true })),
    });
    expect(fetched.isError).not.toBe(true);
    const items = (fetched.structuredContent as { items: Array<{ kind: string }> }).items;
    for (const [index, record] of batch.entries()) {
      expect(items[index]!.kind, `fetch ${record.key}`).toBe("error");
      expect(JSON.stringify(items[index])).not.toContain(record.body);
      expect(JSON.stringify(items[index])).not.toContain(record.title);
    }
  }
  return all.filter((record) => search.includes(record.id)).map((record) => record.key);
}

/**
 * The internal agent answering for an external one is confined to the same
 * boundary: its own search and fetch tools return only shared records, no
 * model input ever contains a withheld one, and the released answer — also as
 * re-read from answer history — is built from shared records alone.
 */
export async function expectAnswerBoundary(
  model: ScopeScriptedAgent,
  client: AuthorizedMcpClient,
  account: FilterAccount,
  corpus: FilterCorpus,
  shared: readonly string[],
): Promise<void> {
  const { all, allowed, denied } = partition(corpus, shared);
  const probe = model.register({
    sourceId: account.sourceId,
    documentIds: all.map((record) => record.id),
    query: FILTER_QUERY,
  });
  const result = await askScoped(client, probe.question);
  for (const record of allowed)
    expect(result.answer, `answer ${record.key}`).toContain(record.body);
  expectNoTrace(result.answer, denied, "answer");
  expectNoTrace(JSON.stringify(probe.observed.search), denied, "agent search");
  expectNoTrace(
    JSON.stringify(probe.observed.fetched),
    denied.map(withoutRequestedId),
    "agent fetch",
  );
  for (const record of denied) {
    expect(probe.observed.modelInputs.join("\n"), `model input ${record.key}`).not.toContain(
      record.body,
    );
    expect(probe.observed.modelInputs.join("\n")).not.toContain(record.title);
  }
  const history = await client.client.callTool({
    name: "get_answer_status",
    arguments: { taskId: result.taskId },
  });
  expectNoTrace(JSON.stringify(history.structuredContent), denied, "answer history");
}
/** The scripted agent asks for every id by name, so a refusal may echo the id it was given. */
function withoutRequestedId(record: FilterRecord): FilterRecord {
  return { ...record, id: record.body };
}

export interface FilterContext {
  harness: SyntheticE2EHarness;
  model: ScopeScriptedAgent;
  /** Several Direct connections, each on its own level, share the suite's tool-call load. */
  direct: AuthorizedMcpClient[];
  answer: AuthorizedMcpClient;
  turn: number;
}

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
    direct,
    answer: await openFilterConnection(harness, ["answer"]),
    turn: 0,
  };
}

export async function closeFilterContext(context: FilterContext | undefined): Promise<void> {
  for (const client of [...(context?.direct ?? []), context?.answer])
    if (client) await Promise.allSettled([client.client.close(), client.transport.close()]);
}

/** The Direct connection whose turn it is. */
export function nextDirect(context: FilterContext): AuthorizedMcpClient {
  return context.direct[context.turn++ % context.direct.length]!;
}

/** Save one filter on the capability's live connection and check its whole boundary. */
export async function expectFilterBoundary(
  context: FilterContext,
  account: FilterAccount,
  corpus: FilterCorpus,
  capability: FilterCapability,
  action: FilterAction,
  match: ScopeRef[],
  shared: readonly string[],
): Promise<void> {
  const client = capability === "direct" ? nextDirect(context) : context.answer;
  await saveFilters(context.harness, client, [
    { capability, policies: [filterPolicy(account, capability, action, match)] },
  ]);
  if (capability === "direct")
    await expectDirectBoundary(context.harness, client, account, corpus, shared);
  else await expectAnswerBoundary(context.model, client, account, corpus, shared);
}

/**
 * The entry the editor's person list offers for a search, as the portal and
 * the apps read it: a snapshot of the addresses the people index holds, which
 * the gateway wrote from the same mentions a source declared.
 */
export async function pickPerson(
  harness: SyntheticE2EHarness,
  client: AuthorizedMcpClient,
  account: FilterAccount,
  query: string,
  identifier: string,
): Promise<{ ref: ScopeRef; count: number }> {
  const path = `/admin/access/source-filters/${encodeURIComponent(account.sourceId)}/options?kind=participant&q=${encodeURIComponent(query)}`;
  for (let attempt = 0; attempt < 40; attempt++) {
    const options = await portalJson<{ items: Array<{ ref: ScopeRef; count: number }> }>(
      harness.gatewayUrl,
      client.portal,
      path,
    );
    const picked = options.items.find(
      (item) =>
        item.ref.kind === "participant" &&
        item.ref.identifiers.some((candidate) => candidate.value === identifier),
    );
    if (picked) return picked;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The person list never offered ${query}`);
}
