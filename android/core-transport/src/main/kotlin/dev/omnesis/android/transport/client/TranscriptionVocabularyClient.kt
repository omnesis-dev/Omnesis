// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.http.postJson
import kotlinx.serialization.Serializable

/** `POST /inference/transcription-vocabulary`, shared by native speech clients. */
class TranscriptionVocabularyClient(private val http: GatewayHttp) {
    suspend fun fetch(purpose: String, locale: String): TranscriptionVocabularySnapshot =
        http.postJson("inference/transcription-vocabulary", VocabularyRequest(purpose, VocabularySpeaker(true), listOf(locale)))
}

@Serializable
internal data class VocabularyRequest(
    val purpose: String,
    val speaker: VocabularySpeaker,
    val languageHints: List<String>,
)

@Serializable
internal data class VocabularySpeaker(val isSelf: Boolean)

/** Gateway vocabulary response; no corpus-derived text is persisted by the client. */
@Serializable
data class TranscriptionVocabularySnapshot(
    val enabled: Boolean = false,
    val entries: List<VocabularyEntry> = emptyList(),
    val refreshAfterSeconds: Long = 1800,
    val expiresAfterSeconds: Long = 86400,
)

@Serializable
data class VocabularyEntry(val text: String, val score: Double)
