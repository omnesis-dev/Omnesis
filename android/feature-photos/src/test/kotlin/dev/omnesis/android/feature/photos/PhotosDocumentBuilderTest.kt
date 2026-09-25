// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

import java.security.MessageDigest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhotosDocumentBuilderTest {

    private fun asset(
        id: String = "1",
        isScreenshot: Boolean = false,
        dateAddedSec: Long = 1_710_000_000L, // 2024-03-09
    ) = PhotoAssetRef(
        id = id,
        dateAddedSec = dateAddedSec,
        dateModifiedSec = dateAddedSec,
        isScreenshot = isScreenshot,
        uri = "content://media/external/images/media/$id",
    )

    private fun sha256Hex(content: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(content.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    // --- Title contract: never a bare filename or empty title ---

    @Test
    fun `textless placeless photo still gets a non-empty title`() {
        val doc = PhotosDocumentBuilder.build(
            asset = asset(),
            providerId = "photos",
            sourceId = "photos:local",
            fragment = PhotoAnalysisFragment(),
        )

        assertFalse(doc.title.isEmpty())
        assertTrue(doc.title.startsWith("Photo ·"))
        assertFalse("content must never be empty", doc.content.isEmpty())
    }

    @Test
    fun `screenshot gets screenshot noun in title and document type`() {
        val doc = PhotosDocumentBuilder.build(
            asset = asset(isScreenshot = true),
            providerId = "photos",
            sourceId = "photos:local",
            fragment = PhotoAnalysisFragment(),
        )

        assertTrue(doc.title.startsWith("Screenshot ·"))
        assertEquals("screenshot", doc.metadata.documentType)
    }

    @Test
    fun `geotagged textless photo is retrievable by place via title`() {
        val doc = PhotosDocumentBuilder.build(
            asset = asset(),
            providerId = "photos",
            sourceId = "photos:local",
            fragment = PhotoAnalysisFragment(placeName = "Paris"),
        )

        assertTrue(doc.title.contains("Paris"))
    }

    // --- Serving rule: every signal folds into content/title/tags, never extra alone ---

    @Test
    fun `ocr text folds into content`() {
        val doc = PhotosDocumentBuilder.build(
            asset = asset(),
            providerId = "photos",
            sourceId = "photos:local",
            fragment = PhotoAnalysisFragment(textLines = listOf("RECEIPT — Total \$42.00")),
        )

        assertTrue(doc.content.contains("RECEIPT — Total \$42.00"))
    }

    @Test
    fun `extracted text and labels and barcode fold into content and tags`() {
        val fragment = PhotoAnalysisFragment(
            textLines = listOf("TRAIL ENTRANCE", "https://example.com/promo"),
            tags = listOf("dog", "beach", "https://example.com/promo"),
            placeName = "Example Bay",
        )
        val doc = PhotosDocumentBuilder.build(
            asset = asset(),
            providerId = "photos",
            sourceId = "photos:local",
            fragment = fragment,
        )

        assertTrue(doc.content.contains("TRAIL ENTRANCE"))
        assertTrue(doc.content.contains("Example Bay"))
        assertEquals(setOf("dog", "beach", "https://example.com/promo"), doc.metadata.tags?.toSet())
    }

    @Test
    fun `raw extra data never substitutes for tags or content`() {
        val fragment = PhotoAnalysisFragment(
            tags = listOf("mountain"),
            extra = mapOf("sceneLabelConfidence" to JsonObject(mapOf("mountain" to JsonPrimitive(0.87)))),
        )
        val doc = PhotosDocumentBuilder.build(
            asset = asset(),
            providerId = "photos",
            sourceId = "photos:local",
            fragment = fragment,
        )

        assertEquals(listOf("mountain"), doc.metadata.tags)
        val extra = doc.metadata.extra!!.jsonObject
        assertEquals(0.87, extra["sceneLabelConfidence"]!!.jsonObject["mountain"]!!.let { (it as JsonPrimitive).double }, 0.0)
    }

    // --- extractedContentHash ---

    @Test
    fun `extractedContentHash is nil when no text extracted`() {
        val doc = PhotosDocumentBuilder.build(
            asset = asset(),
            providerId = "photos",
            sourceId = "photos:local",
            fragment = PhotoAnalysisFragment(placeName = "Paris"),
        )

        assertNull(doc.extractedContentHash)
    }

    @Test
    fun `extractedContentHash is sha256 of extracted text`() {
        val doc = PhotosDocumentBuilder.build(
            asset = asset(),
            providerId = "photos",
            sourceId = "photos:local",
            fragment = PhotoAnalysisFragment(textLines = listOf("hello world")),
        )

        assertEquals(sha256Hex("hello world"), doc.extractedContentHash)
    }

    // --- lowSignal marker ---

    @Test
    fun `casual textless tagless photo is marked lowSignal`() {
        val doc = PhotosDocumentBuilder.build(
            asset = asset(),
            providerId = "photos",
            sourceId = "photos:local",
            fragment = PhotoAnalysisFragment(),
        )

        assertEquals(true, doc.metadata.lowSignal)
    }

    @Test
    fun `geotagged photo with no other signal is not lowSignal`() {
        // A place name alone (no OCR/labels) is still substantive
        // signal — a geotagged photo is worth waking on even without other
        // analysis.
        val doc = PhotosDocumentBuilder.build(
            asset = asset(),
            providerId = "photos",
            sourceId = "photos:local",
            fragment = PhotoAnalysisFragment(placeName = "Paris"),
        )

        assertNull(doc.metadata.lowSignal)
    }

    @Test
    fun `photo with ocr text is not lowSignal`() {
        val doc = PhotosDocumentBuilder.build(
            asset = asset(),
            providerId = "photos",
            sourceId = "photos:local",
            fragment = PhotoAnalysisFragment(textLines = listOf("some text")),
        )

        assertNull(doc.metadata.lowSignal)
    }

    @Test
    fun `photo with only labels is not lowSignal`() {
        val doc = PhotosDocumentBuilder.build(
            asset = asset(),
            providerId = "photos",
            sourceId = "photos:local",
            fragment = PhotoAnalysisFragment(tags = listOf("beach")),
        )

        assertNull(doc.metadata.lowSignal)
    }

    // --- externalId / providerId / sourceId plumbing ---

    @Test
    fun `externalId providerId sourceId are passed through`() {
        val doc = PhotosDocumentBuilder.build(
            asset = asset(id = "icloud-abc123"),
            providerId = "photos",
            sourceId = "photos:local",
            fragment = PhotoAnalysisFragment(),
        )

        assertEquals("icloud-abc123", doc.externalId)
        assertEquals("photos", doc.providerId)
        assertEquals("photos:local", doc.sourceId)
    }
}
