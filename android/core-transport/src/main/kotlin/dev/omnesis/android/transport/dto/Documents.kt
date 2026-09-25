// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * Wire DTOs for `POST /documents` — the generic document-ingest surface a
 * device-hosted source uses to push full-text-searchable content, alongside
 * (or instead of) `POST /analytics/ingest`'s structured rows.
 *
 * Gateway reference: `packages/gateway/src/http/routes/documents.ts`
 * (`ingestDocumentsBody`) and `DocumentService`. `DocumentInput`'s shape
 * mirrors `packages/types/src/document.ts`.
 */

/** One person mentioned by a document. Mirrors `PersonMention` in `packages/types/src/document.ts`. */
@Serializable
data class PersonMentionDto(
    val role: String,
    val name: String? = null,
    val emails: List<String>? = null,
    val phones: List<String>? = null,
    val isSelf: Boolean? = null,
)

/**
 * The subset of `DocumentMetadata` a device-hosted source needs. Other fields
 * (`sourceUrl`, `appUrl`, `relevanceScore`, ...) aren't populated by this
 * client — omitted fields are absent from the wire body, not sent as null.
 */
@Serializable
data class DocumentMetadataDto(
    val documentType: String? = null,
    val tags: List<String>? = null,
    val people: List<PersonMentionDto>? = null,
    val rollingAggregate: Boolean? = null,
    /**
     * A casual, low-signal document (e.g. a photo without extracted text) —
     * shared consumers (the background agent's wake heuristics) skip waking
     * on it generically. Mirrors `DocumentMetadata.lowSignal` in
     * `packages/types/src/document.ts`.
     */
    val lowSignal: Boolean? = null,
    val extra: JsonElement? = null,
)

/** One document to ingest. Mirrors `DocumentInput` in `packages/types/src/document.ts`. */
@Serializable
data class DocumentInputDto(
    val providerId: String,
    val sourceId: String,
    val externalId: String,
    val title: String,
    val content: String,
    val contentHash: String,
    val metadata: DocumentMetadataDto,
    val sourceCreatedAt: String,
    val sourceUpdatedAt: String,
    /**
     * SHA-256 of the raw extracted text before any per-provider rendering
     * wrapper (e.g. OCR'd text). Purely for idempotent re-ingest of the same
     * asset — not cross-source dedup. Mirrors `Document.extractedContentHash`
     * in `packages/types/src/document.ts`.
     */
    val extractedContentHash: String? = null,
)

/** `POST /documents`. */
@Serializable
data class IngestDocumentsBody(
    val documents: List<DocumentInputDto>,
)

@Serializable
data class IngestDocumentsResponse(
    val ingested: Int = 0,
    /** Per-source rejections — same shape as the analytics-ingest response. */
    val rejected: List<PushRejection> = emptyList(),
)

/**
 * `POST /documents/reconcile` — snapshot-based deletion. The gateway diffs
 * [presentExternalIds] against what it holds for `(providerId, sourceId)`. A
 * document the snapshot omits is not deleted: the omission is recorded with a
 * deadline, and only several later snapshots that agree, spanning a minimum
 * span of time, turn it into a deletion. A snapshot that names the document
 * again cancels the record.
 *
 * A push client that has no server-pushed change-notification for deletions
 * (e.g. Android's `CallLog.Calls`, which a user can delete rows from directly)
 * calls this with the full current set of external ids on each sync pass
 * instead of tracking a diff itself. Send it only for a read you can vouch for:
 * an omitted snapshot has no effect at all, while one built from a permission
 * that lapsed mid-read starts a clock on rows that still exist.
 */
@Serializable
data class ReconcileDocumentsBody(
    val providerId: String,
    val sourceId: String,
    val presentExternalIds: List<String>,
)

/**
 * The reconcile's own deletions — which, under the deadline rule, is none: a
 * snapshot records what it omits and the gateway's absence sweep is what
 * eventually removes it.
 */
@Serializable
data class ReconcileDocumentsResponse(
    val deleted: Int = 0,
    val deletedIds: List<String> = emptyList(),
)
