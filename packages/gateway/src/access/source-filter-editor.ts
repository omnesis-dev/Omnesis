// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The reads behind the owner's filter screens: the editor of one account,
 * its picker, the preview of a draft filter, the filter details of one
 * document, and the page that says who can read a document.
 *
 * Every read here runs on a read worker. The ones that walk a whole account
 * (field counts, entry counts, preview) can take seconds on a very large
 * one; the HTTP service runs them in the background and caches what they
 * return under {@link sourceFilterStamp}, which changes whenever anything
 * they read may have changed.
 */

import { createHash } from "node:crypto";
import { canonicalFilterIdentifier } from "@omnesis/core";
import {
  PERSON_ROLES,
  sourceTypeOf,
  type FilterIdentifierType,
  type FilterNoun,
  type FilterRef,
  type SourceFilter,
} from "@omnesis/types";
import { countDocumentsBySourceVersion } from "../data/repositories/DocumentRepository.js";
import { KNOWLEDGE_READ_SOURCE_IDS } from "../agent/knowledge-read-policy.js";
import { createCorpusAuthorization } from "./corpus-authorization.js";
import { documentAccessGrant } from "./document-inclusion.js";
import { filterFieldsFor } from "./filter-fields.js";
import {
  decideDocumentAccess,
  filterReadableDocumentIds,
  type AccessReason,
  type DocumentAccessGrant,
} from "./filter-decision.js";
import {
  countFilterEntries,
  readDocumentFilterDetails,
  readFilterOptions,
  readFilterPreview,
  savedFilterEntries,
  type FilterEditorResult,
  type FilterOptions,
  type FilterOptionsRequest,
  type FilterPreview,
} from "./filter-editor-reads.js";
import { FILTER_PEOPLE_FIELD, filterDeclarationDigest } from "./filter-sql.js";
import {
  countUnmatchedRecords,
  filterSourceName,
  readSourceFilterReadiness,
  type FilterDevice,
  type FilterFieldState,
} from "./filter-readiness.js";
import {
  ACCESS_AUDIT_ANSWER_NOTE,
  ACCESS_AUDIT_OWNER_NOTE,
  DISCONNECTED_ACCOUNT_TEXT,
  PERSON_NOUN,
  accessReasonText,
  documentFilterStateText,
  filterFieldStateText,
  filterInsideText,
  filterProfileText,
  tooOldCountText,
  unmatchedCountText,
} from "./filter-wording.js";
import { liveLevelDevices, liveLevelMemberGrantIds } from "./store-level-summaries.js";
import { getLevelCapabilities } from "./store-rules.js";
import type { Db } from "../data/types.js";

/** A field's state as the editor shows it: the readiness state with its sentence. */
export type FilterEditorFieldState =
  | { status: "ready" }
  | (Exclude<FilterFieldState, { status: "ready" }> & { text: string })
  /** The account is no longer connected; its saved entries are kept and named from what remains. */
  | { status: "disconnected"; text: string };

export interface FilterEditorField {
  field: string;
  capability: "membership" | "tree" | "person";
  noun: FilterNoun;
  levels?: FilterNoun[];
  inside?: FilterNoun;
  insideText?: string;
  picker: "search" | "tree";
  scope: "global" | "device";
  identifiers?: FilterIdentifierType[];
  state: FilterEditorFieldState;
}

/** The editor of one account, without the counts that take a pass over it. */
export interface SourceFilterEditorStructure {
  sourceId: string;
  sourceType: string;
  sourceName: string;
  devices: FilterDevice[];
  showDeviceLevel: boolean;
  profile: "declared" | "no-profile" | "collector-behind";
  profileText: string | null;
  /**
   * False for an account that is gone while a saved filter still names it:
   * nothing can be added and nothing is counted, but the saved entries can
   * still be named.
   */
  connected: boolean;
  /** Changes whenever a count of this account may have changed. */
  stamp: string;
  fields: FilterEditorField[];
}

export interface FilterFieldCounts {
  tooOld: number;
  unmatched: number;
  tooOldText: string | null;
  unmatchedText: string | null;
}

/**
 * A digest of everything the slow reads of an account depend on: the
 * source's declaration, its published lists, its newest record change and
 * how many records it holds at each version. A resync that only stamps
 * versions changes the last; any other record write changes the third.
 */
export function sourceFilterStamp(db: Db, sourceId: string): string {
  return db.transaction(() => {
    const lists = db
      .prepare<[string], { field: string; device_id: string; generation: number; digest: string }>(
        `SELECT field, device_id, generation, digest FROM source_filter_lists
          WHERE source_id = ? ORDER BY field, device_id`,
      )
      .all(sourceId);
    const newest = db
      .prepare<[string], { at: string | number | null }>(
        "SELECT MAX(updated_at) AS at FROM documents WHERE source_id = ?",
      )
      .get(sourceId)?.at;
    return createHash("sha256")
      .update(
        JSON.stringify([
          sourceId,
          filterDeclarationDigest(filterFieldsFor(db, sourceTypeOf(sourceId))),
          lists,
          newest ?? null,
          countDocumentsBySourceVersion(db, sourceId),
        ]),
      )
      .digest("hex")
      .slice(0, 32);
  })();
}

function editorState(
  state: FilterFieldState,
  context: { sourceName: string; noun: FilterNoun },
): FilterEditorFieldState {
  return state.status === "ready"
    ? state
    : { ...state, text: filterFieldStateText(state, context) };
}

/** The editor of one account, or `null` when the account does not exist. */
export function readSourceFilterEditor(
  db: Db,
  sourceId: string,
): SourceFilterEditorStructure | null {
  return db.transaction((): SourceFilterEditorStructure | null => {
    const readiness = readSourceFilterReadiness(db, sourceId);
    if (!readiness) return disconnectedEditor(db, sourceId);
    const name = filterSourceName(db, sourceId, readiness.sourceType);
    const listedDevices = db.prepare<[string, string], { n: number }>(
      `SELECT count(DISTINCT device_id) AS n FROM source_filter_lists
        WHERE source_id = ? AND field = ? AND generation > 0`,
    );
    let showDeviceLevel = false;
    const fields = readiness.fields.map((field): FilterEditorField => {
      const declaration = field.declaration;
      if (declaration?.scope === "device" && listedDevices.get(sourceId, field.field)!.n > 1)
        showDeviceLevel = true;
      return {
        field: field.field,
        capability: field.capability,
        noun: field.noun,
        ...(declaration?.levels ? { levels: declaration.levels } : {}),
        ...(declaration?.inside
          ? { inside: declaration.inside, insideText: filterInsideText(declaration.inside) }
          : {}),
        picker: declaration?.picker ?? "search",
        scope: declaration?.scope ?? "global",
        ...(field.identifiers ? { identifiers: field.identifiers } : {}),
        state: editorState(field.state, { sourceName: name, noun: field.noun }),
      };
    });
    return {
      sourceId,
      sourceType: readiness.sourceType,
      sourceName: name,
      devices: readiness.devices,
      showDeviceLevel,
      profile: readiness.profile,
      profileText: filterProfileText(readiness.profile, readiness.devices),
      connected: true,
      stamp: sourceFilterStamp(db, sourceId),
      fields,
    };
  })();
}

/** Whether any saved filter, of a level or of a connection, names the account. */
function savedFilterNames(db: Db, sourceId: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM access_scope_policy_sources WHERE source_id = ? LIMIT 1")
    .get(sourceId);
}

/**
 * The editor of an account that is gone while a saved filter still names it:
 * the declared fields, so a client can name each saved entry's level, every
 * one marked disconnected. `null` when nothing names the account.
 */
function disconnectedEditor(db: Db, sourceId: string): SourceFilterEditorStructure | null {
  if (!savedFilterNames(db, sourceId)) return null;
  const sourceType = sourceTypeOf(sourceId);
  const declared = filterFieldsFor(db, sourceType);
  const state = { status: "disconnected" as const, text: DISCONNECTED_ACCOUNT_TEXT };
  const fields: FilterEditorField[] = [];
  if (declared.state === "declared") {
    for (const field of declared.fields) {
      if (field.state !== "ready") continue;
      const spec = field.filter;
      fields.push({
        field: field.path,
        capability: spec.capability,
        noun: spec.noun,
        ...(spec.levels ? { levels: spec.levels } : {}),
        ...(spec.inside ? { inside: spec.inside, insideText: filterInsideText(spec.inside) } : {}),
        picker: spec.picker,
        scope: spec.scope,
        state,
      });
    }
    if (declared.person?.state === "ready")
      fields.push({
        field: FILTER_PEOPLE_FIELD,
        capability: "person",
        noun: PERSON_NOUN,
        picker: "search",
        scope: "global",
        identifiers: [...declared.person.filter.identifiers],
        state,
      });
  }
  return {
    sourceId,
    sourceType,
    sourceName: filterSourceName(db, sourceId, sourceType),
    devices: [],
    showDeviceLevel: false,
    profile: declared.state,
    profileText: DISCONNECTED_ACCOUNT_TEXT,
    connected: false,
    stamp: "",
    fields,
  };
}

/**
 * The two counts the editor shows under one field: records too old for it,
 * and records new enough whose detail is not known. Reads every record of
 * the account. `null` when the field cannot be counted.
 */
export function readSourceFilterFieldCounts(
  db: Db,
  sourceId: string,
  field: string,
): FilterFieldCounts | null {
  const readiness = readSourceFilterReadiness(db, sourceId);
  const entry = readiness?.fields.find((candidate) => candidate.field === field);
  if (!entry) return null;
  const unmatched = countUnmatchedRecords(db, sourceId, field) ?? 0;
  return {
    tooOld: entry.tooOld,
    unmatched,
    tooOldText: entry.tooOld > 0 ? tooOldCountText(entry.tooOld) : null,
    unmatchedText: unmatched > 0 ? unmatchedCountText(unmatched, entry.noun) : null,
  };
}

/** One page of a field's entries, without counts, and the stamp to cache their counts under. */
export function readSourceFilterOptionsPage(
  db: Db,
  request: FilterOptionsRequest,
): FilterEditorResult<FilterOptions & { stamp: string }> {
  return db.transaction(() => {
    const page = readFilterOptions(db, request, { withCounts: false });
    return page.ok
      ? {
          ok: true as const,
          value: { ...page.value, stamp: sourceFilterStamp(db, request.sourceId) },
        }
      : page;
  })();
}

/** How many records each entry would share on its own. Reads every record of the account. */
export function readSourceFilterEntryCounts(db: Db, sourceId: string, refs: FilterRef[]): number[] {
  return countFilterEntries(db, sourceId, filterFieldsFor(db, sourceTypeOf(sourceId)), refs);
}

export type SourceFilterPreview = FilterPreview & {
  /** False for an account that is gone; every count is then 0. */
  connected: boolean;
  tooOldText: string | null;
  unmatchedText: string | null;
};

/** What a draft filter would do to the account. Reads every record of the account. */
export function readSourceFilterPreview(
  db: Db,
  sourceId: string,
  filter: SourceFilter,
): FilterEditorResult<SourceFilterPreview> {
  if (!db.prepare("SELECT 1 FROM sources WHERE id = ?").get(sourceId)) {
    // A gone account: nothing to count, but the saved entries are named from
    // whatever list rows remain.
    if (!savedFilterNames(db, sourceId) || filter.sourceId !== sourceId)
      return { ok: false, error: "source-not-found" };
    const fields = filterFieldsFor(db, sourceTypeOf(sourceId));
    return {
      ok: true,
      value: {
        sourceId,
        connected: false,
        total: 0,
        visible: 0,
        hidden: 0,
        tooOld: 0,
        unmatched: 0,
        tooOldText: null,
        unmatchedText: null,
        items: savedFilterEntries(db, sourceId, fields, filter.rules[0].match).map((entry) => ({
          ...entry,
          count: 0,
        })),
      },
    };
  }
  const preview = readFilterPreview(db, sourceId, filter);
  if (!preview.ok) return preview;
  const nouns = new Set(
    filter.rules[0].match.map((ref) =>
      ref.capability === "person" ? FILTER_PEOPLE_FIELD : ref.field,
    ),
  );
  const fields = readSourceFilterReadiness(db, sourceId)?.fields ?? [];
  const noun =
    nouns.size === 1
      ? (fields.find((field) => nouns.has(field.field))?.noun ?? { one: "item", many: "items" })
      : { one: "item", many: "items" };
  return {
    ok: true,
    value: {
      ...preview.value,
      connected: true,
      tooOldText: preview.value.tooOld > 0 ? tooOldCountText(preview.value.tooOld) : null,
      unmatchedText:
        preview.value.unmatched > 0 ? unmatchedCountText(preview.value.unmatched, noun) : null,
    },
  };
}

// ── The filter details of one document ─────────────────────────────────────

export interface DocumentFilterDetailsView {
  documentId: string;
  sourceId: string;
  sourceVersion: number;
  fields: Array<{
    field: string;
    noun: FilterNoun;
    state: "present" | "too-old" | "unknown";
    stateText: string;
    items: Array<{ id: string; label: string; listed: boolean }>;
  }>;
}

function parseMetadata(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const FILTER_PERSON_ROLES = new Set<string>(PERSON_ROLES.filter((role) => role !== "mentioned"));

/** The people of a record in the roles a person filter considers, named for display. */
function recordPeople(
  metadata: unknown,
  roles: readonly string[],
  kinds: readonly FilterIdentifierType[],
): Array<{ id: string; label: string; listed: boolean }> | null {
  const people =
    typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).people
      : undefined;
  if (!Array.isArray(people)) return null;
  const items = new Map<string, { id: string; label: string; listed: boolean }>();
  for (const person of people) {
    if (typeof person !== "object" || person === null) continue;
    const mention = person as Record<string, unknown>;
    if (typeof mention.role !== "string" || !roles.includes(mention.role)) continue;
    const raw: Array<["phone" | "email", unknown]> = [
      ...(Array.isArray(mention.emails) ? mention.emails : []).map((value): ["email", unknown] => [
        "email",
        value,
      ]),
      ...(Array.isArray(mention.phones) ? mention.phones : []).map((value): ["phone", unknown] => [
        "phone",
        value,
      ]),
      ...(Array.isArray(mention.identifiers) ? mention.identifiers : []).flatMap(
        (entry): Array<["phone" | "email", unknown]> => {
          const kind = (entry as { kind?: unknown } | null)?.kind;
          const value = (entry as { value?: unknown } | null)?.value;
          return kind === "phone" || kind === "email" ? [[kind, value]] : [];
        },
      ),
    ];
    const identifier = raw
      .filter(([type]) => kinds.includes(type) || (type === "email" && kinds.includes("domain")))
      .map(([type, value]) =>
        typeof value === "string" ? canonicalFilterIdentifier(type, value) : null,
      )
      .find((value) => value !== null);
    if (!identifier) continue;
    const name = typeof mention.name === "string" && mention.name.trim() ? mention.name : null;
    items.set(identifier.value, {
      id: identifier.value,
      label: name ?? identifier.value,
      listed: true,
    });
  }
  return [...items.values()];
}

/**
 * The filter details of one document as the owner's document view shows
 * them, or `null` when the document does not exist. An attachment shows the
 * record it was attached to.
 */
export function readDocumentFilterDetailsView(
  db: Db,
  documentId: string,
): DocumentFilterDetailsView | null {
  return db.transaction((): DocumentFilterDetailsView | null => {
    const details = readDocumentFilterDetails(db, documentId);
    if (!details) return null;
    const row = db
      .prepare<
        [string],
        { provider_id: string; source_id: string; stream_id: string; metadata: string }
      >("SELECT provider_id, source_id, stream_id, metadata FROM documents WHERE id = ?")
      .get(documentId);
    if (!row) return null;
    const view: DocumentFilterDetailsView = {
      documentId,
      sourceId: row.source_id,
      sourceVersion: details.sourceVersion,
      fields: details.fields.map((field) => ({
        field: field.field,
        noun: field.noun,
        state: field.state,
        stateText: documentFilterStateText(field.state, field.noun),
        items: field.items,
      })),
    };
    const declared = filterFieldsFor(db, sourceTypeOf(row.source_id));
    if (declared.state !== "declared" || declared.person?.state !== "ready") return view;
    const person = declared.person.filter;
    const roles = person.roles.filter((role) => FILTER_PERSON_ROLES.has(role));
    // An attachment is decided by the record it was attached to: show that
    // record's people, as its other details are.
    let metadata = parseMetadata(row.metadata);
    const parent = (metadata?.extra as Record<string, unknown> | undefined)?.parentExternalId;
    if (metadata?.documentType === "attachment" || parent !== undefined) {
      const subject =
        typeof parent === "string"
          ? db
              .prepare<[string, string, string, string, string], { metadata: string }>(
                `SELECT metadata FROM documents WHERE provider_id = ? AND source_id = ?
                    AND external_id = ? AND stream_id = ? AND id <> ?`,
              )
              .get(row.provider_id, row.source_id, parent, row.stream_id, documentId)
          : undefined;
      metadata = subject ? parseMetadata(subject.metadata) : null;
    }
    const tooOld = details.sourceVersion < person.minVersion;
    const items = tooOld ? [] : recordPeople(metadata, roles, person.identifiers);
    const state = tooOld ? "too-old" : items === null ? "unknown" : "present";
    view.fields.push({
      field: FILTER_PEOPLE_FIELD,
      noun: PERSON_NOUN,
      state,
      stateText: documentFilterStateText(state, PERSON_NOUN),
      items: items ?? [],
    });
    return view;
  })();
}

// ── Who can read one document ──────────────────────────────────────────────

export interface AuditVerdict {
  readable: boolean;
  code: Exclude<AccessReason["code"], "document-not-found">;
  text: string;
}

export interface DocumentAccessAudit {
  documentId: string;
  title: string;
  sourceId: string;
  sourceName: string;
  sourceVersion: number;
  notes: { answer: string; owner: string };
  levels: Array<{
    id: string;
    name: string;
    agents: Array<{ id: string; name: string; kind: "connection" | "device" }>;
    answer: AuditVerdict;
    direct: AuditVerdict;
  }>;
}

/**
 * The grant one level gives for one permission, built by the function every
 * connection on the level goes through, so the verdicts below are the ones
 * an agent on the level gets.
 */
function levelGrant(
  db: Db,
  level: { id: string; revision: number },
  capability: "answer" | "direct",
): DocumentAccessGrant {
  const authorization = createCorpusAuthorization(
    {
      principalId: `level:${level.id}`,
      grantId: `level:${level.id}`,
      grantRevision: level.revision,
      credentialId: `level:${level.id}`,
      accessTokenId: "document-access-audit",
    },
    getLevelCapabilities(db, level.id),
    capability,
  );
  return authorization
    ? documentAccessGrant(db, authorization)
    : {
        capabilityGranted: false,
        permittedSourceIds: null,
        filters: [],
        internalSourceIds: KNOWLEDGE_READ_SOURCE_IDS,
      };
}

function verdict(
  db: Db,
  grant: DocumentAccessGrant,
  documentId: string,
  capability: "answer" | "direct",
): AuditVerdict {
  const decision = decideDocumentAccess(db, grant, documentId);
  const reason: AccessReason =
    decision.reason.code === "document-not-found"
      ? { code: "detail-unknown", field: null, noun: null, person: false, cause: "absent" }
      : decision.reason;
  return {
    readable: decision.readable,
    code: reason.code as AuditVerdict["code"],
    text: accessReasonText(reason, capability),
  };
}

/** Every access level's Answer and Direct verdict on one document, or `null` when it does not exist. */
export function readDocumentAccessAudit(
  db: Db,
  documentId: string,
  now: number,
): DocumentAccessAudit | null {
  return db.transaction((): DocumentAccessAudit | null => {
    const document = db
      .prepare<
        [string],
        {
          id: string;
          title: string;
          source_id: string;
          source_version: number;
          type: string | null;
        }
      >(
        `SELECT d.id, d.title, d.source_id, d.source_version,
                (SELECT s.type FROM sources s WHERE s.id = d.source_id) AS type
           FROM documents d WHERE d.id = ?`,
      )
      .get(documentId);
    if (!document) return null;
    const devices = liveLevelDevices(db);
    const connectionName = db.prepare<[string], { name: string }>(
      "SELECT name FROM access_grants WHERE id = ?",
    );
    const levels = db
      .prepare<[], { id: string; name: string; revision: number }>(
        "SELECT id, name, revision FROM access_levels WHERE revoked_at IS NULL",
      )
      .all()
      .sort(
        (left, right) =>
          left.name.toLowerCase().localeCompare(right.name.toLowerCase()) ||
          (left.id < right.id ? -1 : 1),
      )
      .map((level) => ({
        id: level.id,
        name: level.name,
        agents: [
          ...liveLevelMemberGrantIds(db, level.id, now).map((id) => ({
            id,
            name: connectionName.get(id)?.name ?? id,
            kind: "connection" as const,
          })),
          ...(devices.get(level.id) ?? []).map((device) => ({
            id: device.id,
            name: device.name,
            kind: "device" as const,
          })),
        ],
        answer: verdict(db, levelGrant(db, level, "answer"), documentId, "answer"),
        direct: verdict(db, levelGrant(db, level, "direct"), documentId, "direct"),
      }));
    return {
      documentId: document.id,
      title: document.title,
      sourceId: document.source_id,
      sourceName: filterSourceName(
        db,
        document.source_id,
        document.type ?? sourceTypeOf(document.source_id),
      ),
      sourceVersion: document.source_version,
      notes: { answer: ACCESS_AUDIT_ANSWER_NOTE, owner: ACCESS_AUDIT_OWNER_NOTE },
      levels,
    };
  })();
}

/** The reads above, and the result check of a filtered search, as one read port. */
export const SOURCE_FILTER_READS = {
  sourceFilterEditor: readSourceFilterEditor,
  sourceFilterFieldCounts: readSourceFilterFieldCounts,
  sourceFilterOptionsPage: readSourceFilterOptionsPage,
  sourceFilterEntryCounts: readSourceFilterEntryCounts,
  sourceFilterPreview: readSourceFilterPreview,
  documentFilterDetails: readDocumentFilterDetailsView,
  documentAccessAudit: readDocumentAccessAudit,
  filterReadableDocumentIds: (db: Db, grant: DocumentAccessGrant, documentIds: string[]) => [
    ...filterReadableDocumentIds(db, grant, documentIds),
  ],
};
