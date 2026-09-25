// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import dev.omnesis.android.feature.health.di.HealthConnectAvailability
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Full truth table for the worker's pure gate: it may only return true when
 * every leg holds — enabled, provider Available, background-read granted,
 * background-read feature supported, and a live session.
 */
class HealthSyncWorkerGatingTest {

    @Test
    fun truth_table() {
        val bools = listOf(false, true)
        for (enabled in bools) {
            for (availability in HealthConnectAvailability.entries) {
                for (granted in bools) {
                    for (feature in bools) {
                        for (hasSession in bools) {
                            val expected = enabled &&
                                availability == HealthConnectAvailability.Available &&
                                granted && feature && hasSession
                            assertEquals(
                                "enabled=$enabled availability=$availability granted=$granted " +
                                    "feature=$feature hasSession=$hasSession",
                                expected,
                                shouldRunBackgroundSync(
                                    enabled = enabled,
                                    availability = availability,
                                    backgroundReadGranted = granted,
                                    backgroundReadFeatureAvailable = feature,
                                    hasSession = hasSession,
                                ),
                            )
                        }
                    }
                }
            }
        }
    }
}
