// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.assistant

import android.content.Intent
import android.os.Bundle
import android.speech.tts.Voice
import dev.omnesis.android.MainActivity
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AssistantActionContractTest {
    @Test fun `permission request generation survives Activity recreation`() {
        val saved = Bundle()
        saved.saveAssistantDeliveryState(
            AssistantDeliveryState(
                deliveryGeneration = 7,
                permissionRequestGeneration = 7,
            ),
        )

        assertEquals(
            AssistantDeliveryState(
                deliveryGeneration = 7,
                permissionRequestGeneration = 7,
            ),
            restoreAssistantDeliveryState(saved),
        )
    }

    @Test fun `App Action intents accept only the declared actions and parameters`() {
        assertEquals(
            AssistantActionRequest.Ask("When is the review?"),
            AssistantActionRequest.from(
                Intent(AssistantActionActivity.ACTION_ASK)
                    .putExtra(AssistantActionActivity.EXTRA_QUESTION, "  When is the review?  "),
            ),
        )
        assertEquals(
            AssistantActionRequest.Capture("Book the train tickets"),
            AssistantActionRequest.from(
                Intent(AssistantActionActivity.ACTION_CAPTURE)
                    .putExtra(AssistantActionActivity.EXTRA_NOTE, "Book the train tickets"),
            ),
        )
        assertEquals(
            AssistantActionRequest.Capture(null),
            AssistantActionRequest.from(
                Intent(AssistantActionActivity.ACTION_OPEN_FEATURE)
                    .putExtra(AssistantActionActivity.EXTRA_FEATURE, "tell_brain"),
            ),
        )
        assertNull(AssistantActionRequest.from(Intent("example.invalid.ACTION")))
        assertNull(AssistantActionRequest.from(Intent(MainActivity.ACTION_SEARCH)))
        assertNull(AssistantActionRequest.from(Intent(AssistantActionActivity.ACTION_OPEN_FEATURE)))
        assertNull(
            AssistantActionRequest.from(
                Intent(AssistantActionActivity.ACTION_OPEN_FEATURE)
                    .putExtra(AssistantActionActivity.EXTRA_FEATURE, "unknown"),
            ),
        )
    }

    @Test fun `TTS chunks preserve all text when no word boundary fits`() {
        val input = "abcdefghij"
        assertEquals(listOf("abcd", "efgh", "ij"), AssistantActionActivity.ttsChunks(input, limit = 4))
    }

    @Test fun `TTS chunks prefer sentence and word boundaries`() {
        val input = "First sentence. Second phrase here"
        val chunks = AssistantActionActivity.ttsChunks(input, limit = 19)
        assertEquals(listOf("First sentence.", "Second phrase here"), chunks)
        assertEquals(input, chunks.joinToString(" "))
    }

    @Test fun `only the current delivery's TTS callbacks are accepted`() {
        val current = AssistantActionActivity.utteranceId(4, "nonce", "-final")
        val stale = AssistantActionActivity.utteranceId(3, "nonce", "-final")
        assertEquals(true, AssistantActionActivity.isCurrentUtterance(current, 4))
        assertEquals(false, AssistantActionActivity.isCurrentUtterance(stale, 4))
        assertEquals(false, AssistantActionActivity.isCurrentUtterance(null, 4))
    }

    @Test fun `only Google-signed Assistant callers bypass confirmation`() {
        assertEquals(
            true,
            AssistantActionActivity.trustedAssistantPackage(
                "com.google.android.googlequicksearchbox",
                signatureMatchesGoogle = true,
            ),
        )
        assertEquals(
            false,
            AssistantActionActivity.trustedAssistantPackage(
                "com.google.android.googlequicksearchbox",
                signatureMatchesGoogle = false,
            ),
        )
        assertEquals(false, AssistantActionActivity.trustedAssistantPackage("example.attacker", true))
    }

    @Test fun `TTS selects an offline locale voice and rejects network-only engines`() {
        val network = Voice("network", Locale.UK, 400, 100, true, emptySet())
        val offline = Voice("offline", Locale.UK, 300, 100, false, emptySet())

        assertEquals(offline, AssistantActionActivity.offlineVoice(setOf(network, offline), Locale.UK))
        assertNull(AssistantActionActivity.offlineVoice(setOf(network), Locale.UK))
    }
}
