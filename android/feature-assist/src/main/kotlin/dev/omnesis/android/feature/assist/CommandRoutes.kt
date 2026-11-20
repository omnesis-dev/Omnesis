// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Where the command after a wake word goes. */
@Serializable
sealed interface Destination {
    /** The audio, to Home Assistant's Assist pipeline, which transcribes and carries it out. */
    @Serializable
    @SerialName("home-assistant")
    data object HomeAssistant : Destination

    /** The transcribed text, posted as JSON to [url]. */
    @Serializable
    @SerialName("webhook")
    data class Webhook(val url: String = "") : Destination

    /** The transcribed text, read as a timer or an alarm and set on this phone. */
    @Serializable
    @SerialName("phone")
    data object PhoneAction : Destination

    /** The text the command needs; Home Assistant hears the audio itself. */
    val needsText: Boolean get() = this !is HomeAssistant
}

/** One wake word and where what follows it goes. */
@Serializable
data class CommandRoute(
    val id: String,
    /** A [WakeWord.id]. */
    val wakeWord: String,
    val destination: Destination,
    val threshold: Float = DEFAULT_THRESHOLD,
) {
    companion object {
        const val DEFAULT_THRESHOLD = 0.5f

        /** What a fresh install offers: “ok home” for Home Assistant. */
        val defaults = listOf(CommandRoute("home-assistant", WakeWordModelCatalog.OK_HOME.id, Destination.HomeAssistant))
    }
}

/** A route the listener hears, with its wake word resolved. */
data class ActiveRoute(val route: CommandRoute, val word: WakeWord)

/** Is [url] something a command can be posted to: `http(s)://` and a host. */
fun isWebhookUrl(url: String): Boolean {
    val t = url.trim()
    val rest = when {
        t.startsWith("https://") -> t.removePrefix("https://")
        t.startsWith("http://") -> t.removePrefix("http://")
        else -> return false
    }
    return rest.isNotEmpty() && !rest.startsWith("/") && rest.none(Char::isWhitespace)
}
