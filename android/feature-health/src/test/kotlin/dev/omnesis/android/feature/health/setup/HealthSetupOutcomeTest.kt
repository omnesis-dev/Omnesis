// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health.setup

import androidx.health.connect.client.permission.HealthPermission
import dev.omnesis.android.feature.health.HealthSettings
import dev.omnesis.android.feature.health.InMemoryKeyValueStore
import dev.omnesis.android.feature.health.di.HealthConnectAvailability
import dev.omnesis.android.setup.flow.SetupOutcome
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HealthSetupOutcomeTest {
    private val steps = "fictional.permission.READ_STEPS"
    private val sleep = "fictional.permission.READ_SLEEP"
    private val requested = setOf(steps, sleep)
    private val background = HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND
    private val history = HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY

    private fun outcome(
        granted: Set<String>,
        availability: HealthConnectAvailability = HealthConnectAvailability.Available,
        backgroundSupported: Boolean = true,
        historySupported: Boolean = true,
    ) = healthSetupOutcome(availability, requested, granted, backgroundSupported, historySupported)

    @Test
    fun everythingAllowedIsOn() {
        assertEquals(SetupOutcome.On, outcome(requested + background + history))
    }

    @Test
    fun unsupportedOptionalGrantsAreNotCountedAgainstTheOutcome() {
        assertEquals(SetupOutcome.On, outcome(requested, backgroundSupported = false, historySupported = false))
    }

    @Test
    fun aMissingTypeOrMissingBackgroundOrHistoryIsOnWithLimits() {
        assertEquals(SetupOutcome.Partial, outcome(setOf(steps) + background + history))
        assertEquals(SetupOutcome.Partial, outcome(requested + history))
        assertEquals(SetupOutcome.Partial, outcome(requested + background))
    }

    @Test
    fun noRecordTypeAllowedIsOffEvenWithOptionalGrants() {
        assertEquals(SetupOutcome.NotAllowed, outcome(emptySet()))
        assertEquals(SetupOutcome.NotAllowed, outcome(setOf(background, history)))
    }

    @Test
    fun anUnusableProviderReportsWhyAndHowToFixIt() {
        val notInstalled = outcome(requested, HealthConnectAvailability.NotInstalled) as SetupOutcome.Unavailable
        assertEquals("Health Connect isn't installed", notInstalled.title)
        assertEquals("Install Health Connect", notInstalled.actionLabel)
        val update = outcome(requested, HealthConnectAvailability.UpdateRequired) as SetupOutcome.Unavailable
        assertEquals("Update Health Connect", update.actionLabel)
        assertNull((outcome(requested, HealthConnectAvailability.NotSupported) as SetupOutcome.Unavailable).actionLabel)
        assertNull(healthSetupUnavailable(HealthConnectAvailability.Available))
    }

    @Test
    fun aBriefUpdateRequiredRightAfterInstallIsReadAgainBeforeItIsBelieved() = runTest {
        val answers = ArrayDeque(listOf(HealthConnectAvailability.UpdateRequired, HealthConnectAvailability.Available))
        assertNull(healthAvailabilityAfterInstall({ answers.removeFirst() }))

        val stuck = healthAvailabilityAfterInstall({ HealthConnectAvailability.UpdateRequired })
        assertEquals("Health Connect needs an update", stuck?.title)

        val missing = healthAvailabilityAfterInstall({ HealthConnectAvailability.NotInstalled })
        assertEquals("Health Connect isn't installed", missing?.title)
    }

    @Test
    fun twoEmptyAnswersInARowSendTheNextRequestToSettingsAndAGrantResetsTheCount() {
        val settings = HealthSettings(InMemoryKeyValueStore())
        settings.recordConsentResult(emptySet())
        settings.recordConsentResult(emptySet())
        assertEquals(HEALTH_CONSENT_DISMISSALS_BEFORE_SETTINGS, settings.consentDismissals)
        settings.recordConsentResult(setOf(steps))
        assertEquals(0, settings.consentDismissals)
        settings.recordConsentResult(emptySet())
        settings.reset()
        assertEquals(0, settings.consentDismissals)
    }

    @Test
    fun theDisclosureNamesBackgroundAccess() {
        assertTrue(HealthSetupCopy.disclosure!!.contains("including while the app is closed"))
        assertEquals(listOf("Writing to Health Connect"), HealthSetupCopy.ledger!!.stays)
    }
}
