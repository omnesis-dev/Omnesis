// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import android.content.Context
import android.content.SharedPreferences
import dagger.hilt.android.qualifiers.ApplicationContext
import dev.omnesis.android.transport.client.ConversationSubmissionBody
import dev.omnesis.android.transport.dto.OmnesisJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import javax.inject.Inject
import javax.inject.Singleton

/** App-private, backup-excluded composer state, partitioned by pairing and conversation. */
@Singleton
class AgentComposerStore private constructor(private val preferences: SharedPreferences?) {
    @Inject constructor(@ApplicationContext context: Context) : this(
        context.getSharedPreferences("omnesis.conversation-composers", Context.MODE_PRIVATE),
    )
    constructor() : this(null)

    private val memory = mutableMapOf<String, ComposerRecord>()

    fun read(account: String, conversation: String?): ComposerRecord {
        val key = key(account, conversation)
        return preferences?.getString(key, null)?.let {
            runCatching { OmnesisJson.decodeFromString<ComposerRecord>(it) }.getOrNull()
        } ?: memory[key] ?: ComposerRecord()
    }

    fun write(account: String, conversation: String?, record: ComposerRecord) {
        val key = key(account, conversation)
        memory[key] = record
        // SharedPreferences publishes the update immediately and serializes disk writes, so
        // navigation and background lifecycle callbacks cannot restore an older draft.
        preferences?.edit()?.putString(key, OmnesisJson.encodeToString(record))?.apply()
    }

    fun remove(account: String, conversation: String?) {
        val key = key(account, conversation)
        memory.remove(key)
        preferences?.edit()?.remove(key)?.apply()
    }

    private fun key(account: String, conversation: String?): String =
        "${account.length}:$account:${conversation ?: "new"}"
}

@Serializable
data class ComposerRecord(
    val text: String = "",
    val commandId: String? = null,
    val editingPrompt: Boolean = false,
    val savedDraftText: String? = null,
    val savedDraftCommandId: String? = null,
    val pending: List<ConversationSubmissionBody> = emptyList(),
)
