// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AgentEvent
import dev.omnesis.android.transport.dto.OmnesisJson
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The Android arm of the cross-client Deep Research cassette test (#748).
 *
 * Drives the CANONICAL synthetic conversation — the exact
 * `evals/universes/japan-trip/agent-demos/japan-trip-spend.jsonl` the demo gateway
 * plays and the portal / iOS twins assert against — through the Android client's REAL
 * pipeline: every wire line is JSON-DECODED with the same `OmnesisJson.decodeFromString<AgentEvent>`
 * the SSE loop uses, then reduced through `AgentReducer.reduce`. It then asserts the
 * terminal state the user actually sees.
 *
 * The point is to cross the JSON decoder, not hand-build events. The earlier researcher-card
 * reducer tests constructed `AgentEvent` values in memory and bypassed decoding — which is
 * precisely why the "panels show 0 documents" decode bug (a thin wrapped child payload with no
 * `sessionId`/`messageId` dropping the whole sub-agent event) shipped on iOS without a CI
 * failure. The Android decoder already tolerated the thin child payload (the wrapped `event`
 * recurses through the same serializer, and every payload field has a default), so this test
 * locks that contract in: a future regression that drops the nested search hits would collapse
 * the docs counts to `[0, 0, 0]` and fail here.
 *
 * All cassette data is invented (privacy rule) — it is the synthetic universe fixture.
 */
class DeepResearchCassetteTest {

    /**
     * Locate the cassette by walking up from `user.dir` until a parent contains
     * `evals/universes/japan-trip`, then read `agent-demos/japan-trip-spend.jsonl`.
     * Robust against the module the test runs from (Gradle sets `user.dir` to the
     * subproject dir, not the repo root).
     */
    private fun cassetteText(): String {
        val relative = "evals/universes/japan-trip"
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            if (File(dir, relative).isDirectory) {
                return File(dir, "$relative/agent-demos/japan-trip-spend.jsonl").readText()
            }
            dir = dir.parentFile
        }
        error("could not locate $relative above ${System.getProperty("user.dir")}")
    }

    /**
     * Decode every event line of the cassette through the REAL `AgentEvent` decoder.
     * Placeholders are substituted in the raw text first; blank / `#` comment lines are
     * skipped; each remaining line is `{afterMs, event:{type,payload}}`, and only the
     * `event` envelope is decoded.
     */
    private fun decodeCassette(): List<AgentEvent> {
        val raw = cassetteText()
            .replace("\$SESSION", "sess-test")
            .replace("\$MSG", "msg-test")
            .replace("\$DOC_", "doc-")
        return raw.lineSequence()
            .map { it.trim() }
            .filter { it.isNotEmpty() && !it.startsWith("#") }
            .map { line ->
                // Pull the `event` envelope out of the wrapper, re-encode it to a string,
                // then decode it with the SAME decoder the SSE loop uses.
                val event = OmnesisJson.parseToJsonElement(line).jsonObject["event"]
                    ?: error("cassette line is not a {afterMs, event} wrapper: $line")
                val eventJson = OmnesisJson.encodeToString(JsonElement.serializer(), event)
                OmnesisJson.decodeFromString<AgentEvent>(eventJson)
            }
            .toList()
    }

    /** Drive the decoded cassette through a fresh state and return the terminal state. */
    private fun driveCassette(): AgentChatState {
        var state = AgentChatState()
        val events = decodeCassette()
        assertTrue("cassette decoded to zero events", events.isNotEmpty())
        for (event in events) state = AgentReducer.reduce(state, event)
        return state
    }

    private fun terminalAssistant(state: AgentChatState): AgentTurn.Assistant =
        state.turns.asReversed().filterIsInstance<AgentTurn.Assistant>().first()

    /** Concatenate every text part of the assistant turn (the streamed report prose). */
    private fun reportText(assistant: AgentTurn.Assistant): String =
        assistant.parts.filterIsInstance<AgentPart.Text>().joinToString("") { it.text }

    // --- terminal state ---

    @Test
    fun three_researcher_panels_each_carry_its_documents() {
        // The cross-client decode contract: each panel carries its search hits. A regression
        // that drops the nested wrapped-child search results would collapse these to [0, 0, 0].
        val panels = AgentReducer.researchPanels(driveCassette())
        assertEquals(listOf("history-sweep", "source-digest", "history-sweep"), panels.map { it.specialist })
        assertEquals(listOf(7, 3, 5), panels.map { it.docs.size })
        assertTrue(
            "the bank researcher's first hit survived the decode",
            panels.first().docs.any { (it.title ?: "").contains("Tokyo Riverside Hotel") },
        )
    }

    @Test
    fun report_prose_streams_onto_the_turn() {
        val text = reportText(terminalAssistant(driveCassette()))
        assertTrue("report names the travel agency", text.contains("Studio Northstar"))
        assertTrue("report carries the reconciled total", text.contains("3,700"))
        assertTrue("report carries the largest line item", text.contains("168,000"))
    }

    @Test
    fun report_artifact_carries_terminal_state_and_verification() {
        val state = driveCassette()
        val artifact = terminalAssistant(state).reportArtifact
        assertNotNull("the deep_research.summary should have folded on", artifact)
        assertEquals("answer_complete", artifact?.stoppedReason)
        assertEquals(6, artifact?.verification?.quotesChecked)
        assertEquals(6, artifact?.verification?.quotesVerified)
        // The merged citation set landed (the citations.update event).
        assertTrue("merged citation set landed", state.citations.size >= 6)
    }

    @Test
    fun turn_is_done() {
        assertNotNull(
            "message.end should have stamped a stopReason",
            terminalAssistant(driveCassette()).stopReason,
        )
    }
}
