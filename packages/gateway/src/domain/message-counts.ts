// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `countMessagesByPerson` — the read half of the agent's `count_messages`
 * tool: how many messages the user exchanged with each person over a window,
 * across every messaging source.
 *
 * Ranking people by search hits samples the corpus: a chat that rolls a day's
 * hundred messages into one document is one hit, the same as a day with one
 * message. This counts every message document in the window instead.
 *
 * What counts is decided without naming any source:
 *
 * - A message document is one whose `documentType` is `email` or
 *   `conversation` — the same source-agnostic channel split
 *   `lookup_people` reports.
 * - The people it was exchanged with are those on it as sender, recipient or
 *   participant, resolved through merges, minus the user. Mentions are not
 *   communication and never count.
 * - How many messages a document holds, and whether it is a group
 *   conversation, are read from the fields its source's published
 *   `documentEventProfile` marks with `semantics`. A document from a source
 *   that declares no count is one message.
 *
 * A group conversation's messages are shared by the group, not exchanged with
 * any one member, so they are reported apart from each person's own count. A
 * document that rolls up several messages is a group whenever more than one
 * other person takes part, whatever its group field says, so a group whose
 * metadata never arrived still cannot credit its whole day to every member.
 *
 * Reads only, serializable output: it runs on the gateway's read-worker pool
 * (`io.messageCounts`) or, absent one, on the calling thread.
 */

import { sourceTypeOf } from "@omnesis/types";
import { listSourceDocumentProfiles } from "../data/repositories/SourceDocumentProfileRepository.js";
import type { MessageCountPerson, MessageCountSource, MessageCountsBody } from "@omnesis/agent";
import type { DocumentEventProfile } from "@omnesis/source-sdk";
import type Database from "better-sqlite3";

type Db = Database.Database;

/** Document types whose documents are messages exchanged with people. */
const MESSAGE_DOCUMENT_TYPES = ["email", "conversation"] as const;

/** Roles that place a person in the exchange; `mentioned` and the rest do not. */
const EXCHANGE_ROLES = ["sender", "recipient", "participant"] as const;

/** How deep a merge chain is followed before it is treated as its last member. */
const MAX_MERGE_HOPS = 16;

/** SQLite's bound-parameter ceiling is far above this; it keeps one statement small. */
const PERSON_BATCH = 500;

export interface MessageCountsQuery {
  /** Inclusive window start, an ISO instant. */
  fromIso: string;
  /** Exclusive window end, an ISO instant. */
  toExclusiveIso: string;
  /** Restrict to these sources; every source when absent. */
  sourceIds?: readonly string[];
  /** How many people to return, most messaged first. */
  limit: number;
}

/**
 * Where a source's documents declare their message count and group flag, as
 * SQLite JSON paths. A path reaches SQLite only as a bound parameter.
 */
interface MessageFields {
  countPath?: string;
  groupPath?: string;
}

function messageFieldsOf(profile: DocumentEventProfile): MessageFields {
  const fields: MessageFields = {};
  for (const field of profile.metadataFields ?? []) {
    if (field.semantics === "message-count") fields.countPath = `$.${field.path}`;
    if (field.semantics === "group-conversation") fields.groupPath = `$.${field.path}`;
  }
  return fields;
}

interface PersonRow {
  id: string;
  canonical_name: string;
  merged_into: string | null;
  is_self: number;
}

/**
 * Resolve each person id to the head of its merge chain, and note which heads
 * are the user. Only the ids actually seen are read, a batch at a time.
 */
function resolvePeople(
  db: Db,
  ids: Iterable<string>,
): Map<string, { headId: string; name: string; self: boolean }> {
  const rows = new Map<string, PersonRow>();
  const select = (batch: string[]): PersonRow[] =>
    db
      .prepare<string[], PersonRow>(
        `SELECT id, canonical_name, merged_into, is_self FROM people
         WHERE id IN (${batch.map(() => "?").join(", ")})`,
      )
      .all(...batch);
  let pending = [...new Set(ids)];
  for (let hop = 0; pending.length > 0 && hop <= MAX_MERGE_HOPS; hop++) {
    const next: string[] = [];
    for (let i = 0; i < pending.length; i += PERSON_BATCH) {
      for (const row of select(pending.slice(i, i + PERSON_BATCH))) {
        rows.set(row.id, row);
        if (row.merged_into && !rows.has(row.merged_into)) next.push(row.merged_into);
      }
    }
    pending = [...new Set(next)];
  }

  const resolved = new Map<string, { headId: string; name: string; self: boolean }>();
  for (const id of rows.keys()) {
    let row = rows.get(id)!;
    let self = row.is_self === 1;
    for (let hop = 0; row.merged_into && hop < MAX_MERGE_HOPS; hop++) {
      const parent = rows.get(row.merged_into);
      if (!parent) break;
      row = parent;
      self ||= row.is_self === 1;
    }
    resolved.set(id, { headId: row.id, name: row.canonical_name, self });
  }
  // A merged-away member of the user's class is the user too.
  const selfHeads = new Set([...resolved.values()].filter((r) => r.self).map((r) => r.headId));
  for (const entry of resolved.values()) {
    if (selfHeads.has(entry.headId)) entry.self = true;
  }
  return resolved;
}

interface ExchangeRow {
  id: string;
  source_id: string;
  source_created_at: string;
  person_id: string;
  role: string;
}

interface MessageDocument {
  sourceId: string;
  createdAt: string;
  people: Array<{ personId: string; role: string }>;
}

interface Tally {
  messages: number;
  groupMessages: number;
  documents: number;
  sentByYou: number;
  sentByThem: number;
  sourceIds: Set<string>;
  lastAt: string;
}

export function countMessagesByPerson(db: Db, query: MessageCountsQuery): MessageCountsBody {
  const fieldsBySourceType = new Map<string, MessageFields>();
  for (const entry of listSourceDocumentProfiles(db)) {
    fieldsBySourceType.set(entry.sourceType, messageFieldsOf(entry.profile));
  }

  const sourceFilter =
    query.sourceIds && query.sourceIds.length > 0
      ? `AND d.source_id IN (${query.sourceIds.map(() => "?").join(", ")})`
      : "";
  const rows = db
    .prepare<unknown[], ExchangeRow>(
      `SELECT d.id, d.source_id, d.source_created_at, dp.person_id, dp.role
       FROM documents d
       JOIN document_people dp ON dp.document_id = d.id
       WHERE d.source_created_at >= ? AND d.source_created_at < ?
         AND json_extract(d.metadata, '$.documentType') IN (${MESSAGE_DOCUMENT_TYPES.map(() => "?").join(", ")})
         AND dp.role IN (${EXCHANGE_ROLES.map(() => "?").join(", ")})
         ${sourceFilter}`,
    )
    .all(
      query.fromIso,
      query.toExclusiveIso,
      ...MESSAGE_DOCUMENT_TYPES,
      ...EXCHANGE_ROLES,
      ...(query.sourceIds ?? []),
    );

  const documents = new Map<string, MessageDocument>();
  for (const row of rows) {
    const doc = documents.get(row.id) ?? {
      sourceId: row.source_id,
      createdAt: row.source_created_at,
      people: [],
    };
    doc.people.push({ personId: row.person_id, role: row.role });
    documents.set(row.id, doc);
  }

  const people = resolvePeople(
    db,
    rows.map((r) => r.person_id),
  );
  const selfKnown = [...people.values()].some((p) => p.self);
  const readFields = db.prepare<
    { countPath: string | null; groupPath: string | null; id: string },
    { count: unknown; grouped: unknown }
  >(
    `SELECT CASE WHEN @countPath IS NULL THEN NULL ELSE json_extract(metadata, @countPath) END AS count,
            CASE WHEN @groupPath IS NULL THEN NULL ELSE json_extract(metadata, @groupPath) END AS grouped
     FROM documents WHERE id = @id`,
  );

  const tallies = new Map<string, Tally>();
  const sources = new Map<string, MessageCountSource>();

  for (const [documentId, doc] of documents) {
    // The other people in the exchange, each with the roles they hold on it.
    const counterparts = new Map<string, Set<string>>();
    let selfSent = false;
    for (const { personId, role } of doc.people) {
      const person = people.get(personId);
      if (!person) continue;
      if (person.self) {
        if (role === "sender") selfSent = true;
        continue;
      }
      const roles = counterparts.get(person.headId) ?? new Set<string>();
      roles.add(role);
      counterparts.set(person.headId, roles);
    }
    if (counterparts.size === 0) continue;

    const fields = fieldsBySourceType.get(sourceTypeOf(doc.sourceId)) ?? {};
    const rollsUp = fields.countPath !== undefined;
    const declared =
      fields.countPath || fields.groupPath
        ? readFields.get({
            countPath: fields.countPath ?? null,
            groupPath: fields.groupPath ?? null,
            id: documentId,
          })
        : undefined;
    const count = declared?.count;
    const messages = rollsUp
      ? typeof count === "number" && Number.isFinite(count) && count > 0
        ? count
        : 0
      : 1;
    // SQLite's json_extract reads a JSON `true` as the integer 1.
    const group = declared?.grouped === 1 || (rollsUp && counterparts.size > 1);

    const source = sources.get(doc.sourceId) ?? {
      sourceId: doc.sourceId,
      documents: 0,
      messages: 0,
      countedPer: rollsUp ? ("declared-count" as const) : ("document" as const),
    };
    source.documents += 1;
    source.messages += messages;
    sources.set(doc.sourceId, source);

    for (const [personId, roles] of counterparts) {
      const tally = tallies.get(personId) ?? {
        messages: 0,
        groupMessages: 0,
        documents: 0,
        sentByYou: 0,
        sentByThem: 0,
        sourceIds: new Set<string>(),
        lastAt: doc.createdAt,
      };
      if (group) tally.groupMessages += messages;
      else tally.messages += messages;
      tally.documents += 1;
      // Direction is known only where the source records a sender.
      if (roles.has("sender")) tally.sentByThem += messages;
      else if (selfSent) tally.sentByYou += messages;
      tally.sourceIds.add(doc.sourceId);
      if (doc.createdAt > tally.lastAt) tally.lastAt = doc.createdAt;
      tallies.set(personId, tally);
    }
  }

  const ranked: MessageCountPerson[] = [...tallies.entries()]
    .map(([personId, t]) => ({
      personId,
      name: people.get(personId)?.name ?? personId,
      messages: t.messages,
      groupMessages: t.groupMessages,
      documents: t.documents,
      sentByYou: t.sentByYou,
      sentByThem: t.sentByThem,
      sourceIds: [...t.sourceIds].sort(),
      lastAt: t.lastAt,
    }))
    .sort(
      (a, b) =>
        b.messages - a.messages ||
        b.groupMessages - a.groupMessages ||
        b.documents - a.documents ||
        a.name.localeCompare(b.name),
    );

  return {
    people: ranked.slice(0, query.limit),
    totalPeople: ranked.length,
    truncated: ranked.length > query.limit,
    sources: [...sources.values()].sort((a, b) => b.messages - a.messages),
    selfKnown,
  };
}
