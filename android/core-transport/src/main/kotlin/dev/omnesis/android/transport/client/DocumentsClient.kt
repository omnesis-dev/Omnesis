// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.dto.DocumentInputDto
import dev.omnesis.android.transport.dto.IngestDocumentsBody
import dev.omnesis.android.transport.dto.IngestDocumentsResponse
import dev.omnesis.android.transport.dto.ReconcileDocumentsBody
import dev.omnesis.android.transport.dto.ReconcileDocumentsResponse
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.http.postJson

/**
 * The document-ingest push surface: full-text-searchable content, alongside
 * the structured rows [AnalyticsClient] pushes. This is the generic gateway
 * capability a device-hosted source drains its documents through — e.g. the
 * Android port of the iOS `GatewayClient.ingestDocuments`, used by call log
 * (`android-call-log:local`) to push its day-aggregate documents.
 *
 * Requires a token carrying a `write:*` scope, or a `write:<sourceType>` scope
 * matching every document's source type.
 */
class DocumentsClient(private val http: GatewayHttp) {

    /** `POST /documents` — upsert a batch of documents by (providerId, sourceId, externalId). */
    suspend fun ingest(documents: List<DocumentInputDto>): IngestDocumentsResponse =
        http.postJson("documents", IngestDocumentsBody(documents))

    /**
     * `POST /documents/reconcile` — tell the gateway everything
     * `(providerId, sourceId)` currently holds. What the snapshot omits is
     * recorded with a deadline rather than deleted; see [ReconcileDocumentsBody].
     */
    suspend fun reconcile(
        providerId: String,
        sourceId: String,
        presentExternalIds: List<String>,
    ): ReconcileDocumentsResponse = http.postJson(
        "documents/reconcile",
        ReconcileDocumentsBody(providerId = providerId, sourceId = sourceId, presentExternalIds = presentExternalIds),
    )
}
