// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.capture

import dev.omnesis.android.session.SessionManager
import javax.inject.Inject

/** Discovery and classification share the currently paired gateway. */
class CaptureRouting internal constructor(
    val active: suspend () -> Boolean,
    val route: suspend (String) -> String,
    val transcribe: suspend (dev.omnesis.android.notes.VoiceNoteAudio) -> String? = { null },
) {
    @Inject
    constructor(sessions: SessionManager) : this(
        active = {
            sessions.session?.gateway?.status()?.watchCapture?.active == true
        },
        route = { text ->
            val session = sessions.session ?: error("Not paired")
            val result = session.notes.routeCapture(text)
            check(sessions.session === session) { "Pairing changed" }
            result.route
        },
        transcribe = { audio ->
            val session = sessions.session ?: error("Not paired")
            val result = session.notes.transcribeCapture(audio.file, audio.mimeType)
            check(sessions.session === session) { "Pairing changed" }
            result
        },
    )
}
