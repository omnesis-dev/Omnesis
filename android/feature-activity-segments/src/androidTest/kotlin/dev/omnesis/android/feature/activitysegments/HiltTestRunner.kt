// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import android.app.Application
import android.content.Context
import androidx.test.runner.AndroidJUnitRunner
import dagger.hilt.android.testing.HiltTestApplication

/**
 * Swaps in [HiltTestApplication] for this module's `connectedAndroidTest`
 * APK, so [ActivityTransitionReceiverRoundTripTest] resolves the exact same
 * Hilt `@EntryPoint` the production [ActivityTransitionReceiver] uses,
 * without depending on `:app`'s real `Application`.
 */
class HiltTestRunner : AndroidJUnitRunner() {
    override fun newApplication(cl: ClassLoader, className: String, context: Context): Application =
        super.newApplication(cl, HiltTestApplication::class.java.name, context)
}
