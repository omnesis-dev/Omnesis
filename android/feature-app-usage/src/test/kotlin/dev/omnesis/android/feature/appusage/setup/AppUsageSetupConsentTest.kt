// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage.setup

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.testing.WorkManagerTestInitHelper
import dev.omnesis.android.feature.appusage.AppUsageIntegration
import dev.omnesis.android.feature.appusage.AppUsageSessionProvider
import dev.omnesis.android.feature.appusage.AppUsageSettings
import dev.omnesis.android.feature.appusage.AppUsageSyncCoordinator
import dev.omnesis.android.feature.appusage.InMemoryKeyValueStore
import dev.omnesis.android.feature.appusage.ui.AppUsageViewModel
import dev.omnesis.android.setup.flow.SetupOutcome
import dev.omnesis.android.transport.MembershipOutbox
import dev.omnesis.android.transport.PermissionHealthCoordinator
import dev.omnesis.android.transport.SourceMembership
import dev.omnesis.android.transport.SourceSyncStatusReader
import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.http.GatewayHttp
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A usage-access grant is not consent. App Usage turns on only when the user
 * agreed on its setup page — never because Settings, a resume, or a fresh
 * pairing found the grant already there — and an agreement the user made
 * completes when the grant appears, even after the page or the whole app was
 * gone in between. All fixture values invented.
 *
 * Each [Phone] is one process: its own holders and step over the persisted
 * store every process in a test shares.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalCoroutinesApi::class)
class AppUsageSetupConsentTest {
    private lateinit var context: Context
    private lateinit var server: MockWebServer
    private val store = InMemoryKeyValueStore()
    private val registrations = AtomicInteger()
    private val collectors = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

    /** Whether Android reports usage access for Omnesis, as the step reads it. */
    @Volatile private var granted = true

    private object Sessions : AppUsageSessionProvider {
        override fun coordinator(): AppUsageSyncCoordinator? = null
        override fun deviceId(): String = DEVICE_ID
    }

    private inner class Phone {
        val settings = AppUsageSettings(store)
        val integration = AppUsageIntegration(context, settings)
        private val admin = AdminClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))
        val membership = SourceMembership(
            admin = { admin },
            deviceId = { DEVICE_ID },
            outbox = MembershipOutbox(read = store::get, write = store::put),
            scope = CoroutineScope(Dispatchers.Unconfined),
            registerAbsentSource = { op, client -> integration.registerForResume(client, op.deviceId) },
        )
        private val permissionHealth = PermissionHealthCoordinator({ emptySet() }, { null }, CoroutineScope(Dispatchers.Unconfined))
        val step = AppUsageSetupStep(
            integration = integration,
            settings = settings,
            sessions = Sessions,
            membership = membership,
            permissionHealth = permissionHealth,
            sessionScopes = { null },
            hasUsageAccess = { granted },
        )

        /** The App Usage Settings card being opened, which reads the grant on the way in. */
        fun openSettings() = AppUsageViewModel(
            settings = settings,
            integration = integration,
            sessions = Sessions,
            permissionHealth = permissionHealth,
            membership = membership,
            syncStatusReader = SourceSyncStatusReader { null },
        )

        fun outcomes(): List<SetupOutcome?> {
            val seen = CopyOnWriteArrayList<SetupOutcome?>()
            collectors.launch { step.outcomes.collect { seen += it } }
            return seen
        }
    }

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        context = ApplicationProvider.getApplicationContext()
        WorkManagerTestInitHelper.initializeTestWorkManager(context)
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.method == "POST" && request.path == "/admin/sources" -> {
                    registrations.incrementAndGet()
                    MockResponse().setBody(
                        """{"source":{"id":"${AppUsageSyncCoordinator.SOURCE_ID}","type":"android-app-usage",""" +
                            """"deviceId":"$DEVICE_ID","multiDeviceMode":"partitioned"}}""",
                    )
                }
                request.method == "GET" && request.path == "/admin/sources" -> MockResponse().setBody("""{"items":[]}""")
                else -> MockResponse().setBody("""{"ok":true}""")
            }
        }
        server.start()
    }

    @After
    fun tearDown() {
        collectors.cancel()
        Dispatchers.resetMain()
        server.shutdown()
    }

    private fun waitFor(what: String, condition: () -> Boolean) = runBlocking {
        runCatching { withTimeout(10_000) { while (!condition()) delay(10) } }
            .onFailure { throw AssertionError("timed out waiting until $what") }
    }

    /** Long enough for an enable, had one started, to reach the gateway and turn the switch on. */
    private fun assertStaysOff(phone: Phone) {
        runBlocking { delay(800) }
        assertFalse("App Usage must stay off", phone.settings.appUsageEnabled)
        assertEquals("the gateway must not hear of App Usage", 0, registrations.get())
    }

    /** The user agreed on the page and was sent to the usage-access screen, which has not answered. */
    private fun agreeWithoutGrant(phone: Phone) {
        granted = false
        phone.step.sequence.start()
        waitFor("the page is asked to open the usage-access screen") { phone.step.sequence.launchRequest.value != null }
        assertTrue(phone.settings.explicitEnablePending)
        assertFalse(phone.settings.appUsageEnabled)
    }

    @Test
    fun notNowWithTheGrantPresentNeverTurnsAppUsageOn() {
        val phone = Phone()
        phone.step.notNow()

        val settingsCard = phone.openSettings()
        assertTrue("the grant is the precondition this test is about", settingsCard.state.value.hasUsageAccess)
        settingsCard.refresh()
        phone.step.resume()
        assertStaysOff(phone)

        val restarted = Phone()
        restarted.openSettings()
        restarted.step.resume()
        assertStaysOff(restarted)
    }

    @Test
    fun unpairingForgetsAnAgreementSoALaterGrantNeverTurnsAppUsageOn() {
        val paired = Phone()
        agreeWithoutGrant(paired)

        paired.integration.forget()
        assertFalse(paired.settings.explicitEnablePending)

        granted = true
        val repaired = Phone()
        val settingsCard = repaired.openSettings()
        assertTrue("the grant is the precondition this test is about", settingsCard.state.value.hasUsageAccess)
        settingsCard.refresh()
        repaired.step.resume()
        assertStaysOff(repaired)
    }

    @Test
    fun agreeingWithTheGrantAlreadyPresentTurnsAppUsageOn() {
        val phone = Phone()
        val outcomes = phone.outcomes()

        phone.step.sequence.start()

        waitFor("the enable reports its outcome") { outcomes.isNotEmpty() }
        assertEquals(listOf<SetupOutcome?>(SetupOutcome.On), outcomes.toList())
        assertTrue(phone.settings.appUsageEnabled)
        assertFalse(phone.settings.explicitEnablePending)
        assertNull("nothing is left to open", phone.step.sequence.launchRequest.value)
        waitFor("the opt-in registers the source") { registrations.get() == 1 }
    }

    @Test
    fun aGrantMadeWhileThePageWasGoneCompletesTheAgreedEnable() {
        val phone = Phone()
        agreeWithoutGrant(phone)
        val outcomes = phone.outcomes()

        // The page that opened the usage-access screen was recreated or left;
        // only the step hears the app come back, with the grant now there.
        granted = true
        phone.step.resume()

        waitFor("the agreed enable completes") { phone.settings.appUsageEnabled }
        waitFor("the enable reports its outcome") { outcomes.isNotEmpty() }
        assertEquals(listOf<SetupOutcome?>(SetupOutcome.On), outcomes.toList())
        assertFalse(phone.settings.explicitEnablePending)
    }

    @Test
    fun aGrantMadeWhileTheAppWasRestartedCompletesTheAgreedEnable() {
        agreeWithoutGrant(Phone())

        granted = true
        val restarted = Phone()
        val outcomes = restarted.outcomes()
        assertFalse(restarted.settings.appUsageEnabled)
        restarted.step.resume()

        waitFor("the agreed enable completes after the restart") { restarted.settings.appUsageEnabled }
        waitFor("the enable reports its outcome") { outcomes.isNotEmpty() }
        assertEquals(listOf<SetupOutcome?>(SetupOutcome.On), outcomes.toList())
        assertFalse(restarted.settings.explicitEnablePending)
    }

    @Test
    fun leavingThePageAfterARestartDropsTheAgreementSoALaterGrantNeverTurnsAppUsageOn() {
        agreeWithoutGrant(Phone())
        val restarted = Phone()
        assertTrue(restarted.settings.explicitEnablePending)

        // System Back or Done with nothing under way.
        restarted.step.sequence.onPageLeft()
        assertFalse(restarted.settings.explicitEnablePending)

        granted = true
        restarted.step.resume()
        assertStaysOff(restarted)
    }

    @Test
    fun leavingThePageWhileTheUsageAccessScreenIsOpenKeepsTheAgreement() {
        val phone = Phone()
        agreeWithoutGrant(phone)
        phone.step.sequence.onPageLeft()
        assertTrue(phone.settings.explicitEnablePending)
    }

    private companion object {
        const val DEVICE_ID = "device-9"
    }
}
