// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health.setup

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.WorkManager
import androidx.work.testing.WorkManagerTestInitHelper
import dev.omnesis.android.feature.health.HealthCategory
import dev.omnesis.android.feature.health.HealthIntegration
import dev.omnesis.android.feature.health.HealthSessionProvider
import dev.omnesis.android.feature.health.HealthSettings
import dev.omnesis.android.feature.health.HealthSyncCoordinator
import dev.omnesis.android.feature.health.HealthSyncScheduler
import dev.omnesis.android.feature.health.InMemoryKeyValueStore
import dev.omnesis.android.feature.health.di.HealthConnectAvailability
import dev.omnesis.android.feature.health.di.HealthConnectStatusReader
import dev.omnesis.android.feature.health.enabledHealthTypePermissions
import dev.omnesis.android.setup.flow.SetupBusy
import dev.omnesis.android.setup.flow.SetupOutcome
import dev.omnesis.android.transport.MembershipOutbox
import dev.omnesis.android.transport.PermissionHealthCoordinator
import dev.omnesis.android.transport.SessionScopeProvider
import dev.omnesis.android.transport.SourceMembership
import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Health Connect setup page's own state and enable: the categories it
 * shows stay the page's until Agree, the consent answer and the permissions
 * round trip lead to the enable, and a resolved outcome is read again from
 * the phone. Fixture values invented.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalCoroutinesApi::class)
class HealthSetupStepTest {
    private lateinit var context: Context
    private lateinit var server: MockWebServer
    private lateinit var store: InMemoryKeyValueStore
    private lateinit var settings: HealthSettings
    private val reader = FakeStatusReader()
    private val outcomes = mutableListOf<SetupOutcome?>()
    private var collector: Job? = null

    private class FakeStatusReader(
        var availability: HealthConnectAvailability = HealthConnectAvailability.Available,
        var granted: Set<String> = emptySet(),
    ) : HealthConnectStatusReader {
        override fun availability(): HealthConnectAvailability = availability

        override suspend fun grantedPermissions(): Set<String> = granted

        override fun featureAvailable(feature: Int): Boolean = true
    }

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        context = ApplicationProvider.getApplicationContext()
        WorkManagerTestInitHelper.initializeTestWorkManager(context)
        server = MockWebServer()
        server.start()
        store = InMemoryKeyValueStore()
        settings = HealthSettings(store)
    }

    @After
    fun tearDown() {
        collector?.cancel()
        Dispatchers.resetMain()
        server.shutdown()
    }

    private fun step(deviceId: String? = null): HealthSetupStep {
        val integration = HealthIntegration(context, settings, reader)
        val sessions = object : HealthSessionProvider {
            override fun coordinator(): HealthSyncCoordinator? = null
            override fun deviceId(): String? = deviceId
        }
        val admin = AdminClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))
        return HealthSetupStep(
            integration = integration,
            settings = settings,
            status = reader,
            sessions = sessions,
            membership = SourceMembership(
                admin = { admin },
                deviceId = sessions::deviceId,
                outbox = MembershipOutbox(read = store::get, write = store::put),
                scope = CoroutineScope(Dispatchers.Unconfined),
                registerAbsentSource = { op, client -> integration.registerForResume(client, op.deviceId) },
            ),
            permissionHealth = PermissionHealthCoordinator(
                reporters = { emptySet() },
                admin = { null },
                scope = CoroutineScope(Dispatchers.Unconfined),
            ),
            sessionScopes = SessionScopeProvider { null },
        ).also { created ->
            collector = CoroutineScope(Dispatchers.Unconfined).launch { created.outcomes.collect { outcomes += it } }
        }
    }

    private fun requestedTypes() = enabledHealthTypePermissions(settings, reader::featureAvailable)

    private fun awaitOutcome() = runBlocking { withTimeout(5_000) { while (outcomes.isEmpty()) delay(10) } }

    private fun scheduledWork() =
        WorkManager.getInstance(context).getWorkInfosForUniqueWork(HealthSyncScheduler.UNIQUE_WORK_NAME).get()

    // ── categories ───────────────────────────────────────────────────

    @Test
    fun chipsChangeThePageSelectionWithoutSavingItUntilAgree() {
        val step = step()

        step.toggleCategory(HealthCategory.SLEEP, false)

        assertEquals(HealthCategory.entries.toSet() - HealthCategory.SLEEP, step.categories)
        assertEquals(HealthCategory.entries.toSet(), HealthSettings(store).enabledCategories)

        step.agree()

        assertEquals(HealthCategory.entries.toSet() - HealthCategory.SLEEP, HealthSettings(store).enabledCategories)
        assertNotNull("Agree asks Health Connect next", step.sequence.launchRequest.value)
        assertFalse(settings.healthConnectEnabled)
    }

    @Test
    fun agreeWithNoCategorySelectedAsksNothingAndSavesNothing() {
        val step = step()
        HealthCategory.entries.forEach { step.toggleCategory(it, false) }

        step.agree()

        assertNull(step.sequence.launchRequest.value)
        assertEquals(HealthCategory.entries.toSet(), HealthSettings(store).enabledCategories)
    }

    @Test
    fun notNowDropsThePageSelection() {
        val step = step()
        step.toggleCategory(HealthCategory.VITALS, false)

        step.notNow()

        assertEquals(HealthCategory.entries.toSet(), step.categories)
    }

    // ── access ───────────────────────────────────────────────────────

    @Test
    fun aConsentAnswerCoveringARequestedTypeTurnsHealthConnectOn() {
        val step = step()
        step.agree()

        // Health Connect holds what the dialog granted by the time its answer arrives.
        reader.granted = requestedTypes()
        step.onConsentAnswer(requestedTypes())
        awaitOutcome()

        assertTrue(settings.hasRequestedPermissions)
        assertEquals(0, settings.consentDismissals)
        assertTrue(settings.healthConnectEnabled)
        assertEquals(1, scheduledWork().size)
        assertEquals(listOf<SetupOutcome?>(SetupOutcome.Partial), outcomes)
    }

    @Test
    fun anEmptyConsentAnswerIsCountedAndLeavesHealthConnectOff() {
        val step = step()
        step.agree()

        step.onConsentAnswer(emptySet())
        awaitOutcome()

        assertEquals(1, settings.consentDismissals)
        assertFalse(settings.healthConnectEnabled)
        assertEquals(listOf<SetupOutcome?>(SetupOutcome.NotAllowed), outcomes)
        assertEquals(SetupBusy.IDLE, step.sequence.busy.value)
    }

    @Test
    fun afterTwoDismissalsAGrantReadFromThePermissionsScreenResetsTheCountAndEnables() {
        settings.recordConsentResult(emptySet())
        settings.recordConsentResult(emptySet())
        val step = step()

        step.agree()
        assertNotNull("the permissions screen opens", step.sequence.launchRequest.value)

        reader.granted = requestedTypes()
        step.resume()
        awaitOutcome()

        assertEquals(0, settings.consentDismissals)
        assertTrue(settings.healthConnectEnabled)
    }

    @Test
    fun theInspectionReachesTheConsentWithoutJoiningOrEnablingLocally() {
        server.enqueue(
            MockResponse().setBody(
                """{"items":[{"id":"health-connect:local","type":"health-connect","deviceId":"device-other","enabled":true,"members":["device-other"],"multiDeviceMode":"exclusive"}]}""",
            ),
        )
        val step = step(deviceId = "device-9")

        runBlocking { step.actions.inspect(null) }

        assertEquals(1, server.requestCount)
        assertFalse(settings.healthConnectEnabled)
        assertTrue(scheduledWork().isEmpty())
    }

    // ── outcome read again ───────────────────────────────────────────

    @Test
    fun anUnavailableOutcomeIsKeptUntilHealthConnectIsAvailableThenUnresolved() = runBlocking {
        reader.availability = HealthConnectAvailability.NotInstalled
        val previous = healthSetupUnavailable(HealthConnectAvailability.NotInstalled)!!
        val step = step()

        assertEquals(previous, step.refreshOutcome(previous))

        reader.availability = HealthConnectAvailability.Available
        assertNull(step.refreshOutcome(previous))
    }

    @Test
    fun anEnabledSourceIsReadAgainFromItsGrantsAndAnOffOneKeepsItsOutcome() = runBlocking {
        settings.healthConnectEnabled = true
        reader.granted = requestedTypes()
        val step = step()

        assertEquals(SetupOutcome.Partial, step.refreshOutcome(SetupOutcome.On))

        settings.healthConnectEnabled = false
        assertEquals(SetupOutcome.NotAllowed, step.refreshOutcome(SetupOutcome.NotAllowed))
    }
}
