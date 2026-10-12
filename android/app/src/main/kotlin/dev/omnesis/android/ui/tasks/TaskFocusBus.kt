// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.tasks

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
