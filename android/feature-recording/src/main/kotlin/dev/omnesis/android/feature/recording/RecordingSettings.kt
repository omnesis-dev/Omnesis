// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The recording mode's settings. */
class RecordingSettings(private val prefs: SharedPreferences) {
    /** Upload only on an unmetered network (Wi-Fi); recording itself is unaffected. */
    var wifiOnly: Boolean
        get() = prefs.getBoolean(KEY_WIFI_ONLY, false)
        set(value) {
            prefs.edit().putBoolean(KEY_WIFI_ONLY, value).apply()
        }

    /** The input the Start button records from, as last chosen; null until a choice is made. */
    var preferredInput: RecordingInput?
        get() = prefs.getString(KEY_INPUT, null)?.let { runCatching { RecordingInput.valueOf(it) }.getOrNull() }
        set(value) {
            prefs.edit().putString(KEY_INPUT, value?.name).apply()
        }

    private val _alwaysOn = MutableStateFlow(prefs.getBoolean(KEY_ALWAYS_ON, false))

    /**
     * Whether a linked wearable captures all day: every conversation it hears
     * is recorded as an episode of its own, and its button marks a moment
     * instead of starting and stopping.
     */
    val alwaysOn: StateFlow<Boolean> = _alwaysOn.asStateFlow()

    fun setAlwaysOn(on: Boolean) {
        prefs.edit().putBoolean(KEY_ALWAYS_ON, on).apply()
        _alwaysOn.value = on
    }

    private val _gatewayTakesRecordings = MutableStateFlow(prefs.getBoolean(KEY_GATEWAY_TAKES_RECORDINGS, true))

    /**
     * The paired gateway's last answer on whether it takes recordings
     * (experimental mode, with Recordings on in Omnesis Lab). Kept across
     * restarts so a wearable woken in the background, before the app has read
     * the gateway's status, knows whether to link; true until a first answer.
     */
    val gatewayTakesRecordings: StateFlow<Boolean> = _gatewayTakesRecordings.asStateFlow()

    fun setGatewayTakesRecordings(takes: Boolean) {
        if (_gatewayTakesRecordings.value == takes) return
        prefs.edit().putBoolean(KEY_GATEWAY_TAKES_RECORDINGS, takes).apply()
        _gatewayTakesRecordings.value = takes
    }

    companion object {
        const val PREFS_NAME = "omnesis.recording"
        private const val KEY_WIFI_ONLY = "wifiOnly"
        private const val KEY_INPUT = "input"
        private const val KEY_ALWAYS_ON = "alwaysOn"
        private const val KEY_GATEWAY_TAKES_RECORDINGS = "gatewayTakesRecordings"
        /** A session stops on its own after this long. */
        const val MAX_SESSION_MS = 4L * 60 * 60 * 1000
    }
}
