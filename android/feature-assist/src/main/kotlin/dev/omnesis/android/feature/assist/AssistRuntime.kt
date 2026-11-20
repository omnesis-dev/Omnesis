// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import dev.omnesis.android.feature.recording.WearableAudio
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine

/**
 * What a wearable's link service talks to: it reports whether the wearable
 * streams, and voice commands listen exactly while they are switched on, at
 * least one route is ready (its wake word's models on the phone and its
 * destination set up) and the wearable is there to hear.
 */
class AssistRuntime(
    private val settings: AssistSettings,
    private val models: WakeWordModelStore,
    private val commands: VoiceCommands,
    /** Whether phone actions may start the clock app from the background. */
    private val phoneAllowed: StateFlow<Boolean>,
) {
    val preferences: StateFlow<AssistPreferences> get() = settings.state

    /** Emits after any change that can alter what is listened for: the settings, the models on the phone or the phone permission. */
    val changes: Flow<Unit> get() = combine(settings.state, models.changes, phoneAllowed) { _, _, _ -> }

    val listening: Boolean get() = commands.listening

    /** The wake words listened for now, as said. */
    val phrases: List<String> get() = commands.phrases

    /** The routes that can be heard now. */
    fun activeRoutes(): List<ActiveRoute> = settings.state.value.routes.mapNotNull { route ->
        val word = models.word(route.wakeWord)?.takeIf(models::installed) ?: return@mapNotNull null
        val ready = when (val d = route.destination) {
            Destination.HomeAssistant -> settings.config() != null
            is Destination.Webhook -> isWebhookUrl(d.url)
            Destination.PhoneAction -> phoneAllowed.value
        }
        if (ready) ActiveRoute(route, word) else null
    }

    /** Start or stop listening to [input] after any change to its readiness or the settings. */
    fun sync(input: WearableAudio, ready: Boolean, feedback: (CommandFeedback) -> Unit) {
        val active = if (ready && settings.state.value.enabled) activeRoutes() else emptyList()
        if (active.isNotEmpty()) commands.start(input, active, feedback) else commands.stop()
    }

    fun stop() = commands.stop()
}
