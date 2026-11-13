// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.access.AccessAuthorizationPairingIdentity
import dev.omnesis.android.access.AccessPendingRequests
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AccessAuthorizationFilterEditTest {
    private val dispatcher = StandardTestDispatcher()
    private val source = AccessSourceInstance("scope-chat:one", "Cedar account")
    private val folder = ScopeRef("folder", id = "folder-7f3a")
    private val policy = ScopePolicy(source.id, ScopeAudience("new", "answer"), listOf(ScopeRule(listOf(folder), "share")), "hide")
    private val request = AccessAuthorizationRequest("request-example", "approval-example", "pending", "client-example", "Research assistant",
        redirectOrigin = "https://client.example", resource = "https://gateway.example/mcp", scope = "omnesis:access", expiresAt = 2_000_000_000_000, requiresAnswer = false)

    private class FakeGateway(private val request: AccessAuthorizationRequest, private val source: AccessSourceInstance) : AccessAuthorizationGateway {
        var pairingChanged = false
        var editors = 0
        val editor = object : ScopeEditorGateway {
            override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?) =
                ScopeOptions(sourceId, "scope-chat", SourceScopes(emptyList()), emptyList(), emptyList())
            override suspend fun preview(policy: ScopePolicy) = ScopePreview(policy.sourceId, 4, 1, 3, 0,
                policy.rules.flatMap { it.match }.map { ScopePreviewItem(it, "Blueprints", 1) }, emptyList(), emptyList())
        }
        override fun scopeEditor(expectedPairing: AccessAuthorizationPairingIdentity?): ScopeEditorGateway {
            if (pairingChanged) throw AccessAuthorizationPairingChanged()
            editors++
            return editor
        }
        override suspend fun lookup(code: String, expectedPairing: AccessAuthorizationPairingIdentity?) = AccessAuthorizationLookupEnvelope(request)
        override suspend fun lookupById(id: String, expectedPairing: AccessAuthorizationPairingIdentity?) = AccessAuthorizationLookupEnvelope(request)
        override suspend fun overview(expectedPairing: AccessAuthorizationPairingIdentity?) =
            AccessOverview(emptyList(), listOf(source), sourceFilters = SourceFiltersAvailability(true))
        override suspend fun policy(familyId: String, expectedPairing: AccessAuthorizationPairingIdentity?) = PrivacyPolicyDocument(policy = "# Policy", revision = "revision-example")
        override suspend fun decide(id: String, decision: AccessAuthorizationDecision, expectedPairing: AccessAuthorizationPairingIdentity?) = Unit
    }
    private val gateway = FakeGateway(request, source)
    private lateinit var vm: AccessAuthorizationViewModel

    @Before fun setUp() {
        Dispatchers.setMain(dispatcher)
        vm = AccessAuthorizationViewModel(gateway, SourceCatalog(), AccessPendingRequests())
    }
    @After fun tearDown() = Dispatchers.resetMain()

    @Test fun aPairingThatChangedIsReportedInsteadOfOpeningTheEditor() = runTest(dispatcher) {
        vm.lookup("ABCD-EFGH")
        advanceUntilIdle()
        gateway.pairingChanged = true
        vm.editFilter(source, AccessCapability.ANSWER)
        assertNull(vm.state.value.filterEdit)
        assertNull(vm.filterSession)
        assertEquals("The paired gateway changed. Scan the authorization code again.", vm.state.value.actionError)
    }

    @Test fun theOpenFilterIsViewModelStateAndApplyingStoresItOnTheForm() = runTest(dispatcher) {
        vm.lookup("ABCD-EFGH")
        advanceUntilIdle()
        assertNotNull(vm.state.value.form)
        vm.editFilter(source, AccessCapability.ANSWER)
        assertEquals(AccessFilterEdit(source, AccessCapability.ANSWER), vm.state.value.filterEdit)
        val session = requireNotNull(vm.filterSession)
        vm.closeFilter()
        assertNull(vm.state.value.filterEdit)
        vm.editFilter(source, AccessCapability.ANSWER)
        assertSame(session, vm.filterSession)
        vm.applyFilter(policy)
        assertNull(vm.state.value.filterEdit)
        assertEquals(listOf(policy), vm.state.value.form!!.level.rule(AccessCapability.ANSWER)!!.scopePolicies)
        vm.editFilter(source, AccessCapability.ANSWER)
        vm.applyFilter(null)
        assertTrue(vm.state.value.form!!.level.rule(AccessCapability.ANSWER)!!.scopePolicies.isEmpty())
    }

}
