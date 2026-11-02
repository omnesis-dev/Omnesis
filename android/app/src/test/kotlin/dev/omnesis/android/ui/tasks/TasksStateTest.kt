// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.tasks

import dev.omnesis.android.transport.client.FieldChange
import dev.omnesis.android.transport.client.TaskDeadlineInput
import dev.omnesis.android.transport.dto.TaskActorDto
import dev.omnesis.android.transport.dto.TaskCountsDto
import dev.omnesis.android.transport.dto.TaskDetailDto
import dev.omnesis.android.transport.dto.TaskDocumentDto
import dev.omnesis.android.transport.dto.TaskDto
import dev.omnesis.android.transport.dto.TaskEventDto
import dev.omnesis.android.transport.dto.TaskMutationDto
import dev.omnesis.android.transport.dto.TaskReceiptDto
import dev.omnesis.android.transport.dto.TaskRefDto
import dev.omnesis.android.transport.dto.TaskViewDto
import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Tasks screen's pure rules. All fixture data is invented. */
class TasksStateTest {

    private val monday = LocalDate.of(2026, 10, 12)

    private fun task(id: String, state: String = "open", carried: Boolean = false) =
        TaskDto(id = id, title = "Task $id", state = state, carried = carried, scheduledFor = "2026-10-12")

    private fun mutation(task: TaskDto?, text: String = "Done", undo: Long? = 7) =
        TaskMutationDto(task = task, receipt = TaskReceiptDto(text, undo))

    // --- Dates ---------------------------------------------------------------------------

    @Test
    fun one_tap_targets_come_from_the_device_day() {
        assertEquals("2026-10-13", TaskDates.tomorrow(monday))
        assertEquals("2026-11", TaskDates.nextMonth(monday))
        assertEquals("2027-01", TaskDates.nextMonth(LocalDate.of(2026, 12, 31)))
    }

    /** Weekends are not special: next week is the next Monday, whatever today is. */
    @Test
    fun next_week_is_always_the_following_monday() {
        assertEquals("2026-10-19", TaskDates.nextWeek(monday))
        assertEquals("2026-10-19", TaskDates.nextWeek(LocalDate.of(2026, 10, 17)))
        assertEquals("2026-10-19", TaskDates.nextWeek(LocalDate.of(2026, 10, 18)))
    }

    @Test
    fun schedules_read_relative_to_today() {
        assertEquals("Today", TaskDates.describe("2026-10-12", monday))
        assertEquals("Tomorrow", TaskDates.describe("2026-10-13", monday))
        assertEquals("Yesterday", TaskDates.describe("2026-10-11", monday))
        assertEquals("Fri 16 Oct", TaskDates.describe("2026-10-16", monday))
        assertEquals("This month", TaskDates.describe("2026-10", monday))
        assertEquals("November 2026", TaskDates.describe("2026-11", monday))
        assertEquals("Someday", TaskDates.describe("someday", monday))
        assertNull(TaskDates.describe(null, monday))
        assertNull(TaskDates.describe("2026-13-40", monday))
    }

    @Test
    fun row_meta_says_when_and_who_without_repeating_today() {
        val carried = task("c", carried = true).copy(scheduledFor = "2026-10-09", dueDay = "2026-10-13")
        val carriedMeta = taskMeta(carried, TaskSegment.TODAY, monday)
        assertEquals(listOf("Planned Fri 9 Oct", "Due tomorrow"), carriedMeta.map { it.text })
        // The planned day wears the calendar and the deadline the flag, as on iOS.
        assertEquals(listOf(TaskMetaIcon.PLANNED, TaskMetaIcon.DUE), carriedMeta.map { it.icon })
        assertFalse(carriedMeta[1].overdue)

        val planned = task("p")
        assertEquals(emptyList<TaskMetaItem>(), taskMeta(planned, TaskSegment.TODAY, monday))
        assertEquals(listOf("Today"), taskMeta(planned, TaskSegment.WAITING, monday).map { it.text })

        val waiting = TaskDto(
            id = "w",
            title = "Contract back from the landlord",
            actors = listOf(TaskActorDto("p1", "Maya Reeves", isSelf = false)),
            blockedBy = listOf(TaskRefDto("t2", "Send the signed form")),
        )
        val waitingMeta = taskMeta(waiting, TaskSegment.WAITING, monday)
        assertEquals(listOf("Waiting on Maya Reeves", "After “Send the signed form”"), waitingMeta.map { it.text })
        assertEquals(listOf(TaskMetaIcon.PEOPLE, TaskMetaIcon.BLOCKED), waitingMeta.map { it.icon })
    }

    @Test
    fun a_passed_deadline_is_overdue_and_a_resolved_task_drops_its_deadline() {
        val late = task("l").copy(dueDay = "2026-10-09")
        val due = taskMeta(late, TaskSegment.TODAY, monday).single()
        assertEquals("Due Fri 9 Oct", due.text)
        assertTrue(due.overdue)

        val done = late.copy(state = TaskDto.STATE_DONE)
        assertTrue(taskMeta(done, TaskSegment.TODAY, monday).isEmpty())
    }

    // --- Today's sections --------------------------------------------------------------

    @Test
    fun today_does_not_regroup_carried_rows_in_the_gateway_order() {
        val tasks = listOf(task("new-carried", carried = true), task("current"), task("old-carried", carried = true))
        assertEquals(tasks.map { "task:${it.id}" },
            TasksReducer.entries(TaskSegment.TODAY, tasks).map { it.key })
    }

    @Test
    fun today_preserves_gateway_open_order_then_resolved_under_counted_headings() {
        val entries = TasksReducer.entries(
            TaskSegment.TODAY,
            listOf(
                task("done", state = TaskDto.STATE_DONE),
                task("carried", carried = true),
                task("planned"),
                task("struck", state = TaskDto.STATE_DISMISSED),
            ),
        )
        assertEquals(
            listOf(
                "heading:today", "task:carried", "task:planned",
                "heading:resolved", "task:done", "task:struck",
            ),
            entries.map { it.key },
        )
        assertEquals(TaskJournalEntry.Heading("resolved", "Done today", 2), entries[3])
    }

    /** Today's own rows need no heading when nothing else shares the page. */
    @Test
    fun a_page_of_only_planned_tasks_has_no_headings() {
        val entries = TasksReducer.entries(TaskSegment.TODAY, listOf(task("a"), task("b")))
        assertEquals(listOf("task:a", "task:b"), entries.map { it.key })
        assertEquals(listOf("task:x"), TasksReducer.entries(TaskSegment.MONTH, listOf(task("x"))).map { it.key })
    }

    /**
     * A row that changes section keeps its key: completing a planned task moves the same line
     * into "Done today", so the list redraws that line as done rather than keeping a stale one.
     */
    @Test
    fun a_task_that_changes_section_keeps_its_key() {
        val before = TasksReducer.entries(TaskSegment.TODAY, listOf(task("a"), task("b")))
        val after = TasksReducer.entries(TaskSegment.TODAY, listOf(task("a", state = TaskDto.STATE_DONE), task("b")))
        val keyBefore = before.single { it is TaskJournalEntry.Task && it.task.id == "a" }.key
        val moved = after.single { it is TaskJournalEntry.Task && it.task.id == "a" } as TaskJournalEntry.Task
        assertEquals(keyBefore, moved.key)
        assertTrue(moved.task.isDone)
        assertTrue(after.indexOf(moved) > after.indexOfFirst { it.key == "task:b" })
    }

    @Test
    fun the_fan_opens_only_on_the_user_s_own_open_tasks() {
        assertTrue(hasActionFan(task("a")))
        assertFalse(hasActionFan(task("a", state = TaskDto.STATE_DONE)))
        assertFalse(hasActionFan(task("a", state = TaskDto.STATE_DISMISSED)))
        // A suggestion has its own fan; a resolved one has none.
        assertTrue(hasActionFan(TaskDto(id = "s", origin = "brain", accepted = false)))
        assertFalse(hasActionFan(TaskDto(id = "s", origin = "brain", accepted = false, state = TaskDto.STATE_DONE)))
        assertTrue(hasActionFan(TaskDto(id = "s", origin = "brain", accepted = true)))
    }

    @Test
    fun the_page_is_headed_by_its_day_or_month() {
        val today = TaskPageHeading.of(
            TaskSegment.TODAY,
            monday,
            listOf(task("a"), task("b", state = TaskDto.STATE_DONE), task("c", state = TaskDto.STATE_DISMISSED)),
        )
        assertEquals(TaskPageHeading("Monday 12 October", "1 to do · 1 done"), today)
        assertEquals(TaskPageHeading("October 2026", null), TaskPageHeading.of(TaskSegment.MONTH, monday, emptyList()))
        assertNull(TaskPageHeading.of(TaskSegment.DONE, monday, emptyList()))
    }

    // --- Segments ------------------------------------------------------------------------

    @Test
    fun suggested_is_offered_only_in_experimental_mode() {
        assertEquals(
            listOf(
                TaskSegment.TODAY, TaskSegment.MONTH, TaskSegment.FUTURE,
                TaskSegment.ANYTIME, TaskSegment.WAITING, TaskSegment.DONE,
            ),
            TaskSegment.visible(experimental = false),
        )
        assertEquals(TaskSegment.entries.toList(), TaskSegment.visible(experimental = true))
    }

    @Test
    fun tabs_name_their_open_counts_only_when_there_are_some() {
        val counts = TaskCountsDto(today = 4, month = 10, future = 0, anytime = 2, waiting = 1, suggested = 3)
        assertEquals(
            listOf("Today (4)", "Month (10)", "Future", "Anytime (2)", "Waiting (1)", "Suggested", "Done"),
            TaskSegment.entries.map { it.tabLabel(counts) },
        )
        // Suggested keeps its count on the badge; Done counts nothing.
        assertEquals(0, TaskSegment.SUGGESTED.count(counts))
        assertEquals(0, TaskSegment.DONE.count(counts))
        // TalkBack hears the counts as words, not brackets.
        assertEquals("Today, 4 open", TaskSegment.TODAY.spokenLabel(counts))
        assertEquals("Future", TaskSegment.FUTURE.spokenLabel(counts))
        assertEquals("Suggested, 3 waiting", TaskSegment.SUGGESTED.spokenLabel(counts))
    }

    @Test
    fun the_menu_names_today_s_open_tasks() {
        assertEquals("Tasks (4)", tasksMenuLabel(4))
        assertEquals("Tasks", tasksMenuLabel(0))
    }

    @Test
    fun the_suggestions_banner_needs_experimental_mode_and_a_suggestion() {
        assertEquals("Omnesis has created 1 task for your review", suggestionsBannerText(1, experimental = true))
        assertEquals("Omnesis has created 3 tasks for your review", suggestionsBannerText(3, experimental = true))
        assertNull(suggestionsBannerText(0, experimental = true))
        assertNull(suggestionsBannerText(3, experimental = false))
    }

    @Test
    fun the_store_publishes_and_clears_counts() {
        val store = TaskCountsStore()
        store.publish(TaskCountsDto(today = 2))
        assertEquals(2, store.counts.value.today)
        store.clear()
        assertEquals(TaskCountsDto(), store.counts.value)
    }

    // --- Loading -------------------------------------------------------------------------

    @Test
    fun a_reply_for_a_segment_the_screen_has_left_is_ignored() {
        val onMonth = TasksReducer.selectSegment(TasksUiState(day = "2026-10-12"), TaskSegment.MONTH)
        val stale = TaskViewDto(view = "today", day = "2026-10-12", tasks = listOf(task("a")))

        assertSame(onMonth, TasksReducer.viewLoaded(onMonth, TaskSegment.TODAY, stale))

        val loaded = TasksReducer.viewLoaded(
            onMonth,
            TaskSegment.MONTH,
            stale.copy(view = "month", counts = TaskCountsDto(suggested = 2)),
        )
        assertFalse(loaded.loading)
        assertEquals(listOf("a"), loaded.tasks.map { it.id })
        assertEquals(2, loaded.counts.suggested)
    }

    @Test
    fun a_reply_for_another_day_is_ignored() {
        val state = TasksUiState(day = "2026-10-13")
        val yesterdays = TaskViewDto(view = "today", day = "2026-10-12", tasks = listOf(task("a")))
        assertSame(state, TasksReducer.viewLoaded(state, TaskSegment.TODAY, yesterdays))
    }

    @Test
    fun switching_segment_clears_the_list() {
        val state = TasksUiState(tasks = listOf(task("a")), loading = false)
        val next = TasksReducer.selectSegment(state, TaskSegment.DONE)
        assertTrue(next.loading)
        assertTrue(next.tasks.isEmpty())
        assertSame(next, TasksReducer.selectSegment(next, TaskSegment.DONE))
    }

    // --- Mutations -----------------------------------------------------------------------

    @Test
    fun completing_from_the_circle_shows_done_at_once_and_a_refusal_restores_it() {
        val original = task("a")
        val state = TasksUiState(tasks = listOf(original))

        val optimistic = TasksReducer.toggleOptimistically(state, "a")
        assertTrue(optimistic.tasks.single().isDone)
        assertTrue("a" in optimistic.pending)

        val refused = TasksReducer.failed(optimistic, "a", restore = original, message = "Gateway unreachable")
        assertEquals(original, refused.tasks.single())
        assertFalse("a" in refused.pending)
        assertEquals("Gateway unreachable", refused.actionError)
    }

    @Test
    fun reopening_from_the_circle_shows_open_at_once_and_drops_the_note() {
        val done = task("a", state = TaskDto.STATE_DONE).copy(completionNote = "Paid by card")
        val optimistic = TasksReducer.toggleOptimistically(TasksUiState(tasks = listOf(done)), "a")
        val reopened = optimistic.tasks.single()
        assertFalse(reopened.isResolved)
        assertNull(reopened.completionNote)
    }

    @Test
    fun a_mutation_replaces_the_row_and_raises_its_receipt() {
        val state = TasksReducer.begin(TasksUiState(tasks = listOf(task("a"), task("b"))), "a")
        val moved = task("a").copy(scheduledFor = "2026-10-13")

        val next = TasksReducer.mutated(state, "a", mutation(moved, "Moved to tomorrow"), receiptId = 3)

        assertEquals(moved, next.tasks.first())
        assertTrue(next.pending.isEmpty())
        assertEquals(TaskReceipt(id = 3, text = "Moved to tomorrow", undoSeq = 7), next.receipt)
    }

    /** The returned task, not the one sent, is what the row shows: an accepted suggestion loses Accept. */
    @Test
    fun an_accepted_suggestion_shows_as_the_gateway_returned_it_outside_suggested() {
        val suggestion = TaskDto(id = "s", title = "Renew the parking permit", origin = "brain", accepted = false)
        val state = TasksUiState(segment = TaskSegment.TODAY, tasks = listOf(suggestion))
        val next = TasksReducer.mutated(state, "s", mutation(suggestion.copy(accepted = true), "Added"), 1)
        assertFalse(next.tasks.single().isSuggestion)
    }

    @Test
    fun an_undo_says_so_with_nothing_further_to_undo() {
        val next = TasksReducer.undone(TasksUiState(), mutation(task("a"), "Undone: Task a", undo = 12), receiptId = 5)
        assertEquals(TaskReceipt(id = 5, text = "Undone: Task a", undoSeq = null), next.receipt)
    }

    @Test
    fun a_deleted_task_leaves_the_list() {
        val state = TasksUiState(tasks = listOf(task("a"), task("b")))
        val next = TasksReducer.mutated(state, "a", mutation(null, "Deleted"), receiptId = 1)
        assertEquals(listOf("b"), next.tasks.map { it.id })
    }

    /** Suggestions live only under Suggested, so an accepted, done or ignored one leaves it at once. */
    @Test
    fun a_handled_suggestion_leaves_the_suggested_list() {
        val suggestion = TaskDto(id = "s", title = "Renew the parking permit", origin = "brain", accepted = false)
        val state = TasksUiState(segment = TaskSegment.SUGGESTED, tasks = listOf(suggestion))

        val accepted = TasksReducer.mutated(state, "s", mutation(suggestion.copy(accepted = true), "Accepted"), 1)
        assertTrue(accepted.tasks.isEmpty())

        val done = TasksReducer.mutated(state, "s", mutation(suggestion.copy(state = "done", accepted = true), "Done"), 2)
        assertTrue(done.tasks.isEmpty())

        val ignored = TasksReducer.mutated(state, "s", mutation(suggestion.copy(ignored = true), "Ignored"), 3)
        assertTrue(ignored.tasks.isEmpty())
        assertEquals("Ignored", ignored.receipt?.text)
    }

    @Test
    fun an_ignored_suggestion_is_no_longer_a_suggestion() {
        val suggestion = TaskDto(id = "s", title = "Renew the parking permit", origin = "brain", accepted = false)
        assertTrue(suggestion.isSuggestion)
        assertFalse(suggestion.copy(ignored = true).isSuggestion)
    }

    @Test
    fun a_blank_receipt_raises_no_toast() {
        val next = TasksReducer.mutated(TasksUiState(tasks = listOf(task("a"))), "a", mutation(task("a"), " "), 1)
        assertNull(next.receipt)
    }

    // --- Editor --------------------------------------------------------------------------

    @Test
    fun an_untouched_editor_saves_nothing() {
        val original = task("a").copy(description = "Bring the folder", dueDay = "2026-10-20")
        assertNull(TaskEditorDraft.from(original, monday).toEdit(original))
    }

    @Test
    fun the_editor_sends_only_what_changed() {
        val original = task("a").copy(dueDay = "2026-10-20")
        val draft = TaskEditorDraft.from(original, monday).copy(
            title = "  Task a, renamed ",
            plan = TaskPlan.MONTH,
            month = "2026-11",
            deadline = null,
        )

        val edit = draft.toEdit(original)!!

        assertEquals("Task a, renamed", edit.title)
        assertNull(edit.description)
        assertEquals(FieldChange.Set("2026-11"), edit.scheduledFor)
        assertEquals(FieldChange.Clear, edit.deadline)
    }

    @Test
    fun unplanning_clears_the_schedule_and_a_new_deadline_is_a_by_date() {
        val original = task("a")
        val edit = TaskEditorDraft.from(original, monday)
            .copy(plan = TaskPlan.NONE, deadline = "2026-10-30")
            .toEdit(original)!!
        assertEquals(FieldChange.Clear, edit.scheduledFor)
        assertEquals(FieldChange.Set(TaskDeadlineInput.by("2026-10-30")), edit.deadline)
    }

    @Test
    fun the_editor_opens_on_the_task_plan_with_sensible_defaults() {
        val someday = TaskEditorDraft.from(task("a").copy(scheduledFor = "someday"), monday)
        assertEquals(TaskPlan.SOMEDAY, someday.plan)
        assertEquals("someday", someday.schedule)

        val unplanned = TaskEditorDraft.from(task("a").copy(scheduledFor = null), monday)
        assertEquals(TaskPlan.NONE, unplanned.plan)
        assertEquals("2026-10-12", unplanned.day)
        assertEquals("2026-10", unplanned.month)

        assertFalse(unplanned.copy(title = "  ").canSave)
    }

    // --- History -------------------------------------------------------------------------

    @Test
    fun history_lines_prefer_the_gateway_note_and_name_the_surface() {
        assertEquals("Moved to tomorrow", taskEventTitle(TaskEventDto(kind = "migrated", note = "Moved to tomorrow")))
        assertEquals("Ignored", taskEventTitle(TaskEventDto(kind = "ignored", note = null)))
        // Older gateways dismissed a refused suggestion.
        assertEquals("Dismissed", taskEventTitle(TaskEventDto(kind = "refused", note = null)))
        assertEquals("Already done", taskEventTitle(TaskEventDto(kind = "completed", note = "Already done")))
        assertEquals("Updated", taskEventTitle(TaskEventDto(kind = "something_later")))
        assertEquals("by Omnesis", taskEventSurface("brain"))
        assertNull(taskEventSurface("somewhere_new"))
    }

    @Test
    fun a_row_lists_a_few_documents_then_the_rest_on_request() {
        val documents = (0 until 6).map { TaskDocumentDto("doc_$it", "Document $it", "mail:inbox") }
        assertEquals(TaskDocumentsShown(documents.take(4), 0), taskDocumentsShown(documents.take(4), showAll = false))
        assertEquals(TaskDocumentsShown(documents.take(3), 3), taskDocumentsShown(documents, showAll = false))
        assertEquals(TaskDocumentsShown(documents, 0), taskDocumentsShown(documents, showAll = true))
        assertEquals(TaskDocumentsShown(emptyList(), 0), taskDocumentsShown(emptyList(), showAll = false))
    }

    // --- Changes Omnesis applied on its own --------------------------------------------

    @Test
    fun a_change_omnesis_applied_leads_with_who_made_it_and_names_no_surface() {
        val done = TaskEventDto(seq = 20, kind = "auto_applied", surface = "brain", change = "complete", note = "The receipt says it was paid.")
        assertEquals("Marked done by Omnesis — The receipt says it was paid.", taskEventTitle(done))
        assertEquals("Updated by Omnesis", taskEventTitle(done.copy(change = "edit", note = " ")))
        assertNull(taskEventAttribution(done))
        assertEquals("by Omnesis", taskEventAttribution(TaskEventDto(kind = "struck", surface = "brain")))
    }

    @Test
    fun a_task_omnesis_added_or_withheld_leads_with_who_did_it_and_names_no_surface() {
        val added = TaskEventDto(seq = 30, kind = "auto_accepted", surface = "brain", note = "The lease says the deposit is due Friday.")
        assertEquals("Added by Omnesis — The lease says the deposit is due Friday.", taskEventTitle(added))
        assertEquals("Added by Omnesis", taskEventTitle(added.copy(note = null)))
        assertNull(taskEventAttribution(added))
        val withheld = TaskEventDto(seq = 31, kind = "withheld", surface = "brain", note = "Nothing to do yet.")
        assertEquals("Withheld by Omnesis — Nothing to do yet.", taskEventTitle(withheld))
        assertEquals("Withheld by Omnesis", taskEventTitle(withheld.copy(note = " ")))
        assertNull(taskEventAttribution(withheld))
    }

    @Test
    fun only_the_newest_change_omnesis_applied_offers_undo_while_it_is_undoable() {
        val applied = TaskEventDto(seq = 20, kind = "auto_applied", surface = "brain", change = "complete")
        fun history(events: List<TaskEventDto>, undoSeq: Long?) =
            TaskHistoryState(task("t"), TaskDetailDto(task = task("t"), history = events, undoSeq = undoSeq), loading = false)
        assertEquals(20L, history(listOf(applied), 20L).autoAppliedUndoSeq)
        assertNull(history(listOf(applied), null).autoAppliedUndoSeq)
        assertNull(history(listOf(TaskEventDto(seq = 21, kind = "undone"), applied), null).autoAppliedUndoSeq)
        assertNull(history(listOf(TaskEventDto(seq = 20, kind = "completed")), 20L).autoAppliedUndoSeq)
        assertNull(TaskHistoryState(task("t")).autoAppliedUndoSeq)
        // A task Omnesis added or withheld on its own is offered the same way.
        val added = TaskEventDto(seq = 30, kind = "auto_accepted", surface = "brain")
        assertEquals(30L, history(listOf(added), 30L).autoAppliedUndoSeq)
        assertNull(history(listOf(added), 29L).autoAppliedUndoSeq)
        val withheld = TaskEventDto(seq = 31, kind = "withheld", surface = "brain")
        assertEquals(31L, history(listOf(withheld, added), 31L).autoAppliedUndoSeq)
        assertNull(history(listOf(TaskEventDto(seq = 32, kind = "undone"), withheld), null).autoAppliedUndoSeq)
    }
}
