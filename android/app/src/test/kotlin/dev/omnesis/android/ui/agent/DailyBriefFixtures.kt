// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AssistantPart
import dev.omnesis.android.transport.dto.ChatMessage
import dev.omnesis.android.transport.dto.ConversationOrigin
import dev.omnesis.android.transport.dto.DailyBriefItemDto
import dev.omnesis.android.transport.dto.DailyBriefItemsDto
import dev.omnesis.android.transport.dto.DailyBriefMessageRef
import dev.omnesis.android.transport.dto.DailyBriefReactionDto
import dev.omnesis.android.transport.dto.DailyBriefReactionKind
import dev.omnesis.android.transport.dto.DailyBriefReactionReceiptDto
import dev.omnesis.android.transport.dto.DailyBriefSourceDto
import dev.omnesis.android.transport.dto.DailyBriefTaskDto
import dev.omnesis.android.transport.dto.UserPart
import dev.omnesis.android.transport.GatewayException
import kotlinx.coroutines.CompletableDeferred
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** An invented Morning brief conversation, shared by the brief's interaction and screenshot tests. */
object DailyBriefFixtures {
    const val CONVERSATION_ID = "conv_morning_brief"
    val zone: ZoneId = ZoneId.of("Europe/London")

    /** Wednesday 14 October 2026, mid-morning in London. */
    val now: Instant = Instant.parse("2026-10-14T09:00:00Z")

    private fun brief(text: String) = ChatMessage.Assistant(listOf(AssistantPart.Text(text)))
    private fun user(text: String) = ChatMessage.User(listOf(UserPart.Text(text)))

    const val ANSWER = "Start with the venue deposit; the quote holds the date until Friday."

    /**
     * [days] briefs ending today, each followed by a reply and its answer except the second to
     * last, which nobody answered. Today's answer is [latestAnswer]; null leaves today's brief
     * unanswered, the last turn of the conversation.
     */
    fun conversation(days: Int = 3, latestAnswer: String? = ANSWER): Pair<ConversationOrigin, List<ChatMessage>> {
        val messages = mutableListOf<ChatMessage>()
        val refs = mutableListOf<DailyBriefMessageRef>()
        val last = LocalDate.of(2026, 10, 14)
        for (n in 0 until days) {
            val day = last.minusDays((days - 1 - n).toLong())
            val id = "mb_$day"
            refs += DailyBriefMessageRef(
                day = day.toString(),
                messageIndex = messages.size,
                messageId = id,
                sentAt = if (n == days - 1) "2026-10-14T06:05:00.000Z" else null,
            )
            messages += brief(briefText(day))
            val answer = if (n == days - 1) latestAnswer else ANSWER
            if (n != days - 2 && answer != null) {
                messages += user("What is the first thing to do on ${day.dayOfWeek.name.lowercase()}?")
                messages += brief(answer)
            }
        }
        val origin = ConversationOrigin(kind = ConversationOrigin.DAILY_BRIEF_KIND, runId = "run_example", briefs = refs)
        return origin to messages
    }

    fun briefText(day: LocalDate): String =
        if (day == LocalDate.of(2026, 10, 14)) {
            "Good morning. The venue deposit is due on Friday and the tuner confirmed Thursday at ten. " +
                "The quarterly budget review moved to next week."
        } else {
            "Earlier brief for $day: two invoices arrived and the garden service sent its schedule."
        }

    val today = DailyBriefItemsDto(
        day = "2026-10-14",
        messageId = "mb_2026-10-14",
        sentAt = "2026-10-14T06:05:00.000Z",
        items = listOf(
            DailyBriefItemDto(
                rank = 1,
                observationId = "obs_deposit",
                summary = "The venue deposit is due on Friday.",
                sources = listOf(DailyBriefSourceDto("doc_quote", "Venue quote and booking terms", "mail")),
                tasks = listOf(DailyBriefTaskDto("task_deposit", "Pay the venue deposit", "open")),
            ),
            DailyBriefItemDto(
                rank = 2,
                observationId = "obs_tuner",
                summary = "The tuner confirmed Thursday at ten.",
                sources = listOf(DailyBriefSourceDto("doc_reply", "Re: tuning appointment", "mail")),
                tasks = listOf(DailyBriefTaskDto("task_tuner", "Book the piano tuner", "done")),
                reaction = DailyBriefReactionDto(kind = "up", at = "2026-10-14T07:10:00.000Z"),
            ),
            DailyBriefItemDto(
                rank = 3,
                observationId = "obs_review",
                summary = "The quarterly budget review moved to next week.",
                sources = listOf(DailyBriefSourceDto("doc_invite", null, "calendar")),
                reaction = DailyBriefReactionDto(kind = "not_interested", note = "Finance handles this.", at = "2026-10-14T07:11:00.000Z"),
            ),
        ),
    )

    /** [today] with every reaction given: the first item disputed with a correction. */
    val todayReacted = today.copy(
        items = today.items.map { item ->
            if (item.observationId == "obs_deposit") {
                item.copy(
                    reaction = DailyBriefReactionDto(
                        kind = "factual_error",
                        note = "The deposit was paid on Monday.",
                        at = "2026-10-14T07:12:00.000Z",
                    ),
                )
            } else {
                item
            }
        },
    )

    fun earlier(day: String, count: Int) = DailyBriefItemsDto(
        day = day,
        messageId = "mb_$day",
        items = (1..count).map { DailyBriefItemDto(rank = it, observationId = "obs_${day}_$it", summary = "Invented item $it for $day.") },
    )

    val pages = listOf(today, earlier("2026-10-13", 1), earlier("2026-10-12", 2))

    /** Serves [pages] by day, 404s a day with none, and fails the first read of each day in [failingOnce]. */
    class Loader(pages: List<DailyBriefItemsDto>, failingOnce: Set<String> = emptySet()) : DailyBriefItemsLoader {
        private val byDay = pages.associateBy { it.day }
        private val failing = failingOnce.toMutableSet()
        val reads = mutableListOf<String>()

        override suspend fun items(conversationId: String, day: String): DailyBriefItemsDto {
            reads += day
            if (failing.remove(day)) throw GatewayException.ServerError(503, "Briefs are unavailable")
            return byDay[day] ?: throw GatewayException.NotFound("no brief on $day")
        }
    }

    /** One reaction as the fake gateway received it. */
    data class Reaction(val observationId: String, val reaction: DailyBriefReactionKind?, val note: String?)

    /**
     * Takes reactions, answering each with a receipt stamped at [at], and refuses every reaction
     * on an item in [failing]. A reaction on a [held] item waits until [release] is called.
     */
    class Sender(private val failing: Set<String> = emptySet(), private val held: Set<String> = emptySet()) : DailyBriefReactionSender {
        val sent = mutableListOf<Reaction>()
        private val gates = mutableMapOf<String, CompletableDeferred<Unit>>()
        var at: String = "2026-10-14T09:00:00.000Z"

        fun release(observationId: String) {
            gates.getOrPut(observationId) { CompletableDeferred() }.complete(Unit)
        }

        override suspend fun react(
            conversationId: String,
            day: String,
            observationId: String,
            reaction: DailyBriefReactionKind?,
            note: String?,
        ): DailyBriefReactionReceiptDto {
            sent += Reaction(observationId, reaction, note)
            if (observationId in held) gates.getOrPut(observationId) { CompletableDeferred() }.await()
            if (observationId in failing) throw GatewayException.ServerError(503, "Reactions are unavailable")
            return DailyBriefReactionReceiptDto(
                observationId = observationId,
                reaction = reaction?.wire,
                note = note?.trim()?.takeIf(String::isNotEmpty),
                at = at,
            )
        }
    }
}
