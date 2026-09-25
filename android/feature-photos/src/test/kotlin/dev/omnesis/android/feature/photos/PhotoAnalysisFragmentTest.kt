// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.double
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhotoAnalysisFragmentTest {

    @Test
    fun `merge concatenates text lines and tags`() {
        val ocr = PhotoAnalysisFragment(textLines = listOf("hello"), tags = emptyList())
        val labels = PhotoAnalysisFragment(textLines = emptyList(), tags = listOf("beach", "sunset"))

        val merged = PhotoAnalysisFragment.merge(listOf(ocr, labels))

        assertEquals(listOf("hello"), merged.textLines)
        assertEquals(listOf("beach", "sunset"), merged.tags)
    }

    @Test
    fun `merge last place name wins`() {
        val first = PhotoAnalysisFragment(placeName = "Paris")
        val second = PhotoAnalysisFragment(placeName = null)

        // Only one analyzer (the place analyzer) ever sets placeName in
        // practice, but merge order shouldn't silently drop a later null
        // over an earlier real value.
        val merged = PhotoAnalysisFragment.merge(listOf(first, second))

        assertEquals("Paris", merged.placeName)
    }

    @Test
    fun `merge unions extra keeping later on conflict`() {
        val first = PhotoAnalysisFragment(extra = mapOf("latitude" to JsonPrimitive(1.0), "shared" to JsonPrimitive("a")))
        val second = PhotoAnalysisFragment(extra = mapOf("longitude" to JsonPrimitive(2.0), "shared" to JsonPrimitive("b")))

        val merged = PhotoAnalysisFragment.merge(listOf(first, second))

        assertEquals(1.0, merged.extra["latitude"]!!.let { (it as JsonPrimitive).double }, 0.0)
        assertEquals(2.0, merged.extra["longitude"]!!.let { (it as JsonPrimitive).double }, 0.0)
        assertEquals(JsonPrimitive("b"), merged.extra["shared"])
    }

    @Test
    fun `merge of empty list is an empty fragment`() {
        val merged = PhotoAnalysisFragment.merge(emptyList())

        assertTrue(merged.textLines.isEmpty())
        assertTrue(merged.tags.isEmpty())
        assertNull(merged.placeName)
        assertTrue(merged.extra.isEmpty())
    }
}
