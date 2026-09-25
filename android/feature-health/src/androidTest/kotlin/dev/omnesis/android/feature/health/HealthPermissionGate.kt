// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import android.content.Context
import android.os.SystemClock
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.BasalBodyTemperatureRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.MenstruationFlowRecord
import androidx.health.connect.client.records.PowerRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.AssumptionViolatedException

/**
 * Grants the Health Connect permissions the Tier B round-trip needs.
 *
 * `android.permission.health.*` permissions cannot be `pm grant`-ed — Health
 * Connect manages them itself and only its own consent UI can flip them. So
 * this gate fires the permission request from a host activity — via the
 * production contract's intent
 * ([PermissionController.createRequestPermissionResultContract]) where it
 * resolves (APK provider, API < 34), via the plain runtime-permission request
 * on the framework module (API 34+) — and drives the consent UI with
 * UiAutomator.
 *
 * Idempotent: if [REQUIRED] is already a subset of
 * `permissionController.getGrantedPermissions()` (a previous run granted —
 * grants survive reinstalls of the same package), the UI dance is skipped
 * entirely.
 *
 * The consent flow on the API 34/35 framework module is driven by trying
 * selectors in priority order, re-polling the grant state between rounds:
 *  - "Get started" — OnboardingActivity shown on first contact with HC
 *  - "OK" — dismisses any system dialog overlaying the sheet
 *  - "Allow all" — the master toggle, clicked at most once
 *  - any unchecked toggle — per-type-toggle sheets without a master switch
 *  - scroll down (skipped once the master toggle is on, and bounded — HC's
 *    list keeps reporting scrollable content at the bottom) — more toggles
 *    can hide below the fold
 *  - "Allow" (exact match, so it never hits "Allow all") — bottom-right
 *    confirm; deliberately LAST, after every reachable toggle is on, because
 *    tapping it earlier dismisses the sheet granting only what was toggled
 *  - "Done" — closing button on some flows
 *
 * If the permissions still aren't granted when the deadline lapses, the gate
 * dumps a screenshot (pull with
 * `adb pull /sdcard/Android/data/<test-pkg>/files/tierb-consent-failure.png`)
 * and throws [AssumptionViolatedException] so the suite SKIPS rather than
 * fails — a consent-UI redesign in a future HC build must not read as an
 * engine regression. Manual pre-grant path: install the test APK, open Health
 * Connect → App permissions → allow everything for the test app, re-run.
 */
object HealthPermissionGate {

    private const val TAG = "OmnesisTierB"
    private const val UI_DEADLINE_MS = 90_000L
    private const val POLL_MS = 1_200L

    private val recordTypes = listOf(
        WeightRecord::class,
        StepsRecord::class,
        HeartRateRecord::class,
        SleepSessionRecord::class,
        ActiveCaloriesBurnedRecord::class,
        TotalCaloriesBurnedRecord::class,
        DistanceRecord::class,
        BasalBodyTemperatureRecord::class,
        PowerRecord::class,
        MenstruationFlowRecord::class,
    )

    /** READ+WRITE permission strings for every record type the test seeds. */
    val REQUIRED: Set<String> =
        recordTypes.flatMap {
            listOf(HealthPermission.getReadPermission(it), HealthPermission.getWritePermission(it))
        }.toSet()

    fun ensureGranted(context: Context, client: HealthConnectClient) {
        if (allGranted(client)) {
            Log.i(TAG, "Health permissions already granted; skipping consent UI")
            return
        }

        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        val contract = PermissionController.createRequestPermissionResultContract()

        ActivityScenario.launch(TierBHostActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val intent = contract.createIntent(activity, REQUIRED)
                if (intent.resolveActivity(activity.packageManager) != null) {
                    // APK-provider path (API < 34): the contract yields a real
                    // androidx.health.ACTION_REQUEST_HEALTH_PERMISSIONS intent.
                    @Suppress("DEPRECATION")
                    activity.startActivityForResult(intent, 0xB)
                } else {
                    // Framework-module path (API 34+): health permissions are
                    // platform runtime permissions, and the contract yields the
                    // synthetic ActivityResultContracts.RequestMultiplePermissions
                    // action that only a ComponentActivity's result registry can
                    // dispatch. The plain runtime-permission request launches the
                    // same Health Connect consent UI.
                    activity.requestPermissions(REQUIRED.toTypedArray(), 0xB)
                }
            }
            driveConsentUi(device, client)
        }

        if (!allGranted(client)) {
            val shot = File(context.getExternalFilesDir(null), "tierb-consent-failure.png")
            device.takeScreenshot(shot)
            Log.e(TAG, "Consent UI automation failed; screenshot at ${shot.absolutePath}")
            throw AssumptionViolatedException(
                "Could not grant Health Connect permissions through the consent UI " +
                    "(screenshot: ${shot.absolutePath}). Grant manually in Health Connect " +
                    "(App permissions) and re-run.",
            )
        }
    }

    private fun allGranted(client: HealthConnectClient): Boolean =
        runBlocking { client.permissionController.getGrantedPermissions() }.containsAll(REQUIRED)

    private fun driveConsentUi(device: UiDevice, client: HealthConnectClient) {
        // The consent activity needs a beat to come up before the first probe.
        device.wait(Until.hasObject(By.textContains("Allow")), 5_000L)

        val deadline = SystemClock.elapsedRealtime() + UI_DEADLINE_MS
        var allowAllToggled = false
        var scrollBudget = 6
        while (SystemClock.elapsedRealtime() < deadline) {
            if (allGranted(client)) return

            val acted = when {
                click(device, By.text("Get started")) -> true
                // A system dialog (e.g. a deprecated-targetSdk warning) can sit
                // on top of the sheet and swallow every other tap.
                click(device, By.text("OK")) -> true
                // Click the master toggle at most once — a second click would
                // toggle every permission back OFF.
                !allowAllToggled && click(device, By.text("Allow all")) -> {
                    allowAllToggled = true
                    true
                }
                // Per-type-toggle sheet without a master switch.
                !allowAllToggled && click(device, By.checkable(true).checked(false)) -> true
                // Reveal toggles below the fold — only while the master toggle
                // hasn't already turned everything on, and bounded:
                // UiObject2.scroll keeps reporting more content at the bottom
                // of HC's list, so an unbounded loop would starve the confirm
                // click below.
                !allowAllToggled && scrollBudget > 0 && scrollDown(device) -> {
                    scrollBudget--
                    true
                }
                // Confirm AFTER the toggles — tapping the (pinned-footer)
                // "Allow" while toggles are still off would dismiss the sheet
                // granting only what was toggled.
                click(device, By.text("Allow")) -> true
                click(device, By.text("Done")) -> true
                else -> false
            }
            if (acted) Log.i(TAG, "Consent UI step taken; polling grant state")
            SystemClock.sleep(POLL_MS)
        }
    }

    private fun click(device: UiDevice, selector: BySelector): Boolean {
        val obj = device.findObject(selector) ?: return false
        return try {
            obj.click()
            true
        } catch (e: RuntimeException) {
            // The node can go stale between find and click while the sheet animates.
            false
        }
    }

    private fun scrollDown(device: UiDevice): Boolean {
        val scrollable = device.findObject(By.scrollable(true)) ?: return false
        return try {
            scrollable.scroll(Direction.DOWN, 0.8f)
            true
        } catch (e: RuntimeException) {
            false
        }
    }
}
