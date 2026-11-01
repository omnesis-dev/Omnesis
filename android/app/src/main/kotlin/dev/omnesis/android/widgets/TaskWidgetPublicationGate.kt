// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.widgets

/**
 * One publication includes reading the current pairing and cache, preparing every
 * RemoteViews tree and posting the complete batch. A lifecycle render therefore
 * follows, rather than being overtaken by, a worker already rendering old data.
 */
internal class TaskWidgetPublicationGate {
    private val lock = Any()

    fun publish(prepareAndPost: () -> Unit) = synchronized(lock) { prepareAndPost() }
}
