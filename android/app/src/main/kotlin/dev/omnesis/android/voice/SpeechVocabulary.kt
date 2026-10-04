// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.voice

import dev.omnesis.android.transport.TranscriptionVocabularyCache
import javax.inject.Inject
import javax.inject.Singleton

/** Shared memory-only speech cache; SessionManager owns its pairing lifecycle. */
@Singleton
class SpeechVocabulary @Inject constructor() {
    val cache = TranscriptionVocabularyCache { android.os.SystemClock.elapsedRealtime() }
}
