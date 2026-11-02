// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.tasks

import dev.omnesis.android.widgets.TaskWidgetDeepLink
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Hands "show this task" from elsewhere in the app — a task chip under a morning brief — to the
 * Tasks screen, which opens the task's details and calls [consume]. Each request carries a
 * [Request.nonce], so asking for the same task twice opens it twice.
 */
@Singleton
class TaskFocusBus @Inject constructor() {

    data class Request(val taskId: String, val nonce: Long)
    data class JournalRequest(val journal: TaskWidgetDeepLink, val nonce: Long)
    data class Launch(val journal: TaskWidgetDeepLink, val nonce: Long)

    private val _launch = MutableStateFlow<Launch?>(null)
    val launch: StateFlow<Launch?> = _launch.asStateFlow()

    /** The app shell owns navigation; an off-screen Tasks view model cannot consume its launch. */
    fun postLaunch(journal: TaskWidgetDeepLink) {
        _launch.value = Launch(journal, ++counter)
    }

    fun consumeLaunch(launch: Launch) { _launch.compareAndSet(launch, null) }

    private val _journal = MutableStateFlow<JournalRequest?>(null)
    val journal: StateFlow<JournalRequest?> = _journal.asStateFlow()

    fun postJournal(journal: TaskWidgetDeepLink) {
        _journal.value = JournalRequest(journal, ++counter)
    }

    /** Only the resumed Tasks screen takes a widget destination. */
    fun takeJournal(request: JournalRequest): Boolean = _journal.compareAndSet(request, null)

    private val _request = MutableStateFlow<Request?>(null)
    val request: StateFlow<Request?> = _request.asStateFlow()

    private var counter = 0L

    fun post(taskId: String) {
        _request.value = Request(taskId = taskId, nonce = ++counter)
    }

    /** Take [request] off the bus, unless a newer one replaced it meanwhile. */
    fun consume(request: Request) {
        _request.compareAndSet(request, null)
    }
}
