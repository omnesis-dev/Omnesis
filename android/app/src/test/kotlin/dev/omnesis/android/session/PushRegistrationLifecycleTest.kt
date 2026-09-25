// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.session

import dev.omnesis.android.transport.dto.PushPlan
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PushRegistrationLifecycleTest {
    @Test
    fun `only the typed relay-disabled plan offers consent`() {
        assertTrue(relayConsentRequired(PushPlan("unavailable", reasonCode = "relay-disabled")))
        assertFalse(relayConsentRequired(PushPlan("unavailable", reason = "relay transport is not enabled")))
        assertFalse(relayConsentRequired(PushPlan("unavailable", reasonCode = "relay-url-unavailable")))
        assertFalse(relayConsentRequired(PushPlan("relay", reasonCode = "relay-disabled")))
        assertFalse(relayConsentRequired(PushPlan("direct-fcm")))
    }

    @Test
    fun `a missing FCM token offers relay consent only when this build has Firebase settings`() {
        val relayDisabled = PushPlan("unavailable", reasonCode = "relay-disabled")
        assertFalse(shouldOfferRelayConsentWithoutToken(false, relayDisabled))
        assertFalse(shouldOfferRelayConsentWithoutToken(true, null))
        assertFalse(shouldOfferRelayConsentWithoutToken(true, PushPlan("direct-fcm")))
        assertTrue(shouldOfferRelayConsentWithoutToken(true, relayDisabled))
    }

    @Test
    fun `duplicate queued retries stay dismissed until the next foreground visit`() {
        val deferral = RelayConsentDeferral()
        val identity = "device-example\u001fdev.omnesis.android"

        deferral.beginForegroundVisit()
        deferral.dismiss(identity)
        // Two callbacks queued by the same visit must not reopen the prompt.
        assertFalse(deferral.shouldOffer(identity))
        assertFalse(deferral.shouldOffer(identity))

        deferral.beginForegroundVisit()

        assertTrue(deferral.shouldOffer(identity))
    }

    @Test
    fun `an explicit retry can offer dismissed relay consent again`() {
        val deferral = RelayConsentDeferral()
        val identity = "device-example\u001fdev.example.omnesis"
        deferral.beginForegroundVisit()
        deferral.dismiss(identity)
        assertFalse(deferral.shouldOffer(identity))

        // Settings Retry starts a fresh offer opportunity without leaving the screen.
        deferral.beginForegroundVisit()
        assertTrue(deferral.shouldOffer(identity))
    }

    @Test
    fun `each foreground pass retries registration without sticky failure state`() = runTest {
        val current = Any()
        var credentials = 0
        var plans = 0
        var registrations = 0

        val first = runCatching {
            retryPushRegistrationForSession(
                captured = current,
                isCurrent = { it === current },
                ensureClaimCredential = { credentials += 1 },
                refreshPlan = { plans += 1; PushPlan("direct-fcm") },
                registerCarrierToken = { _, _ ->
                    registrations += 1
                    throw IllegalStateException("fictional transient failure")
                },
            )
        }
        assertEquals(true, first.isFailure)
        assertEquals(1, registrations)

        retryPushRegistrationForSession(
            captured = current,
            isCurrent = { it === current },
            ensureClaimCredential = { credentials += 1 },
            refreshPlan = { plans += 1; PushPlan("direct-fcm") },
            registerCarrierToken = { _, _ -> registrations += 1 },
        )

        assertEquals(2, credentials)
        assertEquals(2, plans)
        assertEquals(2, registrations)
    }

    @Test
    fun `a re-pair between credential and carrier stages suppresses stale registration`() = runTest {
        val captured = Any()
        var current: Any = captured
        var registrations = 0

        retryPushRegistrationForSession(
            captured = captured,
            isCurrent = { it === current },
            ensureClaimCredential = { current = Any() },
            refreshPlan = { PushPlan("direct-fcm") },
            registerCarrierToken = { _, _ -> registrations += 1 },
        )

        assertEquals(0, registrations)
    }

    @Test
    fun `the gateway plan is checked even when carrier registration cannot proceed`() = runTest {
        val current = Any()
        val events = mutableListOf<String>()

        retryPushRegistrationForSession(
            captured = current,
            isCurrent = { it === current },
            ensureClaimCredential = { events += "credential" },
            refreshPlan = { events += "plan"; null },
            registerCarrierToken = { _, _ -> events += "carrier" },
        )

        assertEquals(listOf("credential", "plan"), events)
    }

    @Test
    fun `a re-pair while reading the plan suppresses stale carrier registration`() = runTest {
        val captured = Any()
        var current: Any = captured
        var registrations = 0

        retryPushRegistrationForSession(
            captured = captured,
            isCurrent = { it === current },
            ensureClaimCredential = {},
            refreshPlan = { current = Any(); PushPlan("direct-fcm") },
            registerCarrierToken = { _, _ -> registrations += 1 },
        )

        assertEquals(0, registrations)
    }

    @Test
    fun `a re-pair after relay consent suppresses stale planning and enrollment`() = runTest {
        val captured = Any()
        var current: Any = captured
        var grants = 0
        var registrations = 0

        grantRelayConsentForSession(
            captured = captured,
            isCurrent = { it === current },
            grant = {
                grants += 1
                current = Any()
            },
            replanAndRegister = { registrations += 1 },
        )

        assertEquals(1, grants)
        assertEquals(0, registrations)
    }

    @Test
    fun `relay planning and enrollment continue only after consent is recorded`() = runTest {
        val current = Any()
        val events = mutableListOf<String>()

        grantRelayConsentForSession(
            captured = current,
            isCurrent = { it === current },
            grant = { events += "consent" },
            replanAndRegister = { events += "replan-and-enroll" },
        )

        assertEquals(listOf("consent", "replan-and-enroll"), events)
    }

    @Test
    fun `relay enrollment failure keeps the requesting prompt available for error state`() = runTest {
        val current = Any()
        var promptClears = 0
        var stalePendingClears = 0
        var enrollmentFailed = false

        try {
            beginRelayEnrollmentForSession(
                captured = current,
                isCurrent = { it === current },
                begin = { throw IllegalStateException("fictional enrollment failure") },
                clearCurrentPrompt = { promptClears += 1 },
                clearStalePending = { stalePendingClears += 1 },
            )
        } catch (_: IllegalStateException) {
            enrollmentFailed = true
        }

        assertTrue(enrollmentFailed)
        assertEquals(0, promptClears)
        assertEquals(0, stalePendingClears)
    }

    @Test
    fun `relay enrollment completing for a stale session clears only stale pending state`() = runTest {
        val captured = Any()
        var current: Any = captured
        var promptClears = 0
        var stalePendingClears = 0

        beginRelayEnrollmentForSession(
            captured = captured,
            isCurrent = { it === current },
            begin = { current = Any() },
            clearCurrentPrompt = { promptClears += 1 },
            clearStalePending = { stalePendingClears += 1 },
        )

        assertEquals(0, promptClears)
        assertEquals(1, stalePendingClears)
    }
}
