// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.widgets

import android.content.Context
import android.content.SharedPreferences
import dev.omnesis.android.pairing.KeystorePrefsCipher
import dev.omnesis.android.pairing.PrefsCipher
import dev.omnesis.android.transport.dto.OmnesisJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

interface WidgetSnapshotStore {
    fun read(authority: String): TaskWidgetSnapshot?
    fun save(authority: String, snapshot: TaskWidgetSnapshot)
    fun clear()
}

/** Sealed app-private cache, independent of the pairing transaction's replaceAll store. */
class TaskWidgetCache(
    private val prefs: SharedPreferences,
    private val cipher: PrefsCipher,
    private val currentAuthority: () -> String?,
) : WidgetSnapshotStore {
    constructor(context: Context) : this(
        context.applicationContext.getSharedPreferences("omnesis.task-widgets.cache", Context.MODE_PRIVATE),
        KeystorePrefsCipher(),
        { TaskWidgetUpdates.pairing(context)?.let(TaskWidgetRepository::authority) },
    )

    @Serializable
    private data class Cached(val authority: String, val snapshot: TaskWidgetSnapshot)

    override fun read(authority: String): TaskWidgetSnapshot? = synchronized(lock) {
        cached()?.takeIf { it.authority == authority }?.snapshot
    }

    override fun save(authority: String, snapshot: TaskWidgetSnapshot) = synchronized(lock) {
        // Check inside the same critical section as clear: an old fetch cannot
        // repopulate erased content after unpairing or changing the gateway.
        if (currentAuthority() != authority) return@synchronized
        val previous = cached()
        if (previous?.authority == authority && previous.snapshot.updatedAt > snapshot.updatedAt) return@synchronized
        val sealed = cipher.seal(OmnesisJson.encodeToString(Cached(authority, snapshot)))
        check(prefs.edit().putString("snapshot", sealed).commit()) { "Could not store widget snapshot" }
    }

    override fun clear() = synchronized(lock) {
        check(prefs.edit().clear().commit()) { "Could not clear widget snapshot" }
    }

    private fun cached(): Cached? = runCatching {
        prefs.getString("snapshot", null)?.let { OmnesisJson.decodeFromString<Cached>(cipher.open(it)) }
    }.getOrNull()

    companion object {
        private val lock = Any()
    }
}

/** These preferences contain presentation choices and an opaque authority digest, never titles or tokens. */
class TaskWidgetStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("omnesis.task-widgets.state", Context.MODE_PRIVATE)

    fun state(id: Int): TaskWidgetState = synchronized(lock) {
        runCatching { prefs.getString("widget.$id", null)?.let { OmnesisJson.decodeFromString<TaskWidgetState>(it) } }
            .getOrNull()?.let { it.copy(offset = it.offset.coerceIn(-120, 120), page = it.page.coerceIn(0, 10000)) }
            ?: TaskWidgetState()
    }

    fun save(id: Int, state: TaskWidgetState) = synchronized(lock) {
        prefs.edit().putString("widget.$id", OmnesisJson.encodeToString(state)).apply()
    }

    fun delete(id: Int) = synchronized(lock) { prefs.edit().remove("widget.$id").apply() }

    fun reconcile(authority: String?): Boolean = synchronized(lock) {
        if (prefs.getString("authority", null) == authority) return@synchronized false
        prefs.edit().putString("authority", authority).putString("status", TaskWidgetStatus.UNPAIRED.name).apply()
        true
    }

    fun status(): TaskWidgetStatus = synchronized(lock) {
        runCatching { TaskWidgetStatus.valueOf(prefs.getString("status", null).orEmpty()) }
            .getOrDefault(TaskWidgetStatus.UNPAIRED)
    }

    fun status(status: TaskWidgetStatus) = synchronized(lock) { prefs.edit().putString("status", status.name).apply() }

    companion object {
        private val lock = Any()
    }
}
