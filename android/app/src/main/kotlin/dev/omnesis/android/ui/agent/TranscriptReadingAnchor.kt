// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

/**
 * Where a transcript is placed when its turns change: at the start of a finished reply the
 * reader has not been placed on yet, or wherever bottom-following puts it.
 *
 * A loaded conversation whose last turn is a finished assistant reply opens at that reply's top,
 * so the reader starts reading where the answer begins. A pending reply (the last turn is the
 * user's) or a busy agent keeps following the bottom. A reply the reader watched finish in the
 * foreground, or was already placed on, is left alone when the transcript reloads: a reload
 * renumbers turn ids, so a reply is recognised by its [ReplyMark] rather than its id.
 */
internal object TranscriptReadingAnchor {

    /** A reply as a reload still recognises it: the prompt it answers and its text. */
    data class ReplyMark(val prompt: String?, val text: String)

    data class Memory(
        /** The reply the reader was placed on or watched finish. */
        val settled: ReplyMark? = null,
        /** The id of the reply streaming while the app was in the foreground. */
        val watchingId: String? = null,
    )

    sealed interface Placement {
        /** Leave the bottom-following machinery in charge. */
        data object FollowBottom : Placement

        /** Leave the reader where they are. */
        data object Keep : Placement

        /** Put the top of this turn at the top of the visible area. */
        data class Reply(val turnId: String) : Placement
    }

    data class Step(val placement: Placement, val memory: Memory)

    fun step(turns: List<AgentTurn>, busy: Boolean, foreground: Boolean, memory: Memory): Step {
        val last = turns.lastOrNull() as? AgentTurn.Assistant
            ?: return Step(Placement.FollowBottom, memory.copy(watchingId = null))
        if (busy) {
            return Step(Placement.FollowBottom, memory.copy(watchingId = if (foreground) last.id else null))
        }
        val mark = mark(turns, last)
        return when {
            foreground && last.id == memory.watchingId -> Step(Placement.Keep, Memory(settled = mark))
            mark == memory.settled -> Step(Placement.Keep, memory.copy(watchingId = null))
            else -> Step(Placement.Reply(last.id), Memory(settled = mark))
        }
    }

    /**
     * The Morning brief conversation's row for [turnId]: a brief is placed with the separator
     * that heads its day, any other turn on its own row. Null when no row shows the turn.
     */
    fun briefRowIndex(rows: List<DailyBriefRow>, turnId: String): Int? {
        val at = rows.indexOfFirst { it.key == turnId }
        if (at < 0) return null
        return if (rows[at] is DailyBriefRow.Brief && at > 0 && rows[at - 1] is DailyBriefRow.Separator) at - 1 else at
    }

    private fun mark(turns: List<AgentTurn>, reply: AgentTurn.Assistant) = ReplyMark(
        prompt = turns.lastOrNull { it is AgentTurn.User }?.let { (it as AgentTurn.User).text },
        text = reply.parts.filterIsInstance<AgentPart.Text>().joinToString("\n\n") { it.text },
    )
}
