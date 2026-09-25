// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import dev.omnesis.android.transport.dto.ModelsOverview

/** Keep a conflicted role blocked until one fresh overview has been applied. */
internal class BehaviorConflictRecovery(
    private val fetch: suspend () -> ModelsOverview,
    private val applyFresh: (String, ModelsOverview) -> Unit,
) {
    private val blocked = mutableSetOf<String>()
    private val refreshing = mutableSetOf<String>()

    val hasBlockedRoles: Boolean get() = blocked.isNotEmpty()
    fun isBlocked(role: String): Boolean = role in blocked
    fun mark(role: String) { blocked += role }
    fun clear() { blocked.clear() }

    /** Null means this role already has a refresh in flight. */
    suspend fun refresh(role: String): Result<ModelsOverview>? {
        if (!refreshing.add(role)) return null
        return try {
            runCatching { fetch().also { applyFresh(role, it) } }.onSuccess { blocked.remove(role) }
        } finally {
            refreshing.remove(role)
        }
    }
}
