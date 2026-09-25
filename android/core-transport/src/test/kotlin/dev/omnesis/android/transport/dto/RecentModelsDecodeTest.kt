// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * `GET /admin/models/recent/:capability` wire shape: assign + activate
 * entries decode, unknown extras are ignored, and a missing entries list
 * defaults to empty (hide the section).
 */
class RecentModelsDecodeTest {

    @Test
    fun decodesAssignAndActivateEntries() {
        val parsed = OmnesisJson.decodeFromString<RecentModelsResponse>(
            """
            {
              "capability": "agent",
              "entries": [
                {
                  "assignment": "northstar/llama-vision-8b",
                  "providerId": "northstar",
                  "providerLabel": "Studio Northstar",
                  "modelName": "llama-vision-8b",
                  "apply": { "type": "assign", "value": "northstar/llama-vision-8b" }
                },
                {
                  "assignment": "local/northstar-chat-1b.Q4_K_M",
                  "providerId": "local",
                  "providerLabel": "Local",
                  "modelName": "Northstar Chat",
                  "apply": { "type": "activate", "catalogId": "northstar-chat-1b.Q4_K_M", "catalogRole": "agent" }
                }
              ]
            }
            """.trimIndent(),
        )
        assertEquals("agent", parsed.capability)
        assertEquals(2, parsed.entries.size)
        assertEquals(
            RecentModelApply(type = "assign", value = "northstar/llama-vision-8b"),
            parsed.entries[0].apply,
        )
        assertEquals(
            RecentModelApply(
                type = "activate",
                catalogId = "northstar-chat-1b.Q4_K_M",
                catalogRole = "agent",
            ),
            parsed.entries[1].apply,
        )
        assertNull(parsed.entries[0].apply.catalogId)
    }

    @Test
    fun missingEntriesDefaultsToEmpty() {
        val parsed = OmnesisJson.decodeFromString<RecentModelsResponse>("""{"capability":"ocr"}""")
        assertEquals("ocr", parsed.capability)
        assertEquals(emptyList<RecentModelEntry>(), parsed.entries)
    }
}
