// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Request-body schemas for routes mounted in `routes/documents.ts`.
 *
 * `DocumentInput` and `SyncCursor` shapes live in `@omnesis/core` — the
 * library types are still the per-provider compile-time gate, but at the
 * gateway boundary we re-validate the wire shape because callers come
 * from outside the TS compile unit (a buggy collector running an older
 * build, a malicious WS peer, a hand-rolled `curl`). The required fields
 * mirror `DocumentInput` (providerId / sourceId / externalId / title /
 * content / contentHash / metadata / sourceCreatedAt / sourceUpdatedAt).
 *
 * Pre-fix the body was `z.array(z.record(z.unknown()))` —
 * any array of objects passed; missing required fields landed in the
 * writer worker and surfaced as obscure SQLite NOT-NULL errors.
 */
import {
  ACCEPTED_TEMPORAL_KINDS,
  canonicalTemporalKind,
  TEMPORAL_MODALITIES,
  TEMPORAL_STATUSES,
} from "@omnesis/core";
import { DOCUMENT_PROJECTION_FIELDS, type DocumentProjectionField } from "@omnesis/source-sdk";
import { z } from "zod";
import { SOURCE_ICON_MAX_INPUT_CHARS } from "../../icon-limits.js";
import { nonEmptyString, urlPatternSpecSchema } from "./common.js";
import { accountDescriptorSchema } from "./account-descriptor.js";

const documentInputShape = z
  .object({
    providerId: nonEmptyString,
    sourceId: nonEmptyString,
    externalId: nonEmptyString,
    title: z.string(),
    content: z.string(),
    contentHash: nonEmptyString,
    /** See Document.extractedContentHash — optional. */
    extractedContentHash: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).transform((value) => {
      // Older browser extensions sent this retired producer-detail field.
      // Accept those clients during upgrade, but never persist the field.
      const { captureMethod: _retired, ...metadata } = value;
      return metadata;
    }),
    sourceCreatedAt: nonEmptyString,
    sourceUpdatedAt: nonEmptyString,
    /**
     * Which of the source's partitions this document was read from. Bounded
     * like a claim's `partition`, which it has to match to mean anything, and
     * typed here because the column it lands in is `NOT NULL` and indexed —
     * an object reaching the bind would throw on the writer thread, where this
     * layer cannot classify it.
     */
    partitionKey: z.string().max(256).optional(),
  })
  .passthrough(); // tolerate extra fields the collector might add ahead of a schema bump.

/**
 * The closed set of document fields a projection may read. Anything outside it
 * — a free-text path, a `metadata.extra` key — is not a deterministic fact and
 * is rejected here rather than half-resolved in the writer.
 */
const documentProjectionField = z.enum(DOCUMENT_PROJECTION_FIELDS);

/**
 * The subset of those fields that carries a date. A projection's start, end and
 * source-revision clock each have to resolve to an instant or a calendar day,
 * so dateless fields (the time-zone basis and source lifecycle status) cannot
 * fill them.
 */
const DOCUMENT_DATE_FIELDS = [
  "$semanticTime",
  "scheduledAt",
  "dueAt",
  "endsAt",
] as const satisfies readonly DocumentProjectionField[];

const documentDateField = z.enum(DOCUMENT_DATE_FIELDS);

/**
 * A kind as it arrives on the wire. Clients may send any accepted spelling; the
 * canonical one is what gets stored, so nothing downstream sees an alias.
 */
const wireTemporalKind = z.string().transform((value, ctx) => {
  const canonical = canonicalTemporalKind(value);
  if (canonical === null) {
    ctx.addIssue({
      code: "custom",
      message: `Invalid temporal kind '${value}' (one of ${ACCEPTED_TEMPORAL_KINDS.join(", ")})`,
    });
    return z.NEVER;
  }
  return canonical;
});

/**
 * A vocabulary field that is either fixed for every document, or read from one
 * of the projection fields and mapped onto the vocabulary with a fallback.
 */
function mappedProjectionField<T extends string>(value: z.ZodType<T>) {
  return z.union([
    value,
    z
      .object({
        from: documentProjectionField,
        map: z.record(z.string(), value),
        default: value,
      })
      .strict(),
  ]);
}

/**
 * The wire mirror of the document plane of `validateDocumentTemporalProjectionContracts`.
 *
 * `allDay` and `eligibility` are absent by construction: they are boolean gates,
 * and a document carries no typed boolean a projection may read — all-day is
 * inferred from whether the resolved date is a calendar day or an instant, and
 * there is no document-level eligibility gate.
 */
const documentTemporalProjectionShape = z
  .object({
    slot: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    start: documentDateField,
    end: documentDateField.optional(),
    label: documentProjectionField.optional(),
    kind: mappedProjectionField(wireTemporalKind),
    modality: mappedProjectionField(z.enum(TEMPORAL_MODALITIES)),
    status: mappedProjectionField(z.enum(TEMPORAL_STATUSES)).optional(),
    timeZone: documentProjectionField.optional(),
    sourceUpdatedAt: documentDateField.optional(),
    correlationKeys: z.array(documentProjectionField).optional(),
  })
  .strict();

const documentTemporalProjectionsShape = z
  .array(documentTemporalProjectionShape)
  .superRefine((specs, ctx) => {
    const seen = new Set<string>();
    specs.forEach((spec, index) => {
      if (seen.has(spec.slot)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate document temporal projection slot '${spec.slot}'`,
          path: [index, "slot"],
        });
      }
      seen.add(spec.slot);
    });
  });

// POST /documents
export const ingestDocumentsBody = z.object({
  documents: z.array(documentInputShape),
  writeEpochs: z.record(z.string(), z.number().int().nonnegative()).optional(),
});
export type IngestDocumentsBody = z.infer<typeof ingestDocumentsBody>;

// POST /documents/delete
export const deleteDocumentsBody = z.object({
  providerId: nonEmptyString,
  sourceId: nonEmptyString,
  externalIds: z.array(z.string()),
  writeEpoch: z.number().int().nonnegative().optional(),
});
export type DeleteDocumentsBody = z.infer<typeof deleteDocumentsBody>;

/**
 * One partition the source enumerated in full, and what it holds.
 *
 * The general form of `presentExternalIds`: that field is this with one
 * unnamed partition, and the gateway normalises it so there is one path rather
 * than two. A partition name has to match the `partitionKey` the source stamps
 * on its documents, or the claim names nothing.
 */
const snapshotClaimShape = z.object({
  partition: z.string().min(1).max(256),
  ids: z.array(z.string()),
});

/**
 * How many partitions one page may claim.
 *
 * Not a capacity estimate — the body size limit is what actually bounds a page,
 * and the ids inside these claims dwarf their names. It is a runaway guard, and
 * it has to sit well above what a real source discovers, because tripping it is
 * worse than the thing it guards: a source whose partitions outgrew it would
 * have its final page refused, never advance its cursor, and re-walk into the
 * same refusal on every tick. The largest counts in this tree are a mail
 * account's mailboxes (capped at 500 by the source), a workspace's databases
 * and an account's repositories.
 */
const MAX_SNAPSHOT_CLAIMS = 8192;

/**
 * Refuse a page that sends both spellings of its snapshot. Every endpoint
 * that accepts one applies this, so a source's mistake is the same 400
 * wherever it lands rather than a 400 on one route and a narrowed sweep on
 * another.
 */
function refuseBothSpellings(
  body: { presentExternalIds?: unknown; presentClaims?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (body.presentExternalIds === undefined || body.presentClaims === undefined) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["presentExternalIds"],
    message: `presentExternalIds and presentClaims are two answers to one question — send one`,
  });
}

// POST /documents/reconcile
export const reconcileDocumentsBody = z
  .object({
    providerId: nonEmptyString,
    sourceId: nonEmptyString,
    /** Everything the source enumerated, when it read the whole source. */
    presentExternalIds: z.array(z.string()).optional(),
    /**
     * The same assertion partition by partition, for a source that read some
     * of its stores and not others. Mutually exclusive with the field above,
     * on the same terms as `POST /documents/with-cursor`.
     */
    presentClaims: z.array(snapshotClaimShape).max(MAX_SNAPSHOT_CLAIMS).optional(),
    writeEpoch: z.number().int().nonnegative().optional(),
    observationId: z.string().min(1).max(256).optional(),
  })
  .superRefine((body, ctx) => {
    refuseBothSpellings(body, ctx);
    if (body.presentExternalIds !== undefined || body.presentClaims !== undefined) return;
    // A reconcile with no snapshot has nothing to reconcile against; read as
    // an empty enumeration it would say the source holds nothing.
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["presentExternalIds"],
      message: "A reconcile has to say what is present: send presentExternalIds or presentClaims",
    });
  });
export type ReconcileDocumentsBody = z.infer<typeof reconcileDocumentsBody>;

// POST /documents/exists
export const documentsExistsBody = z.object({
  providerId: nonEmptyString,
  sourceId: nonEmptyString,
  externalIds: z.array(z.string()),
});
export type DocumentsExistsBody = z.infer<typeof documentsExistsBody>;

// POST /documents/stats — batch variant of /documents/stats/:sourceId.
// 100-id cap prevents accidental "give me everything" patterns; the CLI's
// `omnesis status` is the principal caller and ships ≤ N descriptors per
// run. Above the cap, the CLI is expected to chunk.
export const documentsStatsBulkBody = z.object({
  sourceIds: z.array(z.string()).max(100),
});
export type DocumentsStatsBulkBody = z.infer<typeof documentsStatsBulkBody>;

// POST /documents/bulk — same shape as /documents/people-bulk; capped at
// 100 ids/batch so the SQL `IN (?, ?, …)` stays bounded. The portal's
// PersonDetail uses this to fetch a page of doc details in one call
// instead of N parallel /documents/:id requests.
export const documentsBulkBody = z.object({
  ids: z.array(z.string()).max(100, "Too many ids (max 100)"),
  /** Return only the identity fields needed by lightweight linked-document UI. */
  summary: z.boolean().optional(),
});
export type DocumentsBulkBody = z.infer<typeof documentsBulkBody>;

// POST /documents/by-url — resolve a batch of source URLs to documentIds.
// Used by the eval toolkit's suite resolver so test fixtures can identify
// expected docs by their stable deep URL instead of an internal id. URLs
// are normalized server-side via `normalizeUrl`, so callers don't need to
// canonicalize before sending.
export const documentsByUrlBody = z.object({
  urls: z.array(z.string().min(1)).min(1).max(500),
});
export type DocumentsByUrlBody = z.infer<typeof documentsByUrlBody>;

// POST /documents/content-hash-siblings — given a batch of documentIds,
// returns every other documentId in the index that shares each input's
// `content_hash`. Used by the eval resolver so that byte-identical
// duplicates (the same PDF in Drive AND as a Gmail attachment) are
// auto-treated as valid hits — mirroring the search pipeline's
// `dedupeByContentHash` which collapses them to a single representative
// in the top-k.
export const documentsContentHashSiblingsBody = z.object({
  documentIds: z.array(z.string().min(1)).min(1).max(500),
});
export type DocumentsContentHashSiblingsBody = z.infer<typeof documentsContentHashSiblingsBody>;

/** See `SourceSyncMeta.family`. */
const sourceFamilyMetaSchema = z.object({
  icon: z.string().max(SOURCE_ICON_MAX_INPUT_CHARS).optional(),
  label: z.string().optional(),
  bgColor: z.string().optional(),
  accentColor: z.string().optional(),
});

// POST /sync-state/:sourceId
export const setSyncStateBody = z.object({
  cursor: z.record(z.string(), z.unknown()),
  account: accountDescriptorSchema.optional(),
  icon: z.string().max(SOURCE_ICON_MAX_INPUT_CHARS).optional(),
  label: z.string().optional(),
  urlPatterns: z.array(urlPatternSpecSchema).max(50).optional(),
  bgColor: z.string().optional(),
  accentColor: z.string().optional(),
  contentRetention: z.enum(["complete", "best-effort"]).optional(),
  family: sourceFamilyMetaSchema.optional(),
  writeEpoch: z.number().int().nonnegative().optional(),
});
export type SetSyncStateBody = z.infer<typeof setSyncStateBody>;
export const sourceSyncMetaBody = setSyncStateBody.omit({ cursor: true, writeEpoch: true });
export type SourceSyncMetaBody = z.infer<typeof sourceSyncMetaBody>;
const syncAttemptId = z.string().uuid();
export const beginSyncAttemptBody = z.object({ attemptId: syncAttemptId.optional() });
export const revokeSyncAttemptBody = z
  .object({
    writeEpoch: z.number().int().nonnegative().optional(),
    attemptId: syncAttemptId.optional(),
  })
  .refine((body) => body.writeEpoch !== undefined || body.attemptId !== undefined, {
    message: "writeEpoch or attemptId is required",
  });

// Source-declared edge contract (#430). `from`/`to` name documents by
// source-native id; `type` is the closed `SourceEdgeType` vocabulary (kept in
// sync with `@omnesis/core` `SOURCE_EDGE_TYPES`). Re-validated here because the
// collector is outside the gateway's compile unit.
const documentRefShape = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("internal"), sourceDocumentId: nonEmptyString }),
  z.object({
    kind: z.literal("external"),
    sourceId: nonEmptyString,
    sourceDocumentId: nonEmptyString,
  }),
]);
const edgeDeclarationShape = z.object({
  from: documentRefShape,
  to: documentRefShape,
  type: z.enum([
    "contains",
    "part-of-thread",
    "replies-to",
    "references",
    "succeeds",
    "accompanies",
    "bookmarks",
    "visited",
  ]),
  ordering: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// POST /documents/with-cursor — atomic per-page sync write (issue #322).
// Bundles every SQLite-side write the collector needs to commit at the
// end of a sync page so they either all land or none do, closing the
// at-least-once gap where the cursor could lag the documents on a
// partial failure.
export const upsertWithCursorBody = z
  .object({
    providerId: nonEmptyString,
    sourceId: nonEmptyString,
    documents: z.array(documentInputShape).optional(),
    documentTemporalProjections: documentTemporalProjectionsShape.optional(),
    deletedExternalIds: z.array(z.string()).optional(),
    /** Source-declared structural edges for this page (#430). */
    edges: z.array(edgeDeclarationShape).optional(),
    /**
     * Snapshot of currently-present external IDs (final-page only). The
     * gateway refuses to reconcile if `hasMore=true` — see the
     * `upsertWithCursor` doc-comment in `DocumentRepository.ts`.
     */
    presentExternalIds: z.array(z.string()).optional(),
    /**
     * The same assertion made partition by partition, for a source that read
     * some of its stores and not others. Mutually exclusive with the field
     * above — setting both is a contradiction about what was read, so it is
     * refused rather than resolved by a precedence nobody would remember.
     */
    presentClaims: z.array(snapshotClaimShape).max(MAX_SNAPSHOT_CLAIMS).optional(),
    /** Stable identity of the completed sync attempt; retries add no evidence. */
    observationId: z.string().min(1).max(256).optional(),
    hasMore: z.boolean(),
    cursor: z.record(z.string(), z.unknown()),
    /** Wipe epoch the collector read at sync start; gateway rejects stale writes (#551). */
    wipeEpoch: z.number().int().nonnegative().optional(),
    pendingPageId: z.string().uuid().optional(),
    /**
     * Forward-looking consent deadline (ISO 8601) the source reported on this page
     * (#927). Persisted on `sync_state` so the gateway derives a non-terminal
     * `auth-expiring` warning ahead of the deadline. `null` clears a stored
     * deadline (re-consent that no longer expires); omitted leaves it unchanged.
     */
    consentExpiresAt: z.string().nullable().optional(),
    watermark: z
      .object({
        guarantee: z.enum(["change-cut", "snapshot", "best-effort-scan", "observation"]),
        semanticTimeThrough: z.string().datetime().optional(),
        observedAt: z.string().datetime().optional(),
        upstreamCut: z.string().max(4096).optional(),
        detail: z.string().max(1000).optional(),
      })
      .optional(),
    meta: sourceSyncMetaBody.omit({ contentRetention: true }).optional(),
  })
  .superRefine((body, ctx) => {
    refuseBothSpellings(body, ctx);
    if (body.hasMore && body.watermark !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["watermark"],
        message: "A watermark may only be committed with a terminal sync page",
      });
    }
  });
export type UpsertWithCursorBody = z.infer<typeof upsertWithCursorBody>;
