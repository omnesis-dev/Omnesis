// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

import dev.omnesis.android.transport.dto.DocumentInputDto
import dev.omnesis.android.transport.dto.DocumentMetadataDto
import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.serialization.json.JsonObject

/**
 * Composes a `DocumentInputDto` from a photo asset's merged analyzer
 * fragment. The single place every acquired signal gets folded into
 * content/title/tags so it is actually served by search, the agent, and
 * Briefs — never left stranded in `metadata.extra` alone. Operates on
 * [PhotoAssetRef] (not a MediaStore row directly) so this logic is
 * unit-testable without a device/emulator. Mirrors iOS's
 * `PhotosDocumentBuilder` exactly
 * (`ios/Sources/Omnesis/Photos/PhotosDocumentBuilder.swift`).
 */
object PhotosDocumentBuilder {

    private val dateFormatter = DateTimeFormatter.ofPattern("d MMM yyyy", Locale.US).withZone(ZoneOffset.UTC)

    /** `documentType` for a screenshot vs. a camera photo — the only queryable is-screenshot channel. */
    fun documentType(asset: PhotoAssetRef): String = if (asset.isScreenshot) "screenshot" else "photo"

    fun build(
        asset: PhotoAssetRef,
        providerId: String,
        sourceId: String,
        fragment: PhotoAnalysisFragment,
    ): DocumentInputDto {
        val docType = documentType(asset)
        val date = Instant.ofEpochSecond(asset.dateAddedSec)
        val title = composeTitle(documentType = docType, placeName = fragment.placeName, date = date)
        val content = composeContent(textLines = fragment.textLines, placeName = fragment.placeName, title = title)
        val tags = fragment.tags.toSortedSet().toList()
        val extractedText = fragment.textLines.joinToString("\n")
        val extractedContentHash = extractedText.ifEmpty { null }?.let { sha256Hex(it) }
        // A casual photo with no extracted text, no labels, and
        // no place name — little for the agent to reason about on its own,
        // so it shouldn't wake the Cognition Steward (the generic `lowSignal`
        // waker marker). A place name alone (folded into title/content
        // above) IS substantive signal — a geotagged photo with no other
        // analysis is still worth waking on.
        val lowSignal = fragment.textLines.isEmpty() && fragment.tags.isEmpty() && fragment.placeName == null

        val metadata = DocumentMetadataDto(
            documentType = docType,
            tags = tags.ifEmpty { null },
            lowSignal = if (lowSignal) true else null,
            extra = fragment.extra.takeIf { it.isNotEmpty() }?.let { JsonObject(it) },
        )

        return DocumentInputDto(
            providerId = providerId,
            sourceId = sourceId,
            externalId = asset.id,
            title = title,
            content = content,
            contentHash = sha256Hex(content),
            metadata = metadata,
            sourceCreatedAt = date.toString(),
            sourceUpdatedAt = Instant.ofEpochSecond(asset.dateModifiedSec).toString(),
            extractedContentHash = extractedContentHash,
        )
    }

    /**
     * `"Photo · Paris · 3 Mar 2024"` (or `"Screenshot · ..."`), place
     * omitted when the photo has no geotag — never a bare filename or
     * empty title, so even a text-less photo is retrievable by place/date.
     */
    fun composeTitle(documentType: String, placeName: String?, date: Instant): String {
        val noun = if (documentType == "screenshot") "Screenshot" else "Photo"
        val dateString = dateFormatter.format(date)
        return if (placeName != null) "$noun · $placeName · $dateString" else "$noun · $dateString"
    }

    /**
     * Folds OCR text / barcode payloads (already merged into
     * [textLines]) plus the place name into the searchable prose body.
     * Never empty — a text-less, place-less photo still gets its title
     * repeated as the body so content is never blank (a document that
     * "chunks to nothing" is invisible to the indexer).
     */
    fun composeContent(textLines: List<String>, placeName: String?, title: String): String {
        val lines = textLines.toMutableList()
        if (placeName != null) lines += "Place: $placeName"
        return if (lines.isEmpty()) title else lines.joinToString("\n")
    }

    private fun sha256Hex(content: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(content.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }
}
