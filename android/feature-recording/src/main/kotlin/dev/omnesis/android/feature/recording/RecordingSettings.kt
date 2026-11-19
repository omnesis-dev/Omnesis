// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import android.content.SharedPreferences

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

    companion object {
        const val PREFS_NAME = "omnesis.recording"
        private const val KEY_WIFI_ONLY = "wifiOnly"
        private const val KEY_INPUT = "input"
        /** A session stops on its own after this long. */
        const val MAX_SESSION_MS = 4L * 60 * 60 * 1000
    }
}
