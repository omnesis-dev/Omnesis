// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AgentDocRef
import dev.omnesis.android.transport.dto.AgentToolResult
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class AgentToolCardsTest {
    /**
     * The fixture the gateway generates from `AGENT_TOOL_CARDS`. Unit tests run from the module
     * directory; the copy lives beside the transport module's wire fixtures, inside `android/`,
     * which is all the native dispatcher syncs.
     */
    private fun fixture(): Map<String, JsonObject> {
        val file = File("../core-transport/src/test/resources/wire-fixtures/agent-tool-cards.json")
        val root = Json.parseToJsonElement(file.readText()).jsonObject
        return root.mapValues { it.value.jsonObject }
    }

    private fun JsonObject.string(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull

    @Test
    fun tableIsTheOneEveryClientFollows() {
        val expected = fixture()
        assertEquals(expected.keys, AgentToolCards.table.keys)
        for ((tool, entry) in expected) {
            val card = AgentToolCards.table.getValue(tool)
            assertEquals(tool, entry.string("presentation"), card.presentation.wire)
            assertEquals(tool, entry.string("label"), card.label)
            assertEquals(tool, entry.string("icon"), card.icon)
            assertEquals(tool, entry["scrollsContent"]?.jsonPrimitive?.booleanOrNull ?: false, card.scrollsContent)
            card.icon?.let { assertNotNull("no icon for $it", AgentToolCards.icons[it]) }
        }
    }

    @Test
    fun dismissesExactlyTheEphemeralCards() {
        for ((tool, entry) in fixture()) {
            val presentation = entry.string("presentation")
            assertEquals(
                tool,
                presentation == "ephemeral" || presentation == "subagent",
                tool in AgentReducer.EPHEMERAL_TOOLS,
            )
            assertEquals(tool, presentation == "silent", tool in AgentToolCards.silentTools)
        }
    }

    @Test
    fun renamedDateToolsKeepTheirCard() {
        assertEquals("Check dates", AgentToolCards.label("time_index_query"))
        assertEquals(AgentToolCards.icon("temporal_query"), AgentToolCards.icon("time_index_query"))
        assertEquals(true, "time_index_add" in AgentReducer.EPHEMERAL_TOOLS)
    }

    @Test
    fun unknownToolKeepsItsName() {
        assertEquals("annotation_future_action", AgentToolCards.label("annotation_future_action"))
    }

    @Test
    fun aWikiReadIsTheFirstDocumentOfItsBatch() {
        val page = AgentToolResult.DocumentResult(
            ref = AgentDocRef(documentId = "wiki-doc", sourceId = "brain-knowledge", title = "Pottery workshop"),
            document = AgentToolResult.DocumentResult.DocBody("Opens at nine."),
        )
        val batch = AgentToolResult.DocumentBatch(listOf(AgentToolResult.ErrorResult("not_found", "gone"), page))
        assertEquals(page, agentDocumentRead(batch))
        assertEquals(page, agentDocumentRead(page))
        assertNull(agentDocumentRead(null))
    }
}
