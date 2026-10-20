// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.TaskActorDto
import dev.omnesis.android.transport.dto.TaskCountsDto
import dev.omnesis.android.transport.dto.TaskDetailDto
import dev.omnesis.android.transport.dto.TaskDocumentDto
import dev.omnesis.android.transport.dto.TaskDto
import dev.omnesis.android.transport.dto.TaskEventDto
import dev.omnesis.android.transport.dto.TaskProposalDto
import dev.omnesis.android.transport.dto.TaskRefDto
import dev.omnesis.android.ui.tasks.TaskEditorContent
import dev.omnesis.android.ui.tasks.TaskFanAction
import dev.omnesis.android.ui.tasks.TaskFanPreview
import dev.omnesis.android.ui.tasks.TaskFanSession
import dev.omnesis.android.ui.tasks.TaskEditorDraft
import dev.omnesis.android.ui.tasks.TaskHistoryContent
import dev.omnesis.android.ui.tasks.TaskHistoryState
import dev.omnesis.android.ui.tasks.TaskReceipt
import dev.omnesis.android.ui.tasks.TaskSegment
import dev.omnesis.android.ui.tasks.TasksContent
import dev.omnesis.android.ui.tasks.TasksFrame
import dev.omnesis.android.ui.tasks.TasksUiState
import java.time.LocalDate
import java.time.ZoneOffset
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Tasks journal: each segment's characteristic state, the action fan a long press
 * opens, the Brain's proposal line and suggestions, the receipt toast, the editor and a task's
 * history. All sample data is invented, never sourced from the corpus.
 *
 *   ./gradlew :app:recordRoborazziPlayDebug   ->   app/src/test/roborazzi/
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class TasksScreenshotTest {

    private fun capture(name: String, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { content() }
            }
        }
    }

    private val today = LocalDate.of(2026, 10, 12)

    private val carried = TaskDto(
        id = "t_carried",
        title = "Send the deposit to Riverside Estate",
        origin = "note",
        accepted = true,
        scheduledFor = "2026-10-09",
        dueDay = "2026-10-14",
        carried = true,
    )
    private val proposed = TaskDto(
        id = "t_proposed",
        title = "Return the borrowed tripod to David Lin",
        origin = "user",
        accepted = true,
        scheduledFor = "2026-10-12",
        proposedChange = TaskProposalDto(
            kind = "complete",
            reason = "David replied on Saturday that he has it back.",
        ),
    )
    private val planned = TaskDto(
        id = "t_planned",
        title = "Book the piano tuner",
        description = "Ask for a Thursday morning slot; the last tuning ran long, so book two hours " +
            "and mention the sticking middle C. Keep the quote for the household folder.",
        origin = "user",
        accepted = true,
        scheduledFor = "2026-10-12",
        documents = listOf(
            TaskDocumentDto("d_quote", "Tuning quote — Harmony Keys", "mail:inbox"),
            TaskDocumentDto("d_reply", "Re: Availability next week", "mail:inbox"),
            TaskDocumentDto("d_note", "Piano service history", "notes:local"),
            TaskDocumentDto("d_invoice", "Last year's tuning invoice.pdf", "files:drive"),
            TaskDocumentDto("d_chat", "Jamie Lopez — 2026-10-10", "chat:phone"),
        ),
    )
    private val due = TaskDto(
        id = "t_due",
        title = "Submit the marathon entry form",
        origin = "note",
        accepted = true,
        dueDay = "2026-10-12",
        documents = listOf(
            TaskDocumentDto("d_form", "Marathon entry form.pdf", "files:drive"),
            TaskDocumentDto("d_rules", "Entry rules and medical note", "mail:inbox"),
        ),
    )
    private val done = TaskDto(
        id = "t_done",
        title = "Water the plants",
        state = TaskDto.STATE_DONE,
        accepted = true,
        scheduledFor = "2026-10-12",
        completionNote = "Gave the fern extra",
    )
    private val struck = TaskDto(
        id = "t_struck",
        title = "Call Stellar Sound about the speakers",
        state = TaskDto.STATE_DISMISSED,
        accepted = true,
        scheduledFor = "2026-10-12",
    )

    private val todayState = TasksUiState(
        day = "2026-10-12",
        loading = false,
        tasks = listOf(carried, proposed, planned, due, done, struck),
        counts = TaskCountsDto(
            today = 4, month = 10, future = 3, anytime = 2, waiting = 2,
            suggested = 2, proposals = 1, carried = 1,
        ),
    )

    @Composable
    private fun Screen(state: TasksUiState, experimental: Boolean = false) {
        TasksFrame(onOpenMenu = {}, onTellOmnesis = {}) {
            TasksContent(state = state, today = today, experimental = experimental)
        }
    }

    /**
     * A stable gateway: tabs with their open counts, no Suggested segment, no suggestions
     * banner, no proposal on a row, and the bar's Tell Omnesis button (a microphone with a
     * plus badge) at the top right as the way to add a task.
     */
    @Test
    fun tasks_today_dark() = capture("tasks_today_dark", dark = true) { Screen(todayState) }

    @Test
    fun tasks_today_light() = capture("tasks_today_light", dark = false) { Screen(todayState) }

    /**
     * An experimental gateway, where the Brain runs: the Suggested chip with its count, the
     * banner at the top of Today pointing to it — above a full day, so it is never scrolled out
     * of sight — and a proposed change answered with Confirm or Keep.
     */
    @Test
    fun tasks_today_experimental_dark() = capture("tasks_today_experimental_dark", dark = true) {
        Screen(todayState, experimental = true)
    }

    @Test
    fun tasks_today_experimental_light() = capture("tasks_today_experimental_light", dark = false) {
        Screen(
            todayState.copy(
                tasks = listOf(proposed, planned.copy(documents = emptyList()), done),
                counts = todayState.counts.copy(suggested = 1),
            ),
            experimental = true,
        )
    }

    @Composable
    private fun FanScreen(state: TasksUiState, fan: TaskFanPreview, experimental: Boolean = false) {
        TasksFrame(onOpenMenu = {}, onTellOmnesis = {}) {
            TasksContent(state = state, today = today, experimental = experimental, initialFan = fan)
        }
    }

    /**
     * A long press on a row: the list dims except the pressed row, the fan's column rises up
     * and to the left of the finger (Done nearest), and the finger has slid onto Tomorrow.
     */
    @Test
    fun tasks_fan_open_dark() = capture("tasks_fan_open_dark", dark = true) {
        FanScreen(todayState, TaskFanPreview(taskId = due.id, highlight = TaskFanAction.Tomorrow))
    }

    @Test
    fun tasks_fan_open_light() = capture("tasks_fan_open_light", dark = false) {
        FanScreen(todayState, TaskFanPreview(taskId = due.id, highlight = TaskFanAction.Tomorrow))
    }

    /** Near the top of the list the column hangs below the finger instead, in the same order. */
    @Test
    fun tasks_fan_near_top_dark() = capture("tasks_fan_near_top_dark", dark = true) {
        FanScreen(todayState, TaskFanPreview(taskId = carried.id))
    }

    /** Other month… opened the month fan in place: Back nearest, the months, then Later. */
    @Test
    fun tasks_month_fan_light() = capture("tasks_month_fan_light", dark = false) {
        FanScreen(
            todayState,
            TaskFanPreview(taskId = due.id, mode = TaskFanSession.Mode.Months(0), highlight = TaskFanAction.Month("2027-02")),
        )
    }

    /** Right after completing from the bullet: the row is struck and the toast offers Undo. */
    @Test
    fun tasks_today_receipt_dark() = capture("tasks_today_receipt_dark", dark = true) {
        Screen(
            todayState.copy(
                tasks = listOf(carried, proposed, due, planned.copy(state = TaskDto.STATE_DONE), done, struck),
                receipt = TaskReceipt(id = 1, text = "Done: Book the piano tuner", undoSeq = 41),
            ),
        )
    }

    @Test
    fun tasks_today_receipt_light() = capture("tasks_today_receipt_light", dark = false) {
        Screen(
            todayState.copy(
                tasks = listOf(carried, proposed, due, planned.copy(state = TaskDto.STATE_DONE), done, struck),
                receipt = TaskReceipt(id = 1, text = "Done: Book the piano tuner", undoSeq = 41),
            ),
        )
    }

    @Test
    fun tasks_today_empty_dark() = capture("tasks_today_empty_dark", dark = true) {
        Screen(TasksUiState(day = "2026-10-12", loading = false))
    }

    @Test
    fun tasks_loading_dark() = capture("tasks_loading_dark", dark = true) {
        Screen(TasksUiState(day = "2026-10-12", loading = true))
    }

    private val suggestedState = TasksUiState(
        segment = TaskSegment.SUGGESTED,
        day = "2026-10-12",
        loading = false,
        counts = TaskCountsDto(suggested = 2),
        tasks = listOf(
            TaskDto(
                id = "s_permit",
                title = "Renew the residents' parking permit",
                description = "The council's reminder says the current permit lapses at the end of the month.",
                origin = "brain",
                accepted = false,
                dueDay = "2026-10-31",
            ),
            TaskDto(
                id = "s_reply",
                title = "Reply to Maya Reeves about the studio handover",
                description = "She asked on Thursday which day suits you.",
                origin = "brain",
                accepted = false,
            ),
        ),
    )

    @Test
    fun tasks_suggested_dark() = capture("tasks_suggested_dark", dark = true) {
        Screen(suggestedState, experimental = true)
    }

    @Test
    fun tasks_suggested_light() = capture("tasks_suggested_light", dark = false) {
        Screen(suggestedState, experimental = true)
    }

    /**
     * A long press on a suggestion: its own fan — Accept nearest, then Accept with note,
     * Accept for…, Mark as done and Ignore — with the finger on Accept.
     */
    @Test
    fun tasks_suggestion_fan_dark() = capture("tasks_suggestion_fan_dark", dark = true) {
        FanScreen(suggestedState, TaskFanPreview(taskId = "s_reply", highlight = TaskFanAction.Accept), experimental = true)
    }

    @Test
    fun tasks_suggestion_fan_light() = capture("tasks_suggestion_fan_light", dark = false) {
        FanScreen(suggestedState, TaskFanPreview(taskId = "s_reply", highlight = TaskFanAction.Ignore), experimental = true)
    }

    /** Accept for… opened the "when" fan: Back nearest, then the times to plan the suggestion for. */
    @Test
    fun tasks_suggestion_when_fan_light() = capture("tasks_suggestion_when_fan_light", dark = false) {
        FanScreen(
            suggestedState,
            TaskFanPreview(taskId = "s_reply", mode = TaskFanSession.Mode.When, highlight = TaskFanAction.Tomorrow),
            experimental = true,
        )
    }

    @Test
    fun tasks_waiting_dark() = capture("tasks_waiting_dark", dark = true) {
        Screen(
            TasksUiState(
                segment = TaskSegment.WAITING,
                day = "2026-10-12",
                loading = false,
                tasks = listOf(
                    TaskDto(
                        id = "w_contract",
                        title = "Countersigned lease back from the landlord",
                        accepted = true,
                        dueDay = "2026-10-20",
                        actors = listOf(TaskActorDto("p_landlord", "Jamie Lopez", isSelf = false)),
                    ),
                    TaskDto(
                        id = "w_print",
                        title = "Frame the prints",
                        accepted = true,
                        scheduledFor = "2026-11",
                        blockedBy = listOf(TaskRefDto("t_order", "Collect the prints from Studio Northstar")),
                    ),
                ),
            ),
        )
    }

    @Test
    fun tasks_future_light() = capture("tasks_future_light", dark = false) {
        Screen(
            TasksUiState(
                segment = TaskSegment.FUTURE,
                day = "2026-10-12",
                loading = false,
                tasks = listOf(
                    TaskDto(id = "f_tax", title = "File the tax return", accepted = true, scheduledFor = "2026-12"),
                    TaskDto(id = "f_trip", title = "Plan the spring trip", accepted = true, scheduledFor = "2027-03"),
                    TaskDto(id = "f_piano", title = "Learn the second movement", accepted = true, scheduledFor = "someday"),
                ),
            ),
        )
    }

    @Test
    fun tasks_done_dark() = capture("tasks_done_dark", dark = true) {
        Screen(
            TasksUiState(
                segment = TaskSegment.DONE,
                day = "2026-10-12",
                loading = false,
                tasks = listOf(done, struck, done.copy(id = "t_done_2", title = "Q4 budget review", completionNote = null)),
            ),
        )
    }

    /** The sheets sit on the page background, as the screen presents them. */
    @Composable
    private fun Sheet(content: @Composable () -> Unit) {
        Box(Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary)) { content() }
    }

    private val editing = planned.copy(
        description = "Ask about the Thursday slot.",
        dueDay = "2026-10-16",
        documents = listOf(
            TaskDocumentDto("d_quote", "Stellar Sound — -12.99 GBP", "bank:current"),
            TaskDocumentDto("d_reply", "Re: Availability next week", "mail:inbox"),
            TaskDocumentDto("d_note", "Piano service history", "notes:local"),
        ),
    )

    @Test
    fun tasks_editor_dark() = capture("tasks_editor_dark", dark = true) {
        Sheet {
            TaskEditorContent(
                TaskEditorDraft.from(editing, today),
                onCancel = {},
                onSave = {},
                onHistory = {},
                documents = editing.documents,
            )
        }
    }

    @Test
    fun tasks_editor_light() = capture("tasks_editor_light", dark = false) {
        Sheet {
            TaskEditorContent(
                TaskEditorDraft.from(editing, today),
                onCancel = {},
                onSave = {},
                onHistory = {},
                documents = editing.documents,
            )
        }
    }

    @Test
    fun tasks_history_dark() = capture("tasks_history_dark", dark = true) {
        Sheet {
            TaskHistoryContent(
                TaskHistoryState(
                    task = carried,
                    loading = false,
                    detail = TaskDetailDto(
                        task = carried,
                        history = listOf(
                            TaskEventDto(seq = 14, at = "2026-10-12T07:02:00Z", note = "Kept as is", kind = "proposal_kept", surface = "tasks"),
                            TaskEventDto(seq = 12, at = "2026-10-10T18:40:00Z", note = "Moved to Fri 9 Oct", kind = "migrated", surface = "conversation"),
                            TaskEventDto(seq = 9, at = "2026-10-08T09:00:00Z", note = null, kind = "created", surface = "note"),
                        ),
                        undoSeq = 14,
                    ),
                ),
                zone = ZoneOffset.UTC,
            )
        }
    }
}
