// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import android.content.Context
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import java.time.Instant
import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Manual QA utility — NOT an assertion test. Seeds invented Health Connect
 * records onto a connected device and **leaves them in place**, so the production
 * Omnesis app can ingest them on its next sync. Use it to exercise the Health
 * Connect integration on a device with no real health history (e.g. a dedicated
 * QA phone). Unlike [HealthConnectRoundTripTest], it never deletes what it writes.
 *
 * The seeded set spans every health table the source produces: hc_body (two
 * weights + a third "delta" weight), hc_activity (a steps interval), hc_vitals (a
 * three-sample heart rate) and hc_sleep (a two-stage session). All values are
 * invented in [SyntheticHealthData] (privacy rule) and timestamped within the
 * last few hours of `now`.
 *
 * Run it from a host with the device attached (the device must be UNLOCKED the
 * first time so the Health Connect consent UI can be driven by UiAutomator):
 *
 *   ./gradlew :feature-health:connectedDebugAndroidTest \
 *     -Pandroid.testInstrumentationRunnerArguments.class=dev.omnesis.android.feature.health.SeedHealthData#seedAndLeave
 *
 * Then in Omnesis: Settings → Health Connect → Sync now. Re-running upserts the
 * same records (stable clientRecordIds), which also exercises the delta path.
 *
 * AGP uninstalls the test APK after each connected run, so the consent dance
 * repeats every run — but the seeded data persists in the provider regardless.
 */
@LargeTest
@RunWith(AndroidJUnit4::class)
class SeedHealthData {

    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test
    fun seedAndLeave() {
        assumeTrue(
            "Health Connect SDK not available on this device",
            HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE,
        )
        val client = HealthConnectClient.getOrCreate(context)
        HealthPermissionGate.ensureGranted(context, client)

        // A RESUMED blank host keeps the insert/read in the foreground (no
        // background grant needed), mirroring the round-trip test.
        ActivityScenario.launch(TierBHostActivity::class.java).use {
            val base = Instant.now()
            val records = SyntheticHealthData.baselineRecords(base) +
                SyntheticHealthData.deltaWeight(base) +
                SyntheticHealthData.energyAndDistanceRecords(base) +
                SyntheticHealthData.fullCoverageRecords(base)
            val ids = runBlocking { client.insertRecords(records).recordIdsList }
            Log.i(TAG, "Seeded ${ids.size} Health Connect records (left in place): $ids")
        }
    }

    private companion object {
        const val TAG = "OmnesisSeed"
    }
}
