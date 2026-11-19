// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import android.content.SharedPreferences
import dev.omnesis.android.feature.recording.ui.RecordingAvailability.Availability

/**
 * What the paired gateway last said about recordings, kept across launches so
 * a recording can start while the gateway is out of reach: the outbox holds
 * the chunks until it is back. It answers only for the pairing it was told
 * about, so a new pairing starts from [Availability.UNAVAILABLE] until its
 * gateway has been asked. If the gateway stops taking recordings meanwhile,
 * the upload is refused and the recording says so in the list.
 */
class RecordingAvailabilityMemory(private val prefs: SharedPreferences) {

    /** The last answer for [pairingKey], or [Availability.UNAVAILABLE] if this pairing was never asked. */
    fun lastKnown(pairingKey: String): Availability {
        if (prefs.getString(KEY_PAIRING, null) != pairingKey) return Availability.UNAVAILABLE
        val name = prefs.getString(KEY_AVAILABILITY, null) ?: return Availability.UNAVAILABLE
        return Availability.entries.firstOrNull { it.name == name } ?: Availability.UNAVAILABLE
    }

    /** Keep the gateway's answer for [pairingKey], replacing what another pairing left. */
    fun remember(pairingKey: String, availability: Availability) {
        if (prefs.getString(KEY_PAIRING, null) == pairingKey &&
            prefs.getString(KEY_AVAILABILITY, null) == availability.name
        ) {
            return
        }
        prefs.edit().putString(KEY_PAIRING, pairingKey).putString(KEY_AVAILABILITY, availability.name).apply()
    }

    /** The phone is no longer paired: nothing is known. */
    fun forget() {
        prefs.edit().remove(KEY_PAIRING).remove(KEY_AVAILABILITY).apply()
    }

    companion object {
        const val PREFS_NAME = "omnesis.recording.availability"
        private const val KEY_PAIRING = "pairing"
        private const val KEY_AVAILABILITY = "availability"
    }
}
