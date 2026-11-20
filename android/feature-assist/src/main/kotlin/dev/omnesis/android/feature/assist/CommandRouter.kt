// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

/**
 * Sends a command to where its wake word's route points. Home Assistant
 * hears the audio itself, as before; the webhook and the phone get the text
 * [transcribe] makes of it, and a command with no text is not understood.
 */
class CommandRouter(
    private val homeAssistant: suspend (ShortArray) -> AssistOutcome,
    private val transcribe: suspend (ShortArray) -> String?,
    private val webhook: suspend (route: CommandRoute, url: String, text: String) -> AssistOutcome,
    private val phone: suspend (String) -> AssistOutcome,
) {
    suspend fun send(route: CommandRoute, pcm: ShortArray): AssistOutcome {
        val destination = route.destination
        if (destination is Destination.HomeAssistant) return homeAssistant(pcm)
        val text = transcribe(pcm) ?: return AssistOutcome.NotUnderstood("nothing transcribed")
        return when (destination) {
            is Destination.Webhook -> webhook(route, destination.url, text)
            Destination.PhoneAction -> phone(text)
            Destination.HomeAssistant -> error("handled above")
        }
    }
}
