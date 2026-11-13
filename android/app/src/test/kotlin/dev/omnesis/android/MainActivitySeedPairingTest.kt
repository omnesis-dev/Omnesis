// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android

import android.content.Intent
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import dagger.hilt.android.testing.HiltTestApplication
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.ui.home.MockGateway
import javax.inject.Inject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The debug build's way to pair without the pairing screen, which the instrumented journeys use.
 * Only code running inside the app can use it: an intent from another app that names a gateway
 * and a pairing code must never pair the phone, whatever extras it carries.
 */
@HiltAndroidTest
@RunWith(RobolectricTestRunner::class)
@Config(application = HiltTestApplication::class, sdk = [34])
class MainActivitySeedPairingTest {
    @get:Rule
    val hilt = HiltAndroidRule(this)

    @Inject lateinit var sessions: SessionManager

    private val context get() = ApplicationProvider.getApplicationContext<HiltTestApplication>()

    @Before
    fun setUp() {
        WorkManagerTestInitHelper.initializeTestWorkManager(
            context,
            Configuration.Builder().setExecutor(SynchronousExecutor()).build(),
        )
        hilt.inject()
    }

    /** Lets the activity's work run for [millis], on the main looper and the network threads alike. */
    private fun settle(millis: Long, until: () -> Boolean = { false }) {
        val deadline = System.currentTimeMillis() + millis
        while (System.currentTimeMillis() < deadline && !until()) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(50)
        }
        shadowOf(Looper.getMainLooper()).idle()
    }

    private fun pairingRequests(gateway: MockGateway) = gateway.requests.count { it == "POST /devices/pair" }

    @Test
    fun `F22 another app's seed-pairing extras do not pair a debug build to its gateway`() {
        assertTrue("this attack targets debug builds, which the unit tests run", BuildConfig.DEBUG)
        MockGateway().use { attacker ->
            // What any installed app can send: an explicit intent for the exported activity,
            // naming its own gateway, a pairing code it minted there and its certificate.
            val launch = Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra("seed_url", attacker.url.trimEnd('/'))
                .putExtra("seed_code", "ATTACKER-CODE")
                .putExtra("seed_fingerprint", attacker.fingerprint)

            Robolectric.buildActivity(MainActivity::class.java, launch).create().start().resume()
            settle(3_000) { pairingRequests(attacker) > 0 }

            assertEquals("the phone must not offer a pairing code to the sender's gateway", 0, pairingRequests(attacker))
            assertEquals(SessionManager.AppState.Unpaired, sessions.state.value)
        }
    }
}
