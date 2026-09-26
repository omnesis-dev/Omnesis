// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.sources

import dev.omnesis.android.transport.dto.SerializedDescriptor
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class SourceCatalogTest {
    private fun descriptor(typeId: String) =
        SerializedDescriptor(typeId = typeId, name = typeId.replaceFirstChar { it.uppercase() })

    @Test
    fun `a failed fetch keeps the catalog it already has`() = runTest {
        val catalog = SourceCatalog()
        assertTrue(catalog.load({ listOf(descriptor("gmail")) }, { emptyMap() }))
        assertTrue(catalog.isLoaded)
        assertEquals("Gmail", catalog.label("gmail:example"))

        // The gateway refuses the next fetch entirely — the icons drawn from
        // the first one must survive it.
        assertFalse(catalog.load({ throw IOException("401") }, { throw IOException("401") }))
        assertTrue(catalog.isLoaded)
        assertEquals("Gmail", catalog.label("gmail:example"))
    }

    @Test
    fun `a load cancelled with its session writes nothing and asks no more`() = runTest {
        // A rebuild cancels the old session's load after clearing the catalog;
        // what the old gateway sent must not land in the cleared one.
        val catalog = SourceCatalog()
        var metaFetches = 0
        val cancelled = runCatching {
            catalog.load({ throw CancellationException("session ended") }, { metaFetches += 1; emptyMap() })
        }.exceptionOrNull()
        assertTrue(cancelled is CancellationException)
        assertEquals(0, metaFetches)

        val late = runCatching {
            catalog.load({ listOf(descriptor("gmail")) }, { throw CancellationException("session ended") })
        }.exceptionOrNull()
        assertTrue(late is CancellationException)
        assertFalse(catalog.isLoaded)
        assertEquals("gmail", catalog.label("gmail:example"))
    }

    @Test
    fun `a session whose first fetch fails is not loaded, and loads on the next ask`() = runTest {
        val catalog = SourceCatalog()
        assertFalse(catalog.load({ throw IOException("no token yet") }, { throw IOException("no token yet") }))
        assertFalse(catalog.isLoaded)

        var fetches = 0
        assertTrue(catalog.load({ fetches += 1; listOf(descriptor("notes")) }, { emptyMap() }))
        assertTrue(catalog.isLoaded)
        assertEquals(1, fetches)
    }

    @Test
    fun `failing descriptors do not stop the metadata from loading`() = runTest {
        // The metadata alone carries every icon; a descriptor fetch that
        // depends on which collectors are online must not hold it hostage.
        val catalog = SourceCatalog()
        val meta = mapOf("gmail" to dev.omnesis.android.transport.dto.SourceMetaEntry(icon = "data:image/png;base64,AAAA", label = "Gmail"))
        assertTrue(catalog.load({ throw IOException("collectors offline") }, { meta }))
        assertEquals("data:image/png;base64,AAAA", catalog.iconModel("gmail:someone@example.com").imageData)
        // Not everything landed, so a later ask retries.
        assertFalse(catalog.isLoaded)
    }

    @Test
    fun `ensureLoaded asks again after a half load and stops once whole`() = runTest {
        val catalog = SourceCatalog()
        var descriptorFetches = 0
        var metaFetches = 0
        val descriptorsDown: suspend () -> List<SerializedDescriptor> = { descriptorFetches += 1; throw IOException("collectors offline") }
        val descriptorsUp: suspend () -> List<SerializedDescriptor> = { descriptorFetches += 1; listOf(descriptor("notes")) }
        val meta: suspend () -> Map<String, dev.omnesis.android.transport.dto.SourceMetaEntry> = { metaFetches += 1; emptyMap() }

        // Half a catalog is something (the metadata landed) but not whole, so
        // the next ask fetches again.
        assertTrue(catalog.ensureLoaded(descriptorsDown, meta))
        assertFalse(catalog.isLoaded)
        assertTrue(catalog.ensureLoaded(descriptorsDown, meta))
        assertFalse(catalog.isLoaded)
        assertEquals(2, descriptorFetches)
        assertEquals(2, metaFetches)

        assertTrue(catalog.ensureLoaded(descriptorsUp, meta))
        assertTrue(catalog.isLoaded)
        assertTrue(catalog.ensureLoaded(descriptorsUp, meta))
        assertEquals(3, descriptorFetches)
        assertEquals(3, metaFetches)
    }

    @Test
    fun `missing metadata does not stop the descriptors from loading`() = runTest {
        val catalog = SourceCatalog()
        assertTrue(catalog.load({ listOf(descriptor("files")) }, { throw IOException("meta down") }))
        assertFalse(catalog.isLoaded)
        assertEquals("Files", catalog.label("files:example"))
        assertNull(catalog.accentColor("files:example"))
    }

    @Test
    fun `clearing forgets what was loaded`() = runTest {
        val catalog = SourceCatalog()
        assertTrue(catalog.load({ listOf(descriptor("gmail")) }, { emptyMap() }))
        catalog.clear()
        assertFalse(catalog.isLoaded)
    }
}
