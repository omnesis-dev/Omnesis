// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.assistant

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import java.time.Duration
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton

/** Keeps spoken follow-up questions in one conversation for a short, bounded window. */
@Singleton
class VoiceAskContinuityStore @Inject constructor(
    @ApplicationContext context: Context,
) : VoiceAskContinuity {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun conversationToResume(): String? {
        val id = prefs.getString(KEY_CONVERSATION_ID, null)?.takeIf(String::isNotBlank) ?: return null
        val askedAtMillis = prefs.getLong(KEY_ASKED_AT, Long.MIN_VALUE)
        if (askedAtMillis == Long.MIN_VALUE) return null
        val age = Duration.between(Instant.ofEpochMilli(askedAtMillis), Instant.now())
        return id.takeIf { !age.isNegative && age < CONTINUITY_WINDOW }
    }

    override fun record(conversationId: String) {
        prefs.edit()
            .putString(KEY_CONVERSATION_ID, conversationId)
            .putLong(KEY_ASKED_AT, Instant.now().toEpochMilli())
            .apply()
    }

    companion object {
        val CONTINUITY_WINDOW: Duration = Duration.ofMinutes(5)
        internal const val PREFS_NAME = "omnesis_voice_ask"
        internal const val KEY_CONVERSATION_ID = "last_conversation_id"
        internal const val KEY_ASKED_AT = "last_asked_at"
    }
}

interface VoiceAskContinuity {
    fun conversationToResume(): String?
    fun record(conversationId: String)
}
