// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { basename } from "node:path";
import {
  cleanPersonName,
  computeContentHash,
  countryNameToISO2,
  createLogger,
  normalizePhone,
} from "@omnesis/core";
import { historyCoverage } from "./coverage.js";
import {
  cutoffMs,
  fingerprint,
  groupRows,
  planPage,
  storeUnavailablePage,
  utcDay,
  utcTime,
  type OmatelCursor,
} from "./group-sync.js";
import { OMATEL_MESSAGES_TABLE } from "./schemas.js";
import { MESSAGES_STORE, openStore } from "./store.js";
import type { DocumentInput, PersonMention, ProviderId, SourceId } from "@omnesis/types";
import type { StructuredSyncResult } from "@omnesis/source-sdk";

const log = createLogger("source:omatel-messages");

/** Bump when a conversation-day document's rendering changes. */
export const MESSAGES_RENDER_VERSION = 1;

const PAGE_GROUPS = 100;

/** One message joined with its conversation. Times are epoch milliseconds. */
export interface MessageRow {
  id: number;
  conversation_id: number;
  address: string;
  title: string;
  direction: string;
  transport: string;
  sender: string;
  body: string;
  at: number;
  state: string;
}

export interface PartRow {
  message_id: number;
  mime: string;
  file: string;
}

export interface MessagesSnapshot {
  messages: MessageRow[];
  /** Each conversation's member numbers, by conversation id. */
  participants: Map<number, string[]>;
  /** Each message's attachments, by message id. */
  parts: Map<number, PartRow[]>;
}

export interface MessagesSyncOptions {
  dataDir: string;
  sourceId: SourceId;
  providerId: ProviderId;
  dataCutoff?: string;
  /** ISO 3166 region for numbers omatel could not normalize to E.164. */
  phoneRegion?: string;
}

export function readMessages(dataDir: string, dataCutoff?: string): MessagesSnapshot | null {
  const db = openStore(dataDir, MESSAGES_STORE);
  if (!db) return null;
  try {
    // One read transaction, so messages, members and parts are one snapshot
    // even while the agent stores an incoming text.
    return db.transaction(() => {
      const messages = db
        .prepare(
          `SELECT m.id, m.conversation_id, c.address, c.title, m.direction, m.transport,
                  m.sender, m.body, m.at, m.state
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE m.at >= ?
           ORDER BY c.address, m.at, m.id`,
        )
        .all(cutoffMs(dataCutoff)) as MessageRow[];
      const participants = new Map<number, string[]>();
      for (const p of db
        .prepare("SELECT conversation_id, number FROM participants ORDER BY conversation_id, id")
        .all() as { conversation_id: number; number: string }[]) {
        const list = participants.get(p.conversation_id);
        if (list) list.push(p.number);
        else participants.set(p.conversation_id, [p.number]);
      }
      const parts = new Map<number, PartRow[]>();
      for (const part of db
        .prepare("SELECT message_id, mime, file FROM parts ORDER BY message_id, id")
        .all() as PartRow[]) {
        const list = parts.get(part.message_id);
        if (list) list.push(part);
        else parts.set(part.message_id, [part]);
      }
      return { messages, participants, parts };
    })();
  } finally {
    db.close();
  }
}

function phoneOf(raw: string, region?: string): string | undefined {
  if (!raw) return undefined;
  return normalizePhone(raw, countryNameToISO2(region)) ?? undefined;
}

/** A conversation title worth using as a name: set, and not just a number. */
function displayName(title: string): string | undefined {
  const t = cleanPersonName(title.trim());
  if (!t || /^[+\d\s().-]+$/.test(t)) return undefined;
  return t;
}

function attachmentLabel(mime: string): string {
  if (mime.startsWith("image/")) return "Image";
  if (mime.startsWith("video/")) return "Video";
  if (mime.startsWith("audio/")) return "Audio";
  if (mime === "text/vcard" || mime === "text/x-vcard") return "Contact";
  return "Attachment";
}

/** The notes that follow an outgoing message that has not simply been sent. */
const OUTGOING_STATE_NOTES: Record<string, string> = {
  sending: " _(sending)_",
  failed: " _(not sent)_",
};

/** Members of a conversation: its participants, or its address when none are listed. */
function membersOf(first: MessageRow, snapshot: MessagesSnapshot): string[] {
  const listed = snapshot.participants.get(first.conversation_id);
  return listed && listed.length > 0 ? listed : [first.address];
}

export function buildConversationDay(
  day: string,
  rows: readonly MessageRow[],
  snapshot: MessagesSnapshot,
  opts: Pick<MessagesSyncOptions, "sourceId" | "providerId" | "phoneRegion">,
): DocumentInput {
  const first = rows[0]!;
  const members = membersOf(first, snapshot);
  const isGroup = members.length > 1;
  const name = displayName(first.title);
  const label = name ?? (isGroup ? members.join(", ") : first.address);

  const people: PersonMention[] = [{ role: "participant", name: "You", isSelf: true }];
  const seen = new Set<string>();
  const addPerson = (raw: string, personName?: string) => {
    const phone = phoneOf(raw, opts.phoneRegion);
    if (!phone || seen.has(phone)) return;
    seen.add(phone);
    people.push({
      role: "participant",
      phones: [phone],
      ...(personName ? { name: personName } : {}),
    });
  };
  // A 1:1 conversation's title is its one member's name; a group's names the group.
  for (const member of members) addPerson(member, isGroup ? undefined : name);
  for (const row of rows) if (row.direction === "in" && row.sender) addPerson(row.sender);

  const lines: string[] = [];
  for (const row of rows) {
    const sender =
      row.direction === "out"
        ? "You"
        : isGroup
          ? row.sender || "Unknown"
          : (name ?? phoneOf(first.address, opts.phoneRegion) ?? first.address);
    const pieces = [
      row.body,
      ...(snapshot.parts.get(row.id) ?? []).map(
        (part) => `[${attachmentLabel(part.mime)}: ${basename(part.file)}]`,
      ),
    ].filter((piece) => piece.length > 0);
    const note = row.direction === "out" ? (OUTGOING_STATE_NOTES[row.state] ?? "") : "";
    lines.push(`**${utcTime(row.at)}** ${sender}: ${pieces.join("\n")}${note}`);
  }
  const content = lines.join("\n");
  const last = rows[rows.length - 1]!;
  return {
    providerId: opts.providerId,
    sourceId: opts.sourceId,
    externalId: `sms:${first.address}:${day}`,
    title: `SMS with ${label} — ${day}`,
    content,
    contentHash: computeContentHash(content),
    metadata: {
      documentType: "conversation",
      tags: ["SMS"],
      people,
      extra: {
        conversationId: first.address,
        chatName: name,
        isGroup,
        messageCount: rows.length,
        service: "SMS",
        participants: members,
        date: day,
      },
    },
    sourceCreatedAt: `${day}T00:00:00.000Z`,
    sourceUpdatedAt: new Date(last.at).toISOString(),
  };
}

export function messageToRecord(
  row: MessageRow,
  snapshot: MessagesSnapshot,
  region?: string,
): Record<string, unknown> {
  const peer = row.direction === "in" && row.sender ? row.sender : row.address;
  return {
    id: String(row.id),
    date: utcDay(row.at),
    time: new Date(row.at).toISOString(),
    conversation: row.address,
    direction: row.direction === "out" ? "outgoing" : "incoming",
    transport: row.transport,
    state: row.state,
    counterparty: phoneOf(peer, region) ?? peer,
    characters: [...row.body].length,
    attachments: snapshot.parts.get(row.id)?.length ?? 0,
  };
}

/**
 * One page of SMS: one `conversation` document per conversation and UTC day,
 * rebuilt only when that day's messages changed (a delivery report, a retry,
 * a deletion), and one `omatel_messages` row per message without its text.
 */
export function syncMessages(
  cursor: OmatelCursor | null,
  opts: MessagesSyncOptions,
): StructuredSyncResult<OmatelCursor> {
  const snapshot = readMessages(opts.dataDir, opts.dataCutoff);
  if (snapshot === null) {
    return storeUnavailablePage(
      cursor,
      MESSAGES_RENDER_VERSION,
      MESSAGES_STORE.file,
      opts.dataCutoff,
    );
  }
  const groups = groupRows(snapshot.messages, (row) => `${row.address}:${utcDay(row.at)}`);
  const current = new Map<string, string>();
  for (const [key, rows] of groups) {
    const first = rows[0]!;
    current.set(
      key,
      fingerprint([
        opts.phoneRegion ?? null,
        first.title,
        membersOf(first, snapshot),
        rows.map((row) => [row, snapshot.parts.get(row.id) ?? []]),
      ]),
    );
  }
  const plan = planPage(cursor, current, MESSAGES_RENDER_VERSION, PAGE_GROUPS);
  const documents = plan.render.map((key) => {
    const rows = groups.get(key)!;
    return buildConversationDay(utcDay(rows[0]!.at), rows, snapshot, opts);
  });
  const records = plan.render.flatMap((key) =>
    groups.get(key)!.map((row) => messageToRecord(row, snapshot, opts.phoneRegion)),
  );
  if (plan.render.length > 0 || plan.removed.length > 0) {
    log.info(
      `Messages page: ${plan.render.length} conversation days rendered, ${plan.removed.length} removed, ${records.length} messages (hasMore: ${plan.hasMore})`,
    );
  }
  return {
    analytics: {
      tableName: OMATEL_MESSAGES_TABLE,
      records,
      // The last page of every cycle names every message still in the store,
      // so one the owner deleted leaves the table once enough snapshots agree.
      ...(plan.hasMore
        ? {}
        : { presentKeys: snapshot.messages.map((row) => ({ id: String(row.id) })) }),
    },
    documents,
    deletedExternalIds: plan.removed.map((key) => `sms:${key}`),
    cursor: plan.next,
    hasMore: plan.hasMore,
    // A complete read clears a withheld snapshot an unavailable store left.
    issues: plan.hasMore ? undefined : [],
    progress: {
      phase: cursor === null ? "bootstrap" : "incremental",
      processed: Object.keys(plan.next.groups).length,
      total: current.size,
      percentComplete:
        current.size > 0
          ? Math.round((Object.keys(plan.next.groups).length / current.size) * 100)
          : 100,
      ...historyCoverage(opts.dataCutoff),
    },
  };
}
