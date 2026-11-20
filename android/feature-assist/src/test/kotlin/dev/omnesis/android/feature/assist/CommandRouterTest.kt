// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CommandRouterTest {
    private val calls = mutableListOf<String>()
    private var transcript: String? = "turn on the lights"

    private val router = CommandRouter(
        homeAssistant = { pcm -> calls += "ha:${pcm.size}"; AssistOutcome.Done("ok") },
        transcribe = { pcm -> calls += "transcribe:${pcm.size}"; transcript },
        webhook = { route, url, text -> calls += "webhook:${route.id}:$url:$text"; AssistOutcome.Done(null) },
        phone = { text -> calls += "phone:$text"; AssistOutcome.Done(null) },
    )

    private val pcm = ShortArray(3_200)

    @Test fun homeAssistantHearsTheAudioWithNothingTranscribed() = runBlocking {
        val outcome = router.send(CommandRoute("a", "ok_home", Destination.HomeAssistant), pcm)
        assertTrue(outcome is AssistOutcome.Done)
        assertEquals(listOf("ha:3200"), calls)
    }

    @Test fun aWebhookGetsTheTranscriptAtItsAddress() = runBlocking {
        router.send(CommandRoute("b", "hey_mycroft", Destination.Webhook("https://hooks.example.com/x")), pcm)
        assertEquals(listOf("transcribe:3200", "webhook:b:https://hooks.example.com/x:turn on the lights"), calls)
    }

    @Test fun thePhoneGetsTheTranscript() = runBlocking {
        transcript = "timer for 5 minutes"
        router.send(CommandRoute("c", "alexa", Destination.PhoneAction), pcm)
        assertEquals(listOf("transcribe:3200", "phone:timer for 5 minutes"), calls)
    }

    @Test fun noTranscriptIsNotUnderstoodAndReachesNoDestination() = runBlocking {
        transcript = null
        val outcome = router.send(CommandRoute("c", "alexa", Destination.PhoneAction), pcm)
        assertTrue(outcome is AssistOutcome.NotUnderstood)
        assertEquals(listOf("transcribe:3200"), calls)
    }
}
