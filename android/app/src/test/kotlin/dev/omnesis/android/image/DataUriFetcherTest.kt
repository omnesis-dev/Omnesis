// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.image

import android.content.Context
import android.net.Uri
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import coil.ImageLoader
import coil.fetch.SourceResult
import coil.request.Options
import dev.omnesis.android.designsystem.image.DataUriFetcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Guards the fix for app-wide blank source icons: Coil 2.x can't fetch `data:` URIs,
 * and the gateway delivers every source/provider icon as one. [DataUriFetcher] must
 * base64-decode the payload and tag the MIME so Coil's decoders take over. The
 * pre-existing screenshot fixtures all leave `imageData` null and never exercised
 * this path, which is exactly why the original regression was invisible.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DataUriFetcherTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private fun options() = Options(context)
    private fun loader() = ImageLoader.Builder(context).build()

    @Test
    fun `decodes base64 png data uri to bytes with mime`() = runTest {
        val raw = byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
        val b64 = Base64.encodeToString(raw, Base64.NO_WRAP)
        val result = DataUriFetcher(Uri.parse("data:image/png;base64,$b64"), options()).fetch()
        result as SourceResult
        assertEquals("image/png", result.mimeType)
        assertArrayEquals(raw, result.source.source().readByteArray())
    }

    @Test
    fun `decodes base64 svg data uri preserving payload`() = runTest {
        val svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"/>"
        val b64 = Base64.encodeToString(svg.toByteArray(), Base64.NO_WRAP)
        val result = DataUriFetcher(Uri.parse("data:image/svg+xml;base64,$b64"), options()).fetch()
        result as SourceResult
        assertEquals("image/svg+xml", result.mimeType)
        assertEquals(svg, result.source.source().readUtf8())
    }

    @Test
    fun `preserves base64 payloads containing url-special chars`() = runTest {
        // Bytes whose standard-base64 encoding contains + and / — must survive Uri parsing.
        val raw = ByteArray(48) { (it * 5 + 251).toByte() }
        val b64 = Base64.encodeToString(raw, Base64.NO_WRAP)
        val result = DataUriFetcher(Uri.parse("data:image/png;base64,$b64"), options()).fetch()
        result as SourceResult
        assertArrayEquals(raw, result.source.source().readByteArray())
    }

    @Test
    fun `factory accepts data scheme and rejects http`() {
        val factory = DataUriFetcher.Factory()
        assertNotNull(factory.create(Uri.parse("data:image/png;base64,AAAA"), options(), loader()))
        assertNull(factory.create(Uri.parse("https://example.com/icon.png"), options(), loader()))
    }
}
