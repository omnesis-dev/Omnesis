// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/** The exact agent surface that was active when the app left the foreground. */
data class AppForegroundSnapshot(
    val backgroundedAtMillis: Long,
    val surface: AppForegroundSurface,
)

sealed interface AppForegroundSurface {
    data class Conversation(val id: String) : AppForegroundSurface
    data object FreshConversation : AppForegroundSurface
    data object OutsideAgent : AppForegroundSurface
}

sealed interface AppForegroundDestination {
    data class Conversation(val id: String) : AppForegroundDestination
    data object FreshConversation : AppForegroundDestination
    data object PreserveCurrent : AppForegroundDestination
}

/** Pure one-hour boundary used by the lifecycle shell and its JVM tests. */
object AppForegroundPolicy {
    const val RECENT_WINDOW_MILLIS = 3_600_000L // PARITY:agent-return-window-ms

    fun destination(
        snapshot: AppForegroundSnapshot?,
        nowMillis: Long,
    ): AppForegroundDestination {
        val age = snapshot?.let { nowMillis - it.backgroundedAtMillis }
        if (snapshot == null || age == null || age < 0 || age >= RECENT_WINDOW_MILLIS) {
            return AppForegroundDestination.FreshConversation
        }
        return when (val surface = snapshot.surface) {
            is AppForegroundSurface.Conversation -> surface.id
                .takeIf { it.isNotBlank() }
                ?.let(AppForegroundDestination::Conversation)
                ?: AppForegroundDestination.FreshConversation
            AppForegroundSurface.FreshConversation -> AppForegroundDestination.FreshConversation
            AppForegroundSurface.OutsideAgent -> AppForegroundDestination.PreserveCurrent
        }
    }

    fun isRecentFresh(snapshot: AppForegroundSnapshot?, nowMillis: Long): Boolean {
        val age = snapshot?.let { nowMillis - it.backgroundedAtMillis }
        return snapshot?.surface == AppForegroundSurface.FreshConversation &&
            age != null && age >= 0 && age < RECENT_WINDOW_MILLIS
    }

}

/**
 * Persists the last backgrounded agent surface across process death. [FreshConversation] records
 * the fresh, lazily minted empty composer without inventing a conversation id.
 */
@Singleton
class AppForegroundStore internal constructor(
    context: Context,
    private val nowMillis: () -> Long,
) {
    @Inject
    constructor(@ApplicationContext context: Context) : this(context, System::currentTimeMillis)

    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    fun load(): AppForegroundSnapshot? {
        if (!preferences.contains(KEY_BACKGROUNDED_AT)) return null
        return AppForegroundSnapshot(
            backgroundedAtMillis = preferences.getLong(KEY_BACKGROUNDED_AT, 0L),
            surface = when (preferences.getString(KEY_SURFACE, null)) {
                SURFACE_CONVERSATION -> preferences.getString(KEY_CONVERSATION_ID, null)
                    ?.let(AppForegroundSurface::Conversation)
                    ?: AppForegroundSurface.FreshConversation
                SURFACE_FRESH -> AppForegroundSurface.FreshConversation
                SURFACE_OUTSIDE_AGENT -> AppForegroundSurface.OutsideAgent
                else -> return null
            },
        )
    }

    fun destination(): AppForegroundDestination =
        AppForegroundPolicy.destination(load(), nowMillis())

    fun hasRecentFreshSurface(): Boolean =
        AppForegroundPolicy.isRecentFresh(load(), nowMillis())

    fun save(surface: AppForegroundSurface) {
        val editor = preferences.edit().putLong(KEY_BACKGROUNDED_AT, nowMillis())
        when (surface) {
            is AppForegroundSurface.Conversation -> editor
                .putString(KEY_SURFACE, SURFACE_CONVERSATION)
                .putString(KEY_CONVERSATION_ID, surface.id)
            AppForegroundSurface.FreshConversation -> editor
                .putString(KEY_SURFACE, SURFACE_FRESH)
                .remove(KEY_CONVERSATION_ID)
            AppForegroundSurface.OutsideAgent -> editor
                .putString(KEY_SURFACE, SURFACE_OUTSIDE_AGENT)
                .remove(KEY_CONVERSATION_ID)
        }
        editor
            // ON_STOP is the last reliable lifecycle callback before process death.
            .commit()
    }

    private companion object {
        const val PREFERENCES = "omnesis_app_foreground"
        const val KEY_BACKGROUNDED_AT = "backgrounded_at_millis"
        const val KEY_SURFACE = "surface"
        const val KEY_CONVERSATION_ID = "conversation_id"
        const val SURFACE_CONVERSATION = "conversation"
        const val SURFACE_FRESH = "fresh"
        const val SURFACE_OUTSIDE_AGENT = "outside_agent"
    }
}
