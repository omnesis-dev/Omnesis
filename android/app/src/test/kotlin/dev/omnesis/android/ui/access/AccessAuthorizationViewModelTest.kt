// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.access

import dev.omnesis.android.access.AccessAuthorizationPairingIdentity
import dev.omnesis.android.access.AccessPendingRequests
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.AccessAnswerRelease
import dev.omnesis.android.transport.dto.AccessAuthorizationDecision
import dev.omnesis.android.transport.dto.AccessAuthorizationLookupEnvelope
import dev.omnesis.android.transport.dto.AccessAuthorizationRequest
import dev.omnesis.android.transport.dto.AccessAuthorizationSelection
import dev.omnesis.android.transport.dto.AccessConnectionLevel
import dev.omnesis.android.transport.dto.AccessConnectionMatch
import dev.omnesis.android.transport.dto.AccessConnectionProposal
import dev.omnesis.android.transport.dto.AccessCredentialSummary
import dev.omnesis.android.transport.dto.AccessGrantRule
import dev.omnesis.android.transport.dto.AccessGrantSummary
import dev.omnesis.android.transport.dto.AccessLevelSummary
import dev.omnesis.android.transport.dto.AccessOverview
import dev.omnesis.android.transport.dto.AccessPendingRequest
import dev.omnesis.android.transport.dto.AccessPolicyFamilySummary
import dev.omnesis.android.transport.dto.AccessPrincipalSummary
import dev.omnesis.android.transport.dto.AccessReconnectPrincipal
import dev.omnesis.android.transport.dto.AccessReconnectProposal
import dev.omnesis.android.transport.dto.AccessSourceBoundary
import dev.omnesis.android.transport.dto.AccessSourceInstance
import dev.omnesis.android.transport.dto.AccessSourceMode
import dev.omnesis.android.transport.dto.PrivacyPolicyDocument
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import java.io.IOException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AccessAuthorizationViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private lateinit var gateway: FakeGateway
    private lateinit var pendingRequests: AccessPendingRequests
    private lateinit var vm: AccessAuthorizationViewModel

    @Before fun setUp() {
        Dispatchers.setMain(dispatcher)
        gateway = FakeGateway { overview() }
        pendingRequests = AccessPendingRequests()
        vm = AccessAuthorizationViewModel(gateway, SourceCatalog(), pendingRequests)
    }

    @After fun tearDown() = Dispatchers.resetMain()

    @Test fun newer_lookup_cancels_the_older_request_and_wins() = runTest(dispatcher) {
        val first = CompletableDeferred<AccessAuthorizationLookupEnvelope>()
        var firstCancelled = false
        var calls = 0
        gateway.lookupBlock = { code ->
            calls++
            if (code == "FIRST") {
                try {
                    first.await()
                } finally {
                    firstCancelled = !currentCoroutineContext().isActive
                }
            } else envelope(request(clientName = "Second agent"))
        }
        vm.lookup("first")
        runCurrent()
        vm.lookup("second")
        advanceUntilIdle()
        assertTrue(firstCancelled)
        assertEquals(2, calls)
        assertEquals("Second agent", vm.state.value.request?.clientName)
    }

    @Test fun duplicate_approval_and_denial_submissions_are_dropped() = runTest(dispatcher) {
        loadReady()
        val gate = CompletableDeferred<Unit>()
        gateway.decideBlock = { _, _ -> gateway.decisionCalls++; gate.await() }
        val selection = validSelection()
        vm.decide(true, selection)
        vm.decide(true, selection)
        vm.decide(false)
        runCurrent()
        assertEquals(1, gateway.decisionCalls)
        gate.complete(Unit)
        advanceUntilIdle()
        assertEquals(AccessAuthorizationCompletion.APPROVED, vm.state.value.completion)
    }

    @Test fun stale_selection_refreshes_authority_and_resets_the_wizard() = runTest(dispatcher) {
        loadReady()
        val refreshed = overview(sourceName = "Renamed Notes")
        gateway.overviewBlock = { refreshed }
        gateway.decideBlock = { _, _ -> throw GatewayException.ServerError(409, "invalid-selection") }
        vm.goTo(AccessAuthorizationStep.REVIEW)
        vm.decide(true, validSelection())
        advanceUntilIdle()
        assertEquals("Renamed Notes", vm.state.value.overview?.sources?.single()?.name)
        assertEquals(AccessAuthorizationStep.PERMISSIONS, vm.state.value.step)
        assertEquals(2L, vm.state.value.revision)
        assertTrue(vm.state.value.actionError!!.contains("refreshed"))
    }

    @Test fun stale_refresh_failure_returns_to_code_entry_with_an_actionable_error() = runTest(dispatcher) {
        loadReady()
        gateway.decideBlock = { _, _ -> throw GatewayException.ServerError(409, "inactive-grant") }
        gateway.overviewBlock = { error("offline") }
        vm.decide(true, validSelection())
        advanceUntilIdle()
        assertNull(vm.state.value.request)
        assertFalse(vm.state.value.deciding)
        assertTrue(vm.state.value.lookupError!!.contains("Enter the code again"))
    }

    @Test fun ambiguous_post_commit_network_failure_is_reconciled_as_approved() = runTest(dispatcher) {
        loadReady()
        gateway.lookupBlock = { envelope(request(status = "approved")) }
        gateway.decideBlock = { _, _ ->
            gateway.decisionCalls++
            throw GatewayException.Network(IOException("response lost"))
        }
        vm.decide(true, validSelection())
        advanceUntilIdle()
        assertEquals(AccessAuthorizationCompletion.APPROVED, vm.state.value.completion)
        assertNull(vm.state.value.actionError)
        assertEquals(1, gateway.decisionCalls)
    }

    @Test fun a_confirmed_denial_stays_visible_until_the_user_dismisses_it() = runTest(dispatcher) {
        loadReady()
        vm.decide(false)
        advanceUntilIdle()
        assertEquals(AccessAuthorizationCompletion.DENIED, vm.state.value.completion)
        assertFalse(vm.state.value.deciding)
    }

    @Test fun already_decided_is_reconciled_before_claiming_success() = runTest(dispatcher) {
        loadReady()
        gateway.lookupBlock = { envelope(request(status = "approved")) }
        gateway.decideBlock = { _, _ -> throw GatewayException.ServerError(409, "already-decided") }
        vm.decide(true, validSelection())
        advanceUntilIdle()
        assertEquals(AccessAuthorizationCompletion.APPROVED, vm.state.value.completion)
    }

    @Test fun a_concurrent_denial_is_not_reported_as_approval() = runTest(dispatcher) {
        loadReady()
        gateway.lookupBlock = { envelope(request(status = "denied")) }
        gateway.decideBlock = { _, _ -> throw GatewayException.ServerError(409, "already-decided") }
        vm.decide(true, validSelection())
        advanceUntilIdle()
        assertEquals(AccessAuthorizationCompletion.DENIED, vm.state.value.completion)
    }

    @Test fun a_failure_while_the_request_is_pending_remains_an_error() = runTest(dispatcher) {
        loadReady()
        gateway.decideBlock = { _, _ -> throw GatewayException.Network(IOException("offline")) }
        vm.decide(true, validSelection())
        advanceUntilIdle()
        assertNull(vm.state.value.completion)
        assertTrue(vm.state.value.actionError!!.contains("Could not reach your Omnesis gateway"))
    }

    @Test fun reconciliation_never_accepts_a_different_request() = runTest(dispatcher) {
        loadReady()
        gateway.lookupBlock = { envelope(request(status = "approved").copy(id = "different_request")) }
        gateway.decideBlock = { _, _ -> throw GatewayException.Network(IOException("response lost")) }
        vm.decide(true, validSelection())
        advanceUntilIdle()
        assertNull(vm.state.value.completion)
        assertTrue(vm.state.value.actionError!!.contains("Could not reach your Omnesis gateway"))
    }

    @Test fun decision_cancellation_is_not_converted_into_a_user_error() = runTest(dispatcher) {
        loadReady()
        gateway.decideBlock = { _, _ -> throw CancellationException("screen closed") }
        vm.decide(true, validSelection())
        advanceUntilIdle()
        assertTrue(vm.state.value.deciding)
        assertNull(vm.state.value.actionError)
        assertNull(vm.state.value.completion)
    }

    @Test fun retained_non_pending_lookup_never_enters_the_wizard() = runTest(dispatcher) {
        gateway.lookupBlock = { envelope(request(status = "expired")) }
        vm.lookup("abcd-efgh")
        advanceUntilIdle()
        assertNull(vm.state.value.request)
        assertTrue(vm.state.value.lookupError!!.contains("expired"))
        assertEquals(0, gateway.overviewCalls)
    }

    @Test fun pending_but_past_deadline_never_enters_the_wizard() = runTest(dispatcher) {
        gateway.lookupBlock = { envelope(request().copy(expiresAt = 1)) }
        vm.lookup("abcd-efgh")
        advanceUntilIdle()
        assertNull(vm.state.value.request)
        assertTrue(vm.state.value.lookupError!!.contains("expired"))
        assertEquals(0, gateway.overviewCalls)
    }

    @Test fun revoked_pairing_has_repair_guidance() = runTest(dispatcher) {
        gateway.lookupBlock = { throw GatewayException.Unauthorized() }
        vm.lookup("abcd-efgh")
        advanceUntilIdle()
        assertTrue(vm.state.value.lookupError!!.contains("Re-pair"))
    }

    @Test fun invalid_approval_values_have_actionable_guidance() = runTest(dispatcher) {
        loadReady()
        gateway.decideBlock = { _, _ -> throw GatewayException.ServerError(400, "invalid-input") }

        vm.decide(true, validSelection())
        advanceUntilIdle()

        assertTrue(vm.state.value.actionError!!.contains("source selections"))
    }

    @Test fun code_not_found_on_the_paired_gateway_stays_in_manual_entry() = runTest(dispatcher) {
        var lookedUpCode: String? = null
        gateway.lookupBlock = { code ->
            lookedUpCode = code
            throw GatewayException.NotFound()
        }

        vm.lookup("ABCD-EFGH")
        advanceUntilIdle()

        assertEquals("ABCD-EFGH", lookedUpCode)
        assertNull(vm.state.value.request)
        assertTrue(vm.state.value.lookupError!!.contains("No pending authorization"))
        assertEquals(0, gateway.overviewCalls)
    }

    @Test fun scanned_code_stays_visible_after_lookup_failure() = runTest(dispatcher) {
        gateway.lookupBlock = { throw GatewayException.NotFound() }

        vm.lookupInitial("ABCD-EFGH", 17L, pairingIdentity())
        advanceUntilIdle()

        assertEquals("ABCD-EFGH", vm.state.value.code)
        assertTrue(vm.state.value.lookupError!!.contains("No pending authorization"))
    }

    @Test fun a_lookup_makes_sure_the_source_catalog_is_loaded() = runTest(dispatcher) {
        // The wizard's source list draws icons from the catalog; a session whose
        // own fetch failed must not leave the wizard drawing initials.
        vm.lookupInitial("ABCD-EFGH", 17L, pairingIdentity())
        advanceUntilIdle()

        assertEquals(1, gateway.catalogLoads)
        assertNotNull(vm.state.value.request)
    }

    @Test fun scanned_code_stays_visible_after_network_failure() = runTest(dispatcher) {
        gateway.lookupBlock = { throw GatewayException.Network(IOException("offline")) }

        vm.lookupInitial("ABCD-EFGH", 17L, pairingIdentity())
        advanceUntilIdle()

        assertEquals("ABCD-EFGH", vm.state.value.code)
        assertTrue(vm.state.value.lookupError!!.contains("Could not reach your Omnesis gateway"))
    }

    @Test fun retrying_unchanged_scanned_code_after_re_pair_stays_bound_and_fails_closed() = runTest(dispatcher) {
        gateway.lookupBlock = { throw GatewayException.Network(IOException("offline")) }
        val expectedPairing = pairingIdentity()
        vm.lookupInitial("ABCD-EFGH", 17L, expectedPairing)
        advanceUntilIdle()
        gateway.pairingChanged = true

        vm.lookup()
        advanceUntilIdle()

        assertEquals(listOf(expectedPairing, expectedPairing), gateway.lookupPairings)
        assertNull(vm.state.value.request)
        assertTrue(vm.state.value.lookupError!!.contains("paired gateway changed"))
    }

    @Test fun same_launch_nonce_is_one_shot_and_preserves_in_progress_form() = runTest(dispatcher) {
        vm.lookupInitial("ABCD-EFGH", 17L, pairingIdentity())
        advanceUntilIdle()
        val edited = requireNotNull(vm.state.value.form).copy(notesEnabled = true)
        vm.updateForm(edited)
        vm.goTo(AccessAuthorizationStep.REVIEW)

        vm.lookupInitial("ABCD-EFGH", 17L, pairingIdentity())
        advanceUntilIdle()

        assertEquals(1, gateway.lookupCalls)
        assertTrue(requireNotNull(vm.state.value.form).notesEnabled)
        assertEquals(AccessAuthorizationStep.REVIEW, vm.state.value.step)
    }

    @Test fun recreated_view_model_relooks_up_the_navigation_code_and_a_new_nonce_runs() = runTest(dispatcher) {
        vm.lookupInitial("ABCD-EFGH", 17L, pairingIdentity())
        advanceUntilIdle()

        vm = AccessAuthorizationViewModel(gateway, SourceCatalog(), pendingRequests)
        vm.lookupInitial("ABCD-EFGH", 17L, pairingIdentity())
        advanceUntilIdle()
        assertEquals(2, gateway.lookupCalls)

        vm.lookupInitial("JKLM-NPQR", 18L, pairingIdentity())
        advanceUntilIdle()
        assertEquals(3, gateway.lookupCalls)
        assertEquals("JKLM-NPQR", vm.state.value.code)
    }

    @Test fun re_pair_between_scanned_lookup_and_overview_fails_closed() = runTest(dispatcher) {
        gateway.lookupBlock = {
            gateway.pairingChanged = true
            envelope(request())
        }

        vm.lookupInitial("ABCD-EFGH", 17L, pairingIdentity())
        advanceUntilIdle()

        assertNull(vm.state.value.request)
        assertNull(vm.state.value.overview)
        assertTrue(vm.state.value.lookupError!!.contains("paired gateway changed"))
    }

    @Test fun re_pair_before_scanned_decision_prevents_submission_and_reconciliation() = runTest(dispatcher) {
        vm.lookupInitial("ABCD-EFGH", 17L, pairingIdentity())
        advanceUntilIdle()
        selectAllowedSource()
        gateway.pairingChanged = true

        vm.decide(true, validSelection())
        advanceUntilIdle()

        assertEquals(0, gateway.decisionCalls)
        assertNull(vm.state.value.completion)
        assertTrue(vm.state.value.actionError!!.contains("paired gateway changed"))
    }

    @Test fun re_pair_after_scanned_decision_failure_prevents_cross_gateway_reconciliation() = runTest(dispatcher) {
        vm.lookupInitial("ABCD-EFGH", 17L, pairingIdentity())
        advanceUntilIdle()
        selectAllowedSource()
        gateway.decideBlock = { _, _ ->
            gateway.decisionCalls++
            gateway.pairingChanged = true
            throw GatewayException.Network(IOException("response lost"))
        }

        vm.decide(true, validSelection())
        advanceUntilIdle()

        assertEquals(1, gateway.decisionCalls)
        assertEquals(2, gateway.lookupCalls)
        assertNull(vm.state.value.completion)
        assertTrue(vm.state.value.actionError!!.contains("Could not reach your Omnesis gateway"))
    }

    @Test fun a_chosen_policy_can_be_read_without_leaving_the_wizard() = runTest(dispatcher) {
        loadReady()
        val gate = CompletableDeferred<Unit>()
        gateway.policyBlock = { familyId ->
            gate.await()
            PrivacyPolicyDocument(policy = "# Policy $familyId", revision = "revision-example")
        }
        vm.showPolicy("policy_example")
        runCurrent()
        // The family's name is known from the overview, so the sheet is titled while the text
        // is still on the wire rather than opening blank.
        assertTrue(requireNotNull(vm.state.value.policyPreview).loading)
        assertEquals("Everyday", vm.state.value.policyPreview?.name)
        gate.complete(Unit)
        advanceUntilIdle()
        val preview = requireNotNull(vm.state.value.policyPreview)
        assertFalse(preview.loading)
        assertEquals("# Policy policy_example", preview.document?.policy)
        assertEquals(listOf("policy_example"), gateway.policyFamilyIds)
        assertNull(preview.error)

        vm.dismissPolicy()
        assertNull(vm.state.value.policyPreview)
    }

    @Test fun an_unreadable_policy_reports_itself_rather_than_showing_an_empty_document() =
        runTest(dispatcher) {
            loadReady()
            gateway.policyBlock = { throw GatewayException.NotFound() }
            vm.showPolicy("policy_example")
            advanceUntilIdle()
            val preview = requireNotNull(vm.state.value.policyPreview)
            assertFalse(preview.loading)
            assertNull(preview.document)
            assertTrue(requireNotNull(preview.error).contains("no longer published"))
        }

    @Test fun a_dismissed_policy_is_not_repopulated_by_its_own_late_reply() = runTest(dispatcher) {
        loadReady()
        val gate = CompletableDeferred<Unit>()
        gateway.policyBlock = { familyId ->
            gate.await()
            PrivacyPolicyDocument(policy = "# Policy $familyId")
        }
        vm.showPolicy("policy_example")
        runCurrent()
        vm.dismissPolicy()
        gate.complete(Unit)
        advanceUntilIdle()
        assertNull(vm.state.value.policyPreview)
    }

    /* ── A gateway that proposes connections ── */

    @Test fun a_gateway_that_proposes_connections_opens_on_the_connection_step() = runTest(dispatcher) {
        gateway.overviewBlock = { connectionOverview() }
        gateway.lookupBlock = { connectionEnvelope(proposal()) }
        vm.lookup("abcd-efgh")
        advanceUntilIdle()

        val state = vm.state.value
        assertEquals(AccessAuthorizationStep.CONNECTION, state.step)
        val choice = requireNotNull(state.form?.connection)
        assertEquals(AccessConnectionPath.NEW_LEVEL, choice.path)
        assertEquals("Example agent 2", choice.name)
        assertEquals("Example reading", choice.levelName)
    }

    @Test fun approving_a_new_level_sends_the_connection_and_level_names_with_the_form_rules() = runTest(dispatcher) {
        gateway.overviewBlock = { connectionOverview() }
        gateway.lookupBlock = { connectionEnvelope(proposal()) }
        var sent: AccessAuthorizationDecision? = null
        gateway.decideBlock = { _, decision -> sent = decision }
        loadReady()
        val form = requireNotNull(vm.state.value.form)
        vm.updateForm(form.copy(connection = form.connection?.copy(name = " Desk agent ", levelName = "Desk reading")))

        vm.decide(true, validSelection())
        advanceUntilIdle()

        assertEquals(
            AccessAuthorizationSelection.NewConnection(
                "Desk agent",
                AccessConnectionLevel.New(
                    "Desk reading",
                    listOf(
                        AccessGrantRule.answer(
                            AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("notes:fictional")),
                            AccessAnswerRelease.reviewed("policy_example"),
                        ),
                    ),
                ),
            ),
            (sent as AccessAuthorizationDecision.Approve).selection,
        )
        assertEquals(AccessAuthorizationCompletion.APPROVED, vm.state.value.completion)
    }

    @Test fun approving_an_existing_level_sends_it_at_the_revision_reviewed() = runTest(dispatcher) {
        gateway.overviewBlock = { connectionOverview() }
        gateway.lookupBlock = { connectionEnvelope(proposal("existing-level", connectionMatch())) }
        var sent: AccessAuthorizationDecision? = null
        gateway.decideBlock = { _, decision -> sent = decision }
        vm.lookup("abcd-efgh")
        advanceUntilIdle()

        vm.decide(true, validSelection())
        advanceUntilIdle()

        assertEquals(
            AccessAuthorizationSelection.NewConnection("Example agent 2", AccessConnectionLevel.Existing("level_example", 3)),
            (sent as AccessAuthorizationDecision.Approve).selection,
        )
    }

    @Test fun approving_a_replacement_sends_the_connection_at_its_grant_revision() = runTest(dispatcher) {
        gateway.overviewBlock = { connectionOverview() }
        gateway.lookupBlock = { connectionEnvelope(proposal("replace", connectionMatch(matchedBy = "device"))) }
        var sent: AccessAuthorizationDecision? = null
        gateway.decideBlock = { _, decision -> sent = decision }
        vm.lookup("abcd-efgh")
        advanceUntilIdle()
        assertTrue(requireNotNull(vm.state.value.form?.connection).replacing)

        vm.decide(true, validSelection())
        advanceUntilIdle()

        assertEquals(
            AccessAuthorizationSelection.ReplaceConnection("principal_example", 4),
            (sent as AccessAuthorizationDecision.Approve).selection,
        )
    }

    @Test fun a_taken_level_name_returns_to_the_connection_step_keeping_every_answer() = runTest(dispatcher) {
        gateway.overviewBlock = { connectionOverview() }
        gateway.lookupBlock = { connectionEnvelope(proposal()) }
        loadReady()
        vm.goTo(AccessAuthorizationStep.REVIEW)
        val answered = vm.state.value.form
        gateway.decideBlock = { _, _ -> throw GatewayException.ServerError(409, "level-name-taken") }

        vm.decide(true, validSelection())
        advanceUntilIdle()

        val state = vm.state.value
        assertEquals(AccessAuthorizationStep.CONNECTION, state.step)
        assertEquals("An access level with that name already exists.", state.actionError)
        assertFalse(state.deciding)
        assertNull(state.completion)
        assertEquals(answered, state.form)
        assertTrue(state.levelNameTaken)
        // Nothing the choices were built on changed, so they are not reloaded.
        assertEquals(1, gateway.overviewCalls)
    }

    @Test fun editing_the_taken_level_name_clears_the_refusal() = runTest(dispatcher) {
        gateway.overviewBlock = { connectionOverview() }
        gateway.lookupBlock = { connectionEnvelope(proposal()) }
        loadReady()
        gateway.decideBlock = { _, _ -> throw GatewayException.ServerError(409, "level-name-taken") }
        vm.decide(true, validSelection())
        advanceUntilIdle()

        // Other answers leave the refusal in place.
        val refused = requireNotNull(vm.state.value.form)
        vm.updateForm(refused.copy(connection = refused.connection?.copy(name = "Desk agent")))
        assertTrue(vm.state.value.levelNameTaken)
        assertEquals("An access level with that name already exists.", vm.state.value.actionError)

        val renamed = requireNotNull(vm.state.value.form)
        vm.updateForm(renamed.copy(connection = renamed.connection?.copy(levelName = "Desk reading")))
        assertFalse(vm.state.value.levelNameTaken)
        assertNull(vm.state.value.actionError)
        assertEquals("Desk reading", vm.state.value.form?.connection?.levelName)
    }

    @Test fun a_level_name_already_in_the_overview_is_never_sent() = runTest(dispatcher) {
        gateway.overviewBlock = { connectionOverview() }
        gateway.lookupBlock = { connectionEnvelope(proposal()) }
        loadReady()
        val form = requireNotNull(vm.state.value.form)
        vm.updateForm(form.copy(connection = form.connection?.copy(levelName = " research")))

        val state = vm.state.value
        val choice = requireNotNull(state.form?.connection)
        assertEquals(
            "An access level with that name already exists.",
            choice.levelNameError(requireNotNull(state.overview)),
        )
        assertNull(state.form?.selection(requireNotNull(state.request), requireNotNull(state.overview)))
        // Refused on the phone, not by the gateway: nothing was sent and no refusal is on top.
        gateway.decideBlock = { _, _ -> gateway.decisionCalls++ }
        vm.decide(true, null)
        advanceUntilIdle()
        assertEquals(0, gateway.decisionCalls)
        assertFalse(vm.state.value.levelNameTaken)
        assertNull(vm.state.value.actionError)
    }

    @Test fun a_stale_level_revision_reloads_the_choices_and_returns_to_the_connection_step() = runTest(dispatcher) {
        gateway.overviewBlock = { connectionOverview(levelRevision = 3) }
        gateway.lookupBlock = { connectionEnvelope(proposal("existing-level", connectionMatch())) }
        vm.lookup("abcd-efgh")
        advanceUntilIdle()
        vm.goTo(AccessAuthorizationStep.REVIEW)
        gateway.overviewBlock = { connectionOverview(levelRevision = 4) }
        gateway.decideBlock = { _, _ -> throw GatewayException.ServerError(409, "stale-revision") }

        vm.decide(true, validSelection())
        advanceUntilIdle()

        val state = vm.state.value
        assertEquals(AccessAuthorizationStep.CONNECTION, state.step)
        assertEquals("Access choices changed. Review the refreshed request.", state.actionError)
        assertEquals(2, gateway.overviewCalls)
        assertEquals(
            AccessAuthorizationSelection.NewConnection("Example agent 2", AccessConnectionLevel.Existing("level_example", 4)),
            validSelection(),
        )
    }

    @Test fun a_stale_refusal_keeps_the_typed_names_on_the_same_path_and_resets_the_permissions() = runTest(dispatcher) {
        gateway.overviewBlock = { connectionOverview(levelRevision = 3) }
        gateway.lookupBlock = { connectionEnvelope(proposal("existing-level", connectionMatch())) }
        vm.lookup("abcd-efgh")
        advanceUntilIdle()
        val opened = requireNotNull(vm.state.value.form)
        vm.updateForm(
            opened.copy(
                notesEnabled = true,
                connection = opened.connection?.copy(name = "Desk agent", levelName = "Desk reading"),
            ),
        )
        gateway.overviewBlock = { connectionOverview(levelRevision = 4) }
        gateway.decideBlock = { _, _ -> throw GatewayException.ServerError(409, "stale-revision") }

        vm.decide(true, validSelection())
        advanceUntilIdle()

        val form = requireNotNull(vm.state.value.form)
        val choice = requireNotNull(form.connection)
        assertEquals(AccessConnectionPath.EXISTING_LEVEL, choice.path)
        assertEquals("Desk agent", choice.name)
        assertEquals("Desk reading", choice.levelName)
        assertFalse(form.notesEnabled)
        assertEquals(
            AccessAuthorizationSelection.NewConnection("Desk agent", AccessConnectionLevel.Existing("level_example", 4)),
            validSelection(),
        )
    }

    @Test fun a_stale_refusal_that_changes_the_path_starts_from_the_proposed_names() = runTest(dispatcher) {
        gateway.overviewBlock = { connectionOverview() }
        gateway.lookupBlock = { connectionEnvelope(proposal("existing-level", connectionMatch())) }
        vm.lookup("abcd-efgh")
        advanceUntilIdle()
        val opened = requireNotNull(vm.state.value.form)
        vm.updateForm(opened.copy(connection = opened.connection?.copy(name = "Desk agent", levelName = "Desk reading")))
        // The level went away, so the refreshed step opens on a new access level.
        gateway.overviewBlock = { connectionOverview().copy(levels = emptyList()) }
        gateway.decideBlock = { _, _ -> throw GatewayException.ServerError(409, "inactive-grant") }

        vm.decide(true, validSelection())
        advanceUntilIdle()

        val choice = requireNotNull(vm.state.value.form?.connection)
        assertEquals(AccessConnectionPath.NEW_LEVEL, choice.path)
        assertEquals("Example agent 2", choice.name)
        assertEquals("Example reading", choice.levelName)
    }

    /* ── A gateway that predates connections reconnects a client it already knows ── */

    @Test fun a_fresh_client_opens_on_permissions_with_nothing_to_reconnect() = runTest(dispatcher) {
        vm.lookup("abcd-efgh")
        advanceUntilIdle()
        assertNull(vm.state.value.reconnect)
        assertEquals(AccessAuthorizationStep.PERMISSIONS, vm.state.value.step)
        assertTrue(requireNotNull(vm.state.value.form).answerEnabled)
    }

    @Test fun a_known_client_carries_its_proposal_and_starts_from_its_grant() = runTest(dispatcher) {
        gateway.lookupBlock = { envelope(request(), reconnect()) }
        vm.lookup("abcd-efgh")
        advanceUntilIdle()

        val state = vm.state.value
        assertEquals("Maya Reeves agent", state.reconnect?.principal?.name)
        assertEquals(AccessAuthorizationStep.PERMISSIONS, state.step)
        val form = requireNotNull(state.form)
        assertFalse(form.answerEnabled)
        assertTrue(form.directEnabled)
        assertEquals(setOf("notes:fictional"), form.directSources.allowedSourceIds)
    }

    @Test fun approval_sends_one_connect_selection_built_from_the_form() = runTest(dispatcher) {
        gateway.lookupBlock = { envelope(request(), reconnect()) }
        var sent: AccessAuthorizationDecision? = null
        gateway.decideBlock = { _, decision -> sent = decision }
        vm.lookup("abcd-efgh")
        advanceUntilIdle()

        vm.decide(true, validSelection())
        advanceUntilIdle()

        val selection = (sent as AccessAuthorizationDecision.Approve).selection as AccessAuthorizationSelection.Connect
        assertEquals("Example agent", selection.credentialLabel)
        assertEquals(listOf("notes:fictional"), selection.rules.single().sources.sourceIds)
        assertEquals(AccessAuthorizationCompletion.APPROVED, vm.state.value.completion)
    }

    @Test fun a_stale_selection_re_reads_the_reconnect_target_beside_the_overview() = runTest(dispatcher) {
        gateway.lookupBlock = { envelope(request(), reconnect()) }
        vm.lookup("abcd-efgh")
        advanceUntilIdle()
        vm.updateForm(requireNotNull(vm.state.value.form).copy(notesEnabled = true))
        gateway.decideBlock = { _, _ -> throw GatewayException.ServerError(409, "invalid-selection") }

        vm.decide(true, validSelection())
        advanceUntilIdle()

        assertEquals(2, gateway.lookupCalls)
        assertEquals(2, gateway.overviewCalls)
        assertEquals("Maya Reeves agent", vm.state.value.reconnect?.principal?.name)
        assertFalse(requireNotNull(vm.state.value.form).notesEnabled)
        assertTrue(requireNotNull(vm.state.value.form).directEnabled)
    }

    @Test fun a_revoked_reconnect_target_leaves_the_header_and_the_form_starts_fresh() = runTest(dispatcher) {
        gateway.lookupBlock = { envelope(request(), reconnect()) }
        vm.lookup("abcd-efgh")
        advanceUntilIdle()
        gateway.lookupBlock = { envelope(request()) }
        gateway.decideBlock = { _, _ -> throw GatewayException.ServerError(409, "inactive-grant") }

        vm.decide(true, validSelection())
        advanceUntilIdle()

        val state = vm.state.value
        assertNull(state.reconnect)
        assertEquals(AccessAuthorizationStep.PERMISSIONS, state.step)
        assertTrue(requireNotNull(state.form).answerEnabled)
        assertFalse(requireNotNull(state.form).directEnabled)
        assertTrue(state.actionError!!.contains("refreshed"))
    }

    @Test fun a_stale_refresh_whose_lookup_fails_returns_to_code_entry() = runTest(dispatcher) {
        loadReady()
        gateway.decideBlock = { _, _ -> throw GatewayException.ServerError(409, "invalid-selection") }
        gateway.lookupBlock = { error("offline") }
        vm.decide(true, validSelection())
        advanceUntilIdle()
        assertNull(vm.state.value.request)
        assertTrue(vm.state.value.lookupError!!.contains("Enter the code again"))
    }

    /* ── A request named by id, from the main screen's banner ── */

    @Test fun a_request_opened_by_id_skips_code_entry_and_lands_on_the_wizard() = runTest(dispatcher) {
        gateway.lookupByIdBlock = { id -> envelope(request(clientName = "Aurora Planner").copy(id = id), reconnect()) }
        vm.lookupInitialById("request_banner", 7L, pairingIdentity())
        assertTrue(vm.state.value.loading)
        assertEquals("", vm.state.value.code)
        advanceUntilIdle()

        val state = vm.state.value
        assertEquals(listOf("request_banner"), gateway.lookupIds)
        assertEquals(listOf(pairingIdentity()), gateway.lookupByIdPairings)
        assertEquals(0, gateway.lookupCalls)
        assertEquals("Aurora Planner", state.request?.clientName)
        assertEquals("Maya Reeves agent", state.reconnect?.principal?.name)
        assertNotNull(state.form)
        assertEquals(AccessAuthorizationStep.PERMISSIONS, state.step)
        assertEquals(1, gateway.catalogLoads)

        // The same delivery, replayed by a recomposition, is not looked up twice.
        vm.lookupInitialById("request_banner", 7L, pairingIdentity())
        advanceUntilIdle()
        assertEquals(1, gateway.lookupIds.size)
    }

    @Test fun a_request_opened_by_id_is_reconciled_and_settled_through_the_same_id() = runTest(dispatcher) {
        pendingRequests.replace(
            listOf(
                AccessPendingRequest("request_banner", "Aurora Planner", "ABCD-EFGH", 2, 2_000_000_000_000),
                AccessPendingRequest("request_other", "Northstar Assistant", "JKLM-NPQR", 1, 2_000_000_000_000),
            ),
        )
        gateway.lookupByIdBlock = { id -> envelope(request().copy(id = id)) }
        vm.lookupById("request_banner", pairingIdentity())
        advanceUntilIdle()
        selectAllowedSource()
        gateway.lookupByIdBlock = { id -> envelope(request(status = "approved").copy(id = id)) }
        gateway.decideBlock = { _, _ -> throw GatewayException.Network(IOException("response lost")) }

        vm.decide(true, validSelection())
        advanceUntilIdle()

        assertEquals(AccessAuthorizationCompletion.APPROVED, vm.state.value.completion)
        assertEquals(listOf("request_banner", "request_banner"), gateway.lookupIds)
        assertEquals(0, gateway.lookupCalls)
        // The decided request leaves the banner's list; the other one is what it now names.
        assertEquals("request_other", pendingRequests.state.value.banner?.newest?.id)
    }

    @Test fun a_request_by_id_that_is_no_longer_pending_says_so_and_leaves_the_banner() = runTest(dispatcher) {
        pendingRequests.replace(
            listOf(AccessPendingRequest("request_banner", "Aurora Planner", "ABCD-EFGH", 1, 2_000_000_000_000)),
        )
        gateway.lookupByIdBlock = { throw GatewayException.NotFound() }
        vm.lookupById("request_banner", pairingIdentity())
        advanceUntilIdle()
        assertEquals("This request is no longer waiting for a decision.", vm.state.value.lookupError)
        assertNull(vm.state.value.request)
        assertNull(pendingRequests.state.value.banner)

        pendingRequests.replace(
            listOf(AccessPendingRequest("request_banner", "Aurora Planner", "ABCD-EFGH", 1, 2_000_000_000_000)),
        )
        gateway.lookupByIdBlock = { id -> envelope(request(status = "denied").copy(id = id)) }
        vm.lookupById("request_banner", pairingIdentity())
        advanceUntilIdle()
        assertEquals("That authorization request has already been decided.", vm.state.value.lookupError)
        assertNull(pendingRequests.state.value.banner)
    }

    @Test fun a_request_by_id_from_a_pairing_since_replaced_is_refused() = runTest(dispatcher) {
        gateway.pairingChanged = true
        vm.lookupById("request_banner", pairingIdentity())
        advanceUntilIdle()
        assertEquals("The paired gateway changed. Scan the authorization code again.", vm.state.value.lookupError)
    }

    @Test fun a_request_by_id_whose_lookup_fails_keeps_its_place_in_the_banner() = runTest(dispatcher) {
        // Only a gateway that no longer holds the request settles it; a failed read says
        // nothing about whether the request still waits, so the banner keeps naming it.
        pendingRequests.replace(
            listOf(AccessPendingRequest("request_banner", "Aurora Planner", "ABCD-EFGH", 1, 2_000_000_000_000)),
        )

        gateway.lookupByIdBlock = { throw GatewayException.ServerError(500, "boom") }
        vm.lookupById("request_banner", pairingIdentity())
        advanceUntilIdle()
        assertEquals("The gateway refused the request (HTTP 500). Try again.", vm.state.value.lookupError)
        assertNull(vm.state.value.request)
        assertEquals("request_banner", pendingRequests.state.value.banner?.newest?.id)

        gateway.lookupByIdBlock = { throw GatewayException.Unauthorized() }
        vm.lookupById("request_banner", pairingIdentity())
        advanceUntilIdle()
        assertTrue(vm.state.value.lookupError!!.contains("Re-pair"))
        assertNull(vm.state.value.request)
        assertEquals("request_banner", pendingRequests.state.value.banner?.newest?.id)
    }

    private suspend fun TestScope.loadReady() {
        vm.lookup("abcd-efgh")
        advanceUntilIdle()
        selectAllowedSource()
    }

    private fun selectAllowedSource() {
        vm.updateForm(requireNotNull(vm.state.value.form).copy(
            answerSources = AccessSourceSelectionState(allowedSourceIds = setOf("notes:fictional")),
        ))
    }

    private fun validSelection() = requireNotNull(
        vm.state.value.form?.selection(requireNotNull(vm.state.value.request), requireNotNull(vm.state.value.overview)),
    )

    private fun request(clientName: String = "Example agent", status: String = "pending") = AccessAuthorizationRequest(
        id = "request_example",
        approvalId = "approval_example",
        status = status,
        clientId = "client_example",
        clientName = clientName,
        redirectOrigin = "http://127.0.0.1:10000",
        resource = "https://gateway.example.com/mcp",
        scope = "omnesis:access",
        expiresAt = 2_000_000_000_000,
        requiresAnswer = false,
    )

    private fun envelope(
        request: AccessAuthorizationRequest,
        reconnect: AccessReconnectProposal? = null,
    ) = AccessAuthorizationLookupEnvelope(request, reconnect)

    private fun connectionEnvelope(proposal: AccessConnectionProposal) =
        AccessAuthorizationLookupEnvelope(request(), connection = proposal)

    private fun proposal(recommended: String = "new-level", match: AccessConnectionMatch? = null) =
        AccessConnectionProposal(
            defaultName = "Example agent 2",
            defaultLevelName = "Example reading",
            match = match,
            recommended = recommended,
        )

    private fun connectionMatch(matchedBy: String = "client") = AccessConnectionMatch(
        connectionId = "principal_example",
        connectionName = "Maya Reeves laptop",
        matchedBy = matchedBy,
        levelId = "level_example",
        grant = connectionGrant(),
    )

    private fun connectionGrant() = AccessGrantSummary(
        id = "grant_example",
        name = "Maya Reeves laptop access",
        revision = 4,
        rules = listOf(
            AccessGrantRule.answer(
                AccessSourceBoundary(AccessSourceMode.ALL, emptyList()),
                AccessAnswerRelease.reviewed("policy_example"),
            ),
        ),
        credentials = listOf(
            AccessCredentialSummary("credential_example", "Maya Reeves laptop", "active", lastUsedAt = 1_782_000_000_000),
        ),
        levelId = "level_example",
    )

    private fun connectionOverview(levelRevision: Int = 3) = overview().copy(
        principals = listOf(
            AccessPrincipalSummary("principal_example", "Maya Reeves laptop", "interactive", listOf(connectionGrant())),
        ),
        levels = listOf(AccessLevelSummary("level_example", "Research", levelRevision, connectionGrant().rules, 1)),
    )

    private fun reconnect() = AccessReconnectProposal(
        matchedBy = "client",
        principal = AccessReconnectPrincipal("principal_example", "Maya Reeves agent"),
        grant = AccessGrantSummary(
            id = "grant_example",
            name = "Maya Reeves agent access",
            revision = 1,
            rules = listOf(
                AccessGrantRule.direct(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("notes:fictional"))),
            ),
            credentials = emptyList(),
        ),
    )

    private fun overview(sourceName: String = "Fictional Notes") = AccessOverview(
        principals = emptyList(),
        sources = listOf(AccessSourceInstance("notes:fictional", sourceName)),
        policyFamilies = listOf(AccessPolicyFamilySummary("policy_example", "Everyday", "1")),
        defaultPolicyFamilyId = "policy_example",
    )

    private fun pairingIdentity() = AccessAuthorizationPairingIdentity(
        gatewayUrl = "https://gateway.example.com",
        deviceId = "device-example",
        pairingGeneration = "generation-example",
    )

    private class FakeGateway(
        var overviewBlock: suspend () -> AccessOverview,
    ) : AccessAuthorizationGateway {
        var catalogLoads = 0
        override suspend fun ensureSourceCatalog(expectedPairing: AccessAuthorizationPairingIdentity?): Boolean {
            catalogLoads += 1
            return true
        }
        var lookupBlock: suspend (String) -> AccessAuthorizationLookupEnvelope = { AccessAuthorizationLookupEnvelope(request()) }
        var policyBlock: suspend (String) -> PrivacyPolicyDocument = { familyId ->
            PrivacyPolicyDocument(policy = "# Policy $familyId", revision = "revision-example")
        }
        val policyFamilyIds = mutableListOf<String>()
        var decideBlock: suspend (String, AccessAuthorizationDecision) -> Unit = { _, _ -> decisionCalls++ }
        var decisionCalls = 0
        var lookupCalls = 0
        var overviewCalls = 0
        var pairingChanged = false
        val lookupPairings = mutableListOf<AccessAuthorizationPairingIdentity?>()
        var lookupByIdBlock: suspend (String) -> AccessAuthorizationLookupEnvelope = { id ->
            AccessAuthorizationLookupEnvelope(request().copy(id = id))
        }
        val lookupIds = mutableListOf<String>()
        val lookupByIdPairings = mutableListOf<AccessAuthorizationPairingIdentity?>()

        override suspend fun lookup(
            code: String,
            expectedPairing: AccessAuthorizationPairingIdentity?,
        ): AccessAuthorizationLookupEnvelope {
            lookupCalls++
            lookupPairings += expectedPairing
            rejectChangedPairing(expectedPairing)
            return lookupBlock(code)
        }
        override suspend fun lookupById(
            id: String,
            expectedPairing: AccessAuthorizationPairingIdentity?,
        ): AccessAuthorizationLookupEnvelope {
            lookupIds += id
            lookupByIdPairings += expectedPairing
            rejectChangedPairing(expectedPairing)
            return lookupByIdBlock(id)
        }
        override suspend fun overview(expectedPairing: AccessAuthorizationPairingIdentity?): AccessOverview {
            overviewCalls++
            rejectChangedPairing(expectedPairing)
            return overviewBlock()
        }
        override suspend fun policy(
            familyId: String,
            expectedPairing: AccessAuthorizationPairingIdentity?,
        ): PrivacyPolicyDocument {
            policyFamilyIds += familyId
            rejectChangedPairing(expectedPairing)
            return policyBlock(familyId)
        }
        override suspend fun decide(
            id: String,
            decision: AccessAuthorizationDecision,
            expectedPairing: AccessAuthorizationPairingIdentity?,
        ) {
            rejectChangedPairing(expectedPairing)
            decideBlock(id, decision)
        }

        private fun rejectChangedPairing(expectedPairing: AccessAuthorizationPairingIdentity?) {
            if (pairingChanged && expectedPairing != null) throw AccessAuthorizationPairingChanged()
        }

        companion object {
            private fun request() = AccessAuthorizationRequest(
                id = "request_example",
                approvalId = "approval_example",
                status = "pending",
                clientId = "client_example",
                clientName = "Example agent",
                redirectOrigin = "http://127.0.0.1:10000",
                resource = "https://gateway.example.com/mcp",
                scope = "omnesis:access",
                expiresAt = 2_000_000_000_000,
                requiresAnswer = false,
            )
        }
    }
}
