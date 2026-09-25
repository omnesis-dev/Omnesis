// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import dev.omnesis.android.transport.dto.DirectAuditEvent
import dev.omnesis.android.transport.dto.DirectAuditSession
import java.time.ZoneId
import java.util.Locale
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pure-logic contract for the Direct half of the Audit screen. */
class DirectAuditHelpersTest {

    private fun session(explicitKey: String?, principalName: String? = null) = DirectAuditSession(
        id = "direct_session_example",
        principalName = principalName,
        explicitKey = explicitKey,
    )

    @Test
    fun explicitKeysNameTheirConversationOrWorkflow() {
        assertEquals(
            "Conversation conversation_example",
            directAuditSessionLabel(session("conversation:conversation_example")),
        )
        assertEquals(
            "Workflow workflow_example",
            directAuditSessionLabel(session("workflow:workflow_example")),
        )
    }

    @Test
    fun heuristicSessionsSaySo() {
        assertEquals("Grouped by activity", directAuditSessionLabel(session(null)))
    }

    @Test
    fun unknownKeysShowVerbatim() {
        assertEquals("handoff:example", directAuditSessionLabel(session("handoff:example")))
        assertEquals("bare-key", directAuditSessionLabel(session("bare-key")))
        assertEquals(":leading", directAuditSessionLabel(session(":leading")))
    }

    @Test
    fun agentNameFallsBackToExternalAgent() {
        assertEquals("Atlas", directAuditAgentName(session(null, "Atlas")))
        assertEquals("External agent", directAuditAgentName(session(null, null)))
        assertEquals("External agent", directAuditAgentName(session(null, "  ")))
    }

    @Test
    fun deletingASessionRemovesOnlyThatSession() {
        val state = DirectAuditUiState(
            loading = false,
            sessions = listOf(
                session(null).copy(id = "direct_session_one"),
                session(null).copy(id = "direct_session_two"),
            ),
        )
        val removed = removeDeletedDirectSession(state, "direct_session_one")
        assertEquals(listOf("direct_session_two"), removed.sessions.map { it.id })
    }

    @Test
    fun rawJsonSheetSortsKeysAndKeepsFullBytes() {
        assertEquals("null", auditRawJsonText(null))
        assertEquals(
            "{\n  \"a\": \"1\",\n  \"m\": [\n    \"x\"\n  ]\n}",
            auditRawJsonText(
                buildJsonObject {
                    put("m", buildJsonArray { add(JsonPrimitive("x")) })
                    put("a", JsonPrimitive("1"))
                },
            ),
        )
    }

    @Test
    fun transcriptDaysGroupByLocalDayWithoutReordering() {
        val zone = ZoneId.of("UTC")
        val locale = Locale.US
        // 2026-09-11 10:00 and 11:00 UTC, then 2026-09-12 09:00 UTC.
        val first = 1_789_120_800_000L
        val events = listOf(
            DirectAuditEvent(id = "a", createdAt = first),
            DirectAuditEvent(id = "b", createdAt = first + 3_600_000L),
            DirectAuditEvent(id = "c", createdAt = first + 82_800_000L),
        )
        val days = directTranscriptDays(
            events,
            nowMillis = first + 82_800_000L,
            zoneId = zone,
            locale = locale,
        )
        assertEquals(2, days.size)
        assertEquals(listOf("a", "b"), days[0].events.map { it.id })
        assertEquals(listOf("c"), days[1].events.map { it.id })
        assertEquals("Yesterday", days[0].heading)
        assertEquals("Today", days[1].heading)
    }

    @Test
    fun transcriptDaysWithoutTimeShareOneUnknownGroup() {
        val zone = ZoneId.of("UTC")
        val events = listOf(
            DirectAuditEvent(id = "a", createdAt = 0),
            DirectAuditEvent(id = "b", createdAt = -1),
        )
        val days = directTranscriptDays(events, nowMillis = 1_789_120_800_000L, zoneId = zone)
        assertEquals(1, days.size)
        assertEquals("Date unknown", days[0].heading)
    }

    @Test
    fun recordsWithoutResultsReadAsNoResult() {
        assertFalse(
            directRecordHasResult(
                buildJsonObject { put("tool", JsonPrimitive("fetch_many")) },
            ),
        )
        assertTrue(
            directRecordHasResult(
                buildJsonObject {
                    put("tool", JsonPrimitive("search_many"))
                    put(
                        "result",
                        buildJsonObject {
                            put("kind", JsonPrimitive("search.batch"))
                        },
                    )
                },
            ),
        )
    }
}
