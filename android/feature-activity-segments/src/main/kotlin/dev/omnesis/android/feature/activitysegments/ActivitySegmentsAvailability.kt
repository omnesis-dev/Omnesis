// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import android.content.Context
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability

/**
 * Whether Google Play services is usable on this device — required for
 * `ActivityRecognitionClient` (unlike Call Log or App Usage, which are pure
 * platform APIs with no Play Services dependency). Mirrors
 * `HealthConnectAvailability`'s sealed-state shape.
 */
enum class ActivitySegmentsAvailability {
    /** This device's Play services install can never support the API (a permanent per-device state). */
    NotSupported,

    /** Play services isn't installed at all. */
    NotInstalled,

    /** Installed but too old for this app's required API surface. */
    UpdateRequired,

    /** Ready — `ActivityRecognitionClient` calls will succeed. */
    Available;

    companion object {
        fun detect(context: Context): ActivitySegmentsAvailability {
            val availability = GoogleApiAvailability.getInstance()
            val code = availability.isGooglePlayServicesAvailable(context)
            return classify(code, availability.isUserResolvableError(code))
        }

        /**
         * The pure code→state mapping, extracted so it's parameter-testable
         * without a real `GoogleApiAvailability` check. [resolvable] mirrors
         * `GoogleApiAvailability.isUserResolvableError(code)`: a resolvable failure
         * means the user can fix it themselves (install/update/enable Play
         * services); an unresolvable one means this device can never support
         * the API at all.
         */
        fun classify(code: Int, resolvable: Boolean): ActivitySegmentsAvailability = when (code) {
            ConnectionResult.SUCCESS -> Available
            ConnectionResult.SERVICE_MISSING, ConnectionResult.SERVICE_DISABLED -> NotInstalled
            ConnectionResult.SERVICE_VERSION_UPDATE_REQUIRED -> UpdateRequired
            else -> if (resolvable) NotInstalled else NotSupported
        }
    }
}
