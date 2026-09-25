// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import app.cash.turbine.test
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.DirectAuditEvent
import dev.omnesis.android.transport.dto.DirectAuditEventDetail
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.DirectAuditSession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
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

/**
 * Direct transcript ViewModel flows through a scripted [DirectAuditGateway]:
 * list success/failure, stale-load guards, payload expand-once + retry,
 * delete success/failure, and bus-driven list removal.
 *
 * All fixture ids are invented.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class DirectAuditViewModelTest {

    private class FakeDirectAuditGateway : DirectAuditGateway {
        var sessions: List<DirectAuditSession> = emptyList()
        var sessionsGate: CompletableDeferred<List<DirectAuditSession>>? = null
        var sessionsFailure: Throwable? = null
        var events: List<DirectAuditEvent> = emptyList()
        var eventsFailure: Throwable? = null
        var detail: DirectAuditEventDetail? = null
        var detailFailure: Throwable? = null
        var eventCalls = 0
        var deleteFailure: Throwable? = null
        var deletedSessions = mutableListOf<String>()

        override suspend fun sessions(): List<DirectAuditSession> {
            sessionsGate?.let { return it.await() }
            sessionsFailure?.let { throw it }
            return sessions
        }

        override suspend fun sessionEvents(sessionId: String): List<DirectAuditEvent> {
            eventsFailure?.let { throw it }
            return events
        }

        override suspend fun event(eventId: String): DirectAuditEventDetail {
            eventCalls += 1
            detailFailure?.let { throw it }
            return checkNotNull(detail) { "no detail scripted for $eventId" }
        }

        override suspend fun deleteSession(sessionId: String) {
            deleteFailure?.let { throw it }
            deletedSessions += sessionId
        }
    }

    private fun auditSession(id: String) = DirectAuditSession(
        id = id,
        ownerId = "owner_invented",
        principalId = "principal_invented",
        credentialId = "credential_invented",
        grantId = "grant_invented",
        explicitKey = null,
        heuristicKey = "principal_invented|credential_invented",
        createdAt = 1_700_000_000_000,
        lastEventAt = 1_700_000_060_000,
        eventCount = 1,
    )

    private fun auditEvent(id: String) = DirectAuditEvent(
        sequence = 1,
        id = id,
        sessionId = "direct_session_one",
        tool = "search_many",
        outcome = "ok",
        requestId = "request_invented",
        createdAt = 1_700_000_000_000,
    )

    @Before fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test fun listsSessionsOnStart() {
        val gateway = FakeDirectAuditGateway()
        gateway.sessions = listOf(auditSession("direct_session_one"), auditSession("direct_session_two"))
        val vm = DirectAuditViewModel(gateway, DirectAuditChangeBus())

        val state = vm.state.value
        assertFalse(state.loading)
        assertNull(state.error)
        assertEquals(listOf("direct_session_one", "direct_session_two"), state.sessions.map { it.id })
    }

    @Test fun surfacesListFailures() {
        val gateway = FakeDirectAuditGateway()
        gateway.sessionsFailure = IllegalStateException("gateway is away")
        val vm = DirectAuditViewModel(gateway, DirectAuditChangeBus())

        val state = vm.state.value
        assertFalse(state.loading)
        assertTrue(state.sessions.isEmpty())
        assertNotNull(state.error)
    }

    @Test fun ignoresAStaleListResponse() = runTest {
        val gateway = FakeDirectAuditGateway()
        val gate = CompletableDeferred<List<DirectAuditSession>>()
        gateway.sessionsGate = gate
        val bus = DirectAuditChangeBus()
        val vm = DirectAuditViewModel(gateway, bus)

        gateway.sessionsGate = null
        gateway.sessions = listOf(auditSession("direct_session_new"))
        vm.load()
        gate.complete(listOf(auditSession("direct_session_stale")))

        assertEquals(listOf("direct_session_new"), vm.state.value.sessions.map { it.id })
    }

    @Test fun busDeletionRemovesTheSessionAndReloads() {
        val gateway = FakeDirectAuditGateway()
        gateway.sessions = listOf(auditSession("direct_session_one"), auditSession("direct_session_two"))
        val bus = DirectAuditChangeBus()
        val vm = DirectAuditViewModel(gateway, bus)
        assertEquals(2, vm.state.value.sessions.size)

        gateway.sessions = listOf(auditSession("direct_session_two"))
        bus.notifyDeleted("direct_session_one")

        assertEquals(listOf("direct_session_two"), vm.state.value.sessions.map { it.id })
    }

    @Test fun ensurePayloadLoadsOncePerCall() {
        val gateway = FakeDirectAuditGateway()
        gateway.events = listOf(auditEvent("direct_event_one"))
        gateway.detail = DirectAuditEventDetail(
            id = "direct_event_one",
            payload = buildJsonObject { put("tool", JsonPrimitive("search_many")) },
        )
        val vm = DirectAuditDetailViewModel("direct_session_one", gateway, DirectAuditChangeBus(), SourceCatalog())

        // Rows fire this from composition as they scroll into view; repeats
        // are local, never a second request.
        vm.ensurePayload("direct_event_one")
        assertNotNull(vm.state.value.payloads["direct_event_one"])
        vm.ensurePayload("direct_event_one")
        vm.ensurePayload("direct_event_one")
        assertEquals(1, gateway.eventCalls)
    }

    @Test fun detailResolvesItsSessionForTheHeader() {
        val gateway = FakeDirectAuditGateway()
        gateway.sessions = listOf(auditSession("direct_session_one"), auditSession("direct_session_two"))
        gateway.events = listOf(auditEvent("direct_event_one"))
        val vm = DirectAuditDetailViewModel("direct_session_one", gateway, DirectAuditChangeBus(), SourceCatalog())
        assertEquals("direct_session_one", vm.state.value.session?.id)
        assertEquals(1, vm.state.value.events.size)
    }

    @Test fun detailLoadsEventsWhenSessionsFail() {
        val gateway = FakeDirectAuditGateway()
        gateway.sessionsFailure = IllegalStateException("gateway is away")
        gateway.events = listOf(auditEvent("direct_event_one"))
        val vm = DirectAuditDetailViewModel("direct_session_one", gateway, DirectAuditChangeBus(), SourceCatalog())
        assertNull(vm.state.value.session)
        assertEquals(1, vm.state.value.events.size)
    }

    @Test fun detailUsesTheSharedLoadedCatalogForIcons() {
        val catalog = SourceCatalog()
        val vm = DirectAuditDetailViewModel(
            "direct_session_one",
            FakeDirectAuditGateway(),
            DirectAuditChangeBus(),
            catalog,
        )
        assertTrue(vm.catalog === catalog)
    }

    @Test fun ensurePayloadFailureCanRetry() {
        val gateway = FakeDirectAuditGateway()
        gateway.events = listOf(auditEvent("direct_event_one"))
        gateway.detailFailure = IllegalStateException("gateway is away")
        val vm = DirectAuditDetailViewModel("direct_session_one", gateway, DirectAuditChangeBus(), SourceCatalog())

        vm.ensurePayload("direct_event_one")
        assertNotNull(vm.state.value.payloadErrors["direct_event_one"])

        gateway.detailFailure = null
        gateway.detail = DirectAuditEventDetail(id = "direct_event_one")
        vm.retryEvent("direct_event_one")
        assertNull(vm.state.value.payloadErrors["direct_event_one"])
        assertTrue(vm.state.value.payloads.containsKey("direct_event_one"))
    }

    @Test fun deleteSessionNotifiesTheBus() = runTest {
        val gateway = FakeDirectAuditGateway()
        gateway.events = listOf(auditEvent("direct_event_one"))
        val bus = DirectAuditChangeBus()
        val vm = DirectAuditDetailViewModel("direct_session_one", gateway, bus, SourceCatalog())

        bus.deleted.test {
            vm.deleteSession()
            assertEquals("direct_session_one", awaitItem())
        }
        assertTrue(vm.state.value.deleted)
        assertEquals(listOf("direct_session_one"), gateway.deletedSessions)
    }

    @Test fun remoteDeletionNavigatesAwayFromStaleDetail() {
        val gateway = FakeDirectAuditGateway()
        gateway.events = listOf(auditEvent("direct_event_one"))
        val bus = DirectAuditChangeBus()
        val vm = DirectAuditDetailViewModel("direct_session_one", gateway, bus, SourceCatalog())
        assertFalse(vm.state.value.deleted)

        bus.notifyDeleted("direct_session_other")
        assertFalse(vm.state.value.deleted)

        bus.notifyDeleted("direct_session_one")
        assertTrue(vm.state.value.deleted)
    }

    @Test fun deleteSessionFailureSurfacesAnActionError() {
        val gateway = FakeDirectAuditGateway()
        gateway.events = listOf(auditEvent("direct_event_one"))
        gateway.deleteFailure = IllegalStateException("gateway is away")
        val vm = DirectAuditDetailViewModel("direct_session_one", gateway, DirectAuditChangeBus(), SourceCatalog())

        vm.deleteSession()

        val state = vm.state.value
        assertFalse(state.deleted)
        assertFalse(state.deleting)
        assertNotNull(state.actionError)
        assertTrue(gateway.deletedSessions.isEmpty())
    }

    @Test fun oldGatewayMarksTheListUnavailableInsteadOfFailing() {
        val gateway = FakeDirectAuditGateway()
        gateway.sessionsFailure = GatewayException.NotFound()
        val vm = DirectAuditViewModel(gateway, DirectAuditChangeBus())

        val state = vm.state.value
        assertFalse(state.loading)
        assertTrue(state.unavailable)
        assertNull(state.error)
        assertTrue(state.sessions.isEmpty())
    }

    @Test fun oldGatewayMarksTheDetailUnavailableInsteadOfFailing() {
        val gateway = FakeDirectAuditGateway()
        gateway.eventsFailure = GatewayException.NotFound()
        val vm = DirectAuditDetailViewModel("direct_session_one", gateway, DirectAuditChangeBus(), SourceCatalog())

        vm.load()

        val state = vm.state.value
        assertFalse(state.loading)
        assertTrue(state.unavailable)
        assertNull(state.error)
    }

    @Test fun deleteThatMissesCountsAsDeleted() {
        val gateway = FakeDirectAuditGateway()
        gateway.events = listOf(auditEvent("direct_event_one"))
        gateway.deleteFailure = GatewayException.NotFound()
        val bus = DirectAuditChangeBus()
        val vm = DirectAuditDetailViewModel("direct_session_one", gateway, bus, SourceCatalog())

        vm.deleteSession()

        assertTrue(vm.state.value.deleted)
    }

    @Test fun vanishedEventIsATerminalPayloadError() {
        val gateway = FakeDirectAuditGateway()
        gateway.events = listOf(auditEvent("direct_event_one"))
        gateway.detailFailure = GatewayException.NotFound()
        val vm = DirectAuditDetailViewModel("direct_session_one", gateway, DirectAuditChangeBus(), SourceCatalog())

        vm.ensurePayload("direct_event_one")

        val state = vm.state.value
        assertEquals("This call is no longer on the gateway.", state.payloadErrors["direct_event_one"])
        assertTrue(state.payloadTerminal.contains("direct_event_one"))
    }

    @Test fun retryEventClearsTerminalState() {
        val gateway = FakeDirectAuditGateway()
        gateway.events = listOf(auditEvent("direct_event_one"))
        gateway.detailFailure = GatewayException.NotFound()
        val vm = DirectAuditDetailViewModel("direct_session_one", gateway, DirectAuditChangeBus(), SourceCatalog())

        vm.ensurePayload("direct_event_one")
        assertTrue(vm.state.value.payloadTerminal.contains("direct_event_one"))

        gateway.detailFailure = null
        gateway.detail = DirectAuditEventDetail(id = "direct_event_one")
        vm.retryEvent("direct_event_one")
        assertFalse(vm.state.value.payloadTerminal.contains("direct_event_one"))
        assertTrue(vm.state.value.payloads.containsKey("direct_event_one"))
    }

    @Test fun successfulReloadClearsUnavailable() {
        val gateway = FakeDirectAuditGateway()
        gateway.eventsFailure = GatewayException.NotFound()
        val vm = DirectAuditDetailViewModel("direct_session_one", gateway, DirectAuditChangeBus(), SourceCatalog())

        vm.load()
        assertTrue(vm.state.value.unavailable)

        gateway.eventsFailure = null
        gateway.events = listOf(auditEvent("direct_event_one"))
        vm.load()
        val state = vm.state.value
        assertFalse(state.unavailable)
        assertEquals(1, state.events.size)
    }

    @Test fun failedPayloadStaysRetryable() {
        val gateway = FakeDirectAuditGateway()
        gateway.events = listOf(auditEvent("direct_event_one"))
        gateway.detailFailure = IllegalStateException("gateway is away")
        val vm = DirectAuditDetailViewModel("direct_session_one", gateway, DirectAuditChangeBus(), SourceCatalog())

        vm.ensurePayload("direct_event_one")

        val state = vm.state.value
        assertNotNull(state.payloadErrors["direct_event_one"])
        assertFalse(state.payloadTerminal.contains("direct_event_one"))
    }
}
