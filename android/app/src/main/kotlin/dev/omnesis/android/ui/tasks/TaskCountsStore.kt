// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.tasks

import dev.omnesis.android.transport.dto.TaskCountsDto
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The journal's latest counts, shared between the Tasks screen and the menu. The screen
 * publishes the counts every view read carries, so a change made on the screen reaches the
 * menu's "Tasks (n)" without a second request; the menu reads `GET /tasks/counts` itself when
 * it is revealed and when the app becomes active.
 */
@Singleton
class TaskCountsStore @Inject constructor() {
    private val _counts = MutableStateFlow(TaskCountsDto())
    val counts: StateFlow<TaskCountsDto> = _counts.asStateFlow()

    fun publish(counts: TaskCountsDto) {
        _counts.value = counts
    }

    /** Nothing to count: no gateway, or one that does not serve Tasks. */
    fun clear() {
        _counts.value = TaskCountsDto()
    }
}

/** The menu row's label: today's open tasks in brackets, plain "Tasks" when there are none. */
fun tasksMenuLabel(todayOpen: Int): String = if (todayOpen > 0) "Tasks ($todayOpen)" else "Tasks"
