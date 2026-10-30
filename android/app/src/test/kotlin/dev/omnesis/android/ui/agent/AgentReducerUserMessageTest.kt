// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AgentEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * A sent message shows at once as a transcript bubble keyed by its submission id. The
 * gateway's user-message event names the submissions it accepted, so that placeholder is
 * renamed rather than repeated; messages from other devices stay new turns.
 */
class AgentReducerUserMessageTest {

    private val S = "s"

    private fun sent(vararg bubbles: Pair<String, String>) =
        AgentChatState(turns = bubbles.map { AgentTurn.User(it.first, it.second) }, busy = true)

    @Test
    fun theOriginatorsPlaceholderIsRenamedNotRepeated() {
        val state = AgentReducer.reduce(sent("sub-1" to "hi"), AgentEvent.UserMessage(S, "u-1", "hi", listOf("sub-1")))
        assertEquals(listOf(AgentTurn.User("u-1", "hi")), state.turns)
    }

    @Test
    fun coalescedPlaceholdersCollapseIntoTheStampedTurnInTheFirstOnesPlace() {
        val before = sent("sub-1" to "first", "sub-2" to "second", "sub-3" to "third")
        val state = AgentReducer.reduce(before, AgentEvent.UserMessage(S, "u-1", "second\n\nthird", listOf("sub-2", "sub-3")))
        assertEquals(listOf(AgentTurn.User("sub-1", "first"), AgentTurn.User("u-1", "second\n\nthird")), state.turns)
    }

    @Test
    fun anotherDevicesMessageAndALegacyGatewaysMessageAreNewTurns() {
        var state = AgentReducer.reduce(sent("sub-1" to "hi"), AgentEvent.UserMessage(S, "u-1", "hi", listOf("sub-1")))
        state = AgentReducer.reduce(state, AgentEvent.UserMessage(S, "u-2", "from my laptop", listOf("someone-elses-id")))
        state = AgentReducer.reduce(state, AgentEvent.UserMessage(S, "u-3", "no receipt ids"))
        assertEquals(listOf("u-1", "u-2", "u-3"), state.turns.map { it.id })
    }

    @Test
    fun aStampedTurnArrivingAgainIsKeptOnce() {
        val once = AgentReducer.reduce(sent("sub-1" to "hi"), AgentEvent.UserMessage(S, "u-1", "hi", listOf("sub-1")))
        val again = AgentReducer.reduce(once, AgentEvent.UserMessage(S, "u-1", "hi", listOf("sub-1")))
        assertEquals(once.turns, again.turns)
        assertSame(once.turns.single(), again.turns.single())
    }
}
