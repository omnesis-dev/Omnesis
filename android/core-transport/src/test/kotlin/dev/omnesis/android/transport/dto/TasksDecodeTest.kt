// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Tasks journal on the wire, as `packages/gateway/src/brain/tasks/http.ts` writes it. */
class TasksDecodeTest {
    @Test
    fun note_processing_status_distinguishes_unknown_off_and_unavailable() {
        assertNull(OmnesisJson.decodeFromString<StatusSnapshot>("{}").noteAgent)
        assertTrue(OmnesisJson.decodeFromString<StatusSnapshot>(
            """{"noteAgent":{"enabled":false,"modelAssigned":true,"active":false}}""",
        ).noteAgent!!.notice!!.contains("Note processing is off"))
        assertTrue(OmnesisJson.decodeFromString<StatusSnapshot>(
            """{"noteAgent":{"enabled":true,"modelAssigned":false,"active":false}}""",
        ).noteAgent!!.notice!!.contains("Agent model is missing or unavailable"))
        assertNull(NoteAgentStatusDto(enabled = true, modelAssigned = true, active = true).notice)
    }


    @Test
    fun a_today_view_decodes_with_counts_proposals_and_people() {
        val view = OmnesisJson.decodeFromString<TaskViewDto>(
            """{"view":"today","day":"2026-10-12",
               "counts":{"today":2,"month":4,"future":1,"anytime":3,"waiting":1,"suggested":3,"proposals":1,"carried":1},
               "tasks":[
                 {"id":"loop_a","title":"Send the venue deposit","description":"",
                  "state":"open","origin":"note","accepted":true,"scheduledFor":"2026-10-09",
                  "deadline":{"type":"by","date":"2026-10-14","note":"before the hold lapses"},
                  "dueDay":"2026-10-14","carried":true,"completionNote":null,
                  "proposedChange":{"kind":"complete","fields":null,"reason":"Riverside Estate confirmed receipt.",
                                    "evidence":["doc_1"],"proposedAt":"2026-10-12T07:00:00.000Z"},
                  "actors":[{"id":"p_self","name":"Jamie Lopez","isSelf":true},{"id":"p_2","name":null,"isSelf":false}],
                  "blockedBy":[],"documents":[{"id":"doc_1","title":"Deposit receipt","sourceId":"mail:inbox"}],
                  "createdAt":"2026-10-08T09:00:00.000Z","lastUpdate":"2026-10-12T07:00:00.000Z","resolvedAt":null},
                 {"id":"loop_b","title":"Book the piano tuner","state":"done","origin":"user","accepted":true,
                  "scheduledFor":"2026-10-12","deadline":"2026-10-20","dueDay":"2026-10-20","carried":false,
                  "completionNote":"Thursday at 10","resolvedAt":"2026-10-12T08:30:00.000Z","futureField":42}
               ]}""",
        )
        assertEquals("2026-10-12", view.day)
        assertEquals(
            TaskCountsDto(
                today = 2, month = 4, future = 1, anytime = 3, waiting = 1,
                suggested = 3, proposals = 1, carried = 1,
            ),
            view.counts,
        )

        val carried = view.tasks[0]
        assertTrue(carried.carried)
        assertFalse(carried.isResolved)
        assertEquals("2026-10-14", carried.dueDay)
        assertEquals("before the hold lapses", carried.deadlineNote)
        assertEquals("complete", carried.proposedChange?.kind)
        assertEquals("Riverside Estate confirmed receipt.", carried.proposedChange?.reason)
        assertEquals(listOf(true, false), carried.actors.map { it.isSelf })
        assertNull(carried.actors[1].name)
        assertEquals(listOf(TaskDocumentDto("doc_1", "Deposit receipt", "mail:inbox")), carried.documents)

        val done = view.tasks[1]
        assertTrue(done.isDone)
        assertTrue(done.isResolved)
        assertEquals("Thursday at 10", done.completionNote)
        // A bare-string deadline is valid agent output; it only lacks a note.
        assertNull(done.deadlineNote)
    }

    @Test
    fun the_counts_route_decodes_and_an_older_gateway_reads_as_zero() {
        val counts = OmnesisJson.decodeFromString<TaskCountsResponseDto>(
            """{"day":"2026-10-12","counts":{"today":4,"month":10,"future":2,"anytime":5,"waiting":1,
               "suggested":3,"proposals":0,"carried":2,"laterField":7}}""",
        )
        assertEquals("2026-10-12", counts.day)
        assertEquals(4, counts.counts.today)
        assertEquals(10, counts.counts.month)
        assertEquals(5, counts.counts.anytime)
        assertEquals(2, counts.counts.carried)

        // A gateway that predates the per-view counts sends only the three it always had.
        val older = OmnesisJson.decodeFromString<TaskViewDto>(
            """{"view":"today","day":"2026-10-12","tasks":[],"counts":{"suggested":1,"proposals":0,"carried":0}}""",
        )
        assertEquals(TaskCountsDto(suggested = 1), older.counts)
    }

    @Test
    fun a_suggestion_and_a_struck_task_are_told_apart() {
        val tasks = OmnesisJson.decodeFromString<TaskViewDto>(
            """{"view":"suggested","day":"2026-10-12","tasks":[
                 {"id":"loop_s","title":"Renew the parking permit","origin":"brain","accepted":false,"state":"open"},
                 {"id":"loop_x","title":"Call Stellar Sound","origin":"user","accepted":true,"state":"dismissed"}]}""",
        ).tasks
        assertTrue(tasks[0].isSuggestion)
        assertFalse(tasks[1].isSuggestion)
        assertTrue(tasks[1].isStruck)
        assertFalse(tasks[1].isDone)
    }

    /** An ignored suggestion is out of Tasks; a gateway that predates `ignored` reads as not ignored. */
    @Test
    fun an_ignored_suggestion_is_not_a_suggestion() {
        val tasks = OmnesisJson.decodeFromString<TaskViewDto>(
            """{"view":"suggested","day":"2026-10-12","tasks":[
                 {"id":"loop_i","title":"Renew the parking permit","origin":"brain","accepted":false,"ignored":true,"state":"open"},
                 {"id":"loop_s","title":"Book the piano tuner","origin":"brain","accepted":false,"state":"open"}]}""",
        ).tasks
        assertTrue(tasks[0].ignored)
        assertFalse(tasks[0].isSuggestion)
        assertFalse(tasks[1].ignored)
        assertTrue(tasks[1].isSuggestion)
    }

    @Test
    fun task_detail_carries_history_newest_first_and_its_undo_point() {
        val detail = OmnesisJson.decodeFromString<TaskDetailDto>(
            """{"task":{"id":"loop_a","title":"Send the venue deposit"},
               "history":[
                 {"seq":12,"at":"2026-10-12T07:01:00.000Z","note":"Moved to tomorrow","kind":"migrated",
                  "surface":"tasks","conversationId":null,"from":"2026-10-12","to":"2026-10-13"},
                 {"seq":9,"at":"2026-10-08T09:00:00.000Z","note":"Created","kind":"created","surface":"note",
                  "conversationId":null,"from":null,"to":null}],
               "undoSeq":12}""",
        )
        assertEquals(listOf(12L, 9L), detail.history.map { it.seq })
        assertEquals("2026-10-13", detail.history[0].to)
        assertEquals("note", detail.history[1].surface)
        assertEquals(12L, detail.undoSeq)
        // An older gateway sends no change or evidence.
        assertNull(detail.history[0].change)
        assertEquals(emptyList<String>(), detail.history[0].evidence)
    }

    @Test
    fun a_change_omnesis_applied_on_its_own_decodes_with_its_evidence() {
        val detail = OmnesisJson.decodeFromString<TaskDetailDto>(
            """{"task":{"id":"loop_a","title":"Pay the window cleaner"},
               "history":[
                 {"seq":20,"at":"2026-10-14T07:10:00.000Z","note":"The receipt says it was paid in full.",
                  "kind":"auto_applied","surface":"brain","conversationId":null,"from":null,"to":null,
                  "change":"complete","evidence":["doc_receipt_1"]}],
               "undoSeq":20}""",
        )
        assertEquals("auto_applied", detail.history[0].kind)
        assertEquals("complete", detail.history[0].change)
        assertEquals(listOf("doc_receipt_1"), detail.history[0].evidence)
    }

    @Test
    fun a_mutation_receipt_decodes_with_and_without_the_task() {
        val moved = OmnesisJson.decodeFromString<TaskMutationDto>(
            """{"task":{"id":"loop_a","title":"Send the venue deposit","scheduledFor":"2026-10-13"},
               "receipt":{"text":"Moved to tomorrow: Send the venue deposit","undoSeq":12}}""",
        )
        assertEquals("2026-10-13", moved.task?.scheduledFor)
        assertEquals(12L, moved.receipt.undoSeq)

        val deleted = OmnesisJson.decodeFromString<TaskMutationDto>(
            """{"task":null,"receipt":{"text":"Deleted","undoSeq":null}}""",
        )
        assertNull(deleted.task)
        assertNull(deleted.receipt.undoSeq)
    }

    @Test
    fun status_reports_tasks_and_an_older_gateway_reads_as_unavailable() {
        val current = OmnesisJson.decodeFromString<StatusSnapshot>(
            """{"tasks":{"available":true,"noteAgent":true},"brain":{"enabled":false},"briefs":{"enabled":false}}""",
        )
        assertEquals(TasksStatusDto(available = true, noteAgent = true), current.tasks)

        val older = OmnesisJson.decodeFromString<StatusSnapshot>("""{"experimental":true}""")
        assertNull(older.tasks)
    }
}
