// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.sources

import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.dto.SourceMetaEntry
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The id-to-icon walk against the shape a gateway really serves for
 * `/portal/source-meta.json`: one entry per source type, each carrying a PNG
 * data URI. The fixture is a handful of entries captured from a synthetic
 * gateway, decoded the way the transport decodes them. A source instance id
 * (`type:account`) must land on its type's icon without any descriptor.
 */
class SourceCatalogLiveShapeTest {
    private val meta: Map<String, SourceMetaEntry> = OmnesisJson.decodeFromString(
        javaClass.classLoader!!.getResource("source-meta-types.json")!!.readText(),
    )

    @Test
    fun `a source instance id resolves to its type's icon`() = runTest {
        val catalog = SourceCatalog()
        assertTrue(catalog.load({ emptyList() }, { meta }))
        for (id in listOf("whatsapp-messages:phone", "apple-health:ios-example", "things:local", "obsidian-notes:Personal", "browser-history:chrome", "android-call-log")) {
            val model = catalog.iconModel(id)
            assertNotNull("no icon for $id", model.imageData)
            assertTrue("not a data uri for $id: ${model.imageData?.take(30)}", model.imageData!!.startsWith("data:image/"))
        }
    }
}
