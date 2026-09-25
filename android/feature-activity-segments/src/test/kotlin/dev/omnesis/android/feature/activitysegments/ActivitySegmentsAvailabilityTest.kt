// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import com.google.android.gms.common.ConnectionResult
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Exercises [ActivitySegmentsAvailability.classify] — the pure code→state
 * mapping — without any real `GoogleApiAvailability` check. The
 * `ConnectionResult` constants referenced here are compile-time integer
 * constants (inlined by the compiler), so no live GMS call happens.
 */
class ActivitySegmentsAvailabilityTest {

    @Test
    fun `SUCCESS maps to Available`() {
        assertEquals(ActivitySegmentsAvailability.Available, ActivitySegmentsAvailability.classify(ConnectionResult.SUCCESS, resolvable = false))
    }

    @Test
    fun `SERVICE_MISSING maps to NotInstalled`() {
        assertEquals(ActivitySegmentsAvailability.NotInstalled, ActivitySegmentsAvailability.classify(ConnectionResult.SERVICE_MISSING, resolvable = true))
    }

    @Test
    fun `SERVICE_DISABLED maps to NotInstalled`() {
        assertEquals(ActivitySegmentsAvailability.NotInstalled, ActivitySegmentsAvailability.classify(ConnectionResult.SERVICE_DISABLED, resolvable = true))
    }

    @Test
    fun `SERVICE_VERSION_UPDATE_REQUIRED maps to UpdateRequired`() {
        assertEquals(
            ActivitySegmentsAvailability.UpdateRequired,
            ActivitySegmentsAvailability.classify(ConnectionResult.SERVICE_VERSION_UPDATE_REQUIRED, resolvable = true),
        )
    }

    @Test
    fun `an unresolvable unrecognized code maps to NotSupported`() {
        assertEquals(ActivitySegmentsAvailability.NotSupported, ActivitySegmentsAvailability.classify(ConnectionResult.SERVICE_INVALID, resolvable = false))
    }

    @Test
    fun `a resolvable unrecognized code maps to NotInstalled`() {
        assertEquals(ActivitySegmentsAvailability.NotInstalled, ActivitySegmentsAvailability.classify(ConnectionResult.SERVICE_INVALID, resolvable = true))
    }
}
