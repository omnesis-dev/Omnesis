// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  computeContentHash,
  countryNameToISO2,
  createLogger,
  normalizeEmail,
  normalizePhone,
} from "@omnesis/core";
import { parseSourceId, ProviderId, SourceId } from "@omnesis/types";
import { z } from "zod";
import { VOICEMAIL_FILTER } from "./db-helpers/voicemail-db.js";
import { coreDataToISO, isoToCoreData } from "./epoch.js";
import { decodeVoicemailTranscript } from "./voicemail-transcript.js";
import { validateAppleVoicemailSyncCursor } from "./types.js";
import { throwOnOpenFailure } from "./db-helpers/internal.js";
import { unavailableStorePage } from "./store-unavailable.js";
import type { AppleProvider } from "./provider.js";
import type { AppleVoicemailSyncCursor, RawVoicemailRecord } from "./types.js";
import type { SyncCursor, SyncResult } from "@omnesis/source-sdk";
import type { DocumentInput, PersonMention } from "@omnesis/types";

const log = createLogger("source:apple-voicemail");

const voicemailRowSchema = z.object({
  pk: z.number().int(),
  isRead: z.number().int(),
  dateCreated: z.number().finite(),
  dateModified: z.number().finite(),
  duration: z.number().finite().nonnegative(),
  caller: z.string().nullable(),
  recordUuid: z.instanceof(Buffer),
  transcriptData: z.instanceof(Buffer).nullable(),
});

const ROW_SELECT = `
  SELECT
    Z_PK AS pk,
    COALESCE(ZISREAD, 0) AS isRead,
    ZDATECREATED AS dateCreated,
    COALESCE(ZDATEMODIFIED, ZDATECREATED) AS dateModified,
    COALESCE(ZDURATION, 0) AS duration,
    ZFROM AS caller,
    ZRECORDUUID AS recordUuid,
    ZTRANSCRIPTDATA AS transcriptData
  FROM ZSTOREDMESSAGE
`;

function uuidFromBytes(bytes: Buffer): string | undefined {
  if (bytes.length !== 16) return undefined;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function callerMention(caller: string | null, phoneRegion?: string): PersonMention | undefined {
  const value = caller?.trim();
  if (!value) return undefined;
  if (value.includes("@")) {
    return { role: "participant", emails: [normalizeEmail(value)] };
  }
  const phone = normalizePhone(
    value,
    [countryNameToISO2(phoneRegion)].filter(
      (region): region is NonNullable<typeof region> => region !== undefined,
    ),
  );
  return phone ? { role: "participant", phones: [phone] } : undefined;
}

function voicemailDate(row: RawVoicemailRecord): string {
  return coreDataToISO(row.dateCreated).slice(0, 10);
}

/**
 * Reads carrier voicemail synchronized by macOS 26's Phone app and emits one
 * rolling day document. Caller identifiers are structured participant
 * mentions, allowing the people graph to join them to Contacts and Call Log.
 */
export class AppleVoicemailSource {
  readonly id: SourceId;
  readonly providerId: ProviderId;
  readonly watchPaths: string[];
  readonly dataCutoff?: string;
  private readonly selfEmail?: string;

  constructor(
    private readonly provider: AppleProvider,
    private readonly opts: {
      sourceId: string;
      providerId: string;
      dataCutoff?: string;
      phoneRegion?: string;
    },
  ) {
    this.id = SourceId(opts.sourceId);
    this.providerId = ProviderId(opts.providerId);
    this.dataCutoff = opts.dataCutoff;
    const dbPath = provider.voicemailDbFilePath;
    this.watchPaths = [dbPath, `${dbPath}-wal`];
    const { accountId } = parseSourceId(this.id);
    this.selfEmail = accountId.includes("@") ? normalizeEmail(accountId) : undefined;
  }

  async sync(cursor: SyncCursor | null): Promise<SyncResult> {
    const db = this.provider.getVoicemailDb();
    if (!db) {
      throwOnOpenFailure(this.provider.getVoicemailOpenFailure());
      return unavailableStorePage(cursor ?? { daySignatures: {} });
    }

    const cutoff = this.dataCutoff ? isoToCoreData(this.dataCutoff) : undefined;
    const cutoffClause = cutoff === undefined ? "" : " AND ZDATECREATED >= ?";
    const rawRows = db
      .prepare(`${ROW_SELECT} WHERE ${VOICEMAIL_FILTER}${cutoffClause} ORDER BY ZDATECREATED, Z_PK`)
      .all(...(cutoff === undefined ? [] : [cutoff]));
    const parsedRows = z.array(voicemailRowSchema).safeParse(rawRows);
    if (!parsedRows.success) {
      const issue = parsedRows.error.issues[0];
      const path = issue?.path.join(".") || "row";
      throw new Error(`Apple Voicemail database returned malformed data at ${path}`);
    }
    const rows: RawVoicemailRecord[] = parsedRows.data;

    const byDate = new Map<string, RawVoicemailRecord[]>();
    for (const row of rows) {
      const bucket = byDate.get(voicemailDate(row)) ?? [];
      bucket.push(row);
      byDate.set(voicemailDate(row), bucket);
    }

    const documents = Array.from(byDate, ([date, dayRows]) => this.buildDayDocument(date, dayRows));
    const presentExternalIds = documents.map((document) => document.externalId);
    const state = validateAppleVoicemailSyncCursor(cursor);
    const daySignatures = Object.fromEntries(
      documents.map((document) => [
        document.externalId,
        computeContentHash(JSON.stringify(document)),
      ]),
    );
    const changedDocuments = documents.filter(
      (document) =>
        state?.daySignatures[document.externalId] !== daySignatures[document.externalId],
    );

    log.info(
      `Sync produced ${changedDocuments.length} voicemail day document(s) from ${rows.length} voicemail(s)`,
    );
    return {
      documents: changedDocuments,
      deletedExternalIds: [],
      presentExternalIds,
      issues: [],
      cursor: { daySignatures } satisfies AppleVoicemailSyncCursor,
      hasMore: false,
      progress:
        rows.length > 0
          ? {
              phase: state ? "incremental" : "bootstrap",
              processed: rows.length,
              total: rows.length,
            }
          : undefined,
    };
  }

  private buildDayDocument(date: string, rows: RawVoicemailRecord[]): DocumentInput {
    const people: PersonMention[] = [];
    const seenPeople = new Set<string>();
    if (this.selfEmail) {
      people.push({ role: "participant", emails: [this.selfEmail] });
      seenPeople.add(`email:${this.selfEmail}`);
    }

    let totalDuration = 0;
    let transcriptCount = 0;
    const voicemailMetadata: Record<string, unknown>[] = [];
    const lines = [`# Voicemail — ${date}`, ""];

    for (const row of rows) {
      const mention = callerMention(row.caller, this.opts.phoneRegion);
      const identity = mention?.phones?.[0]
        ? `phone:${mention.phones[0]}`
        : mention?.emails?.[0]
          ? `email:${mention.emails[0]}`
          : undefined;
      if (mention && identity && !seenPeople.has(identity)) {
        people.push(mention);
        seenPeople.add(identity);
      }

      let transcript: string | undefined;
      try {
        transcript = decodeVoicemailTranscript(row.transcriptData);
      } catch (error) {
        log.warn(
          `Could not decode voicemail transcript for row ${row.pk}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (transcript) transcriptCount++;

      const createdAt = coreDataToISO(row.dateCreated);
      const caller =
        mention?.phones?.[0] ?? mention?.emails?.[0] ?? (row.caller?.trim() || "Unknown caller");
      const duration = Math.max(0, row.duration ?? 0);
      totalDuration += duration;
      lines.push(`## ${createdAt.slice(11, 16)} — ${caller} (${formatDuration(duration)})`);
      lines.push(transcript ?? "_Transcript not available._", "");

      voicemailMetadata.push({
        id: uuidFromBytes(row.recordUuid),
        time: createdAt,
        caller: mention?.phones?.[0] ?? mention?.emails?.[0] ?? null,
        durationSeconds: duration,
        isRead: row.isRead === 1,
        hasTranscript: transcript !== undefined,
      });
    }

    lines.splice(
      2,
      0,
      `**Total:** ${rows.length} voicemail${rows.length === 1 ? "" : "s"}, ${formatDuration(totalDuration)}`,
      "",
    );
    const content = lines.join("\n").trimEnd();

    return {
      providerId: this.providerId,
      sourceId: this.id,
      externalId: `voicemail:${date}`,
      title: `Voicemail — ${date}`,
      content,
      contentHash: computeContentHash(content),
      metadata: {
        documentType: "voicemail",
        rollingAggregate: true,
        people: people.length > 0 ? people : undefined,
        tags: [],
        extra: {
          date,
          voicemailCount: rows.length,
          totalDurationSeconds: totalDuration,
          transcriptCount,
          voicemails: voicemailMetadata,
        },
      },
      sourceCreatedAt: coreDataToISO(Math.min(...rows.map((row) => row.dateCreated))),
      sourceUpdatedAt: coreDataToISO(Math.max(...rows.map((row) => row.dateModified))),
    };
  }
}
