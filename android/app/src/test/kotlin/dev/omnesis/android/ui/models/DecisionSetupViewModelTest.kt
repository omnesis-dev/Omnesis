// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.CredentialSpec
import dev.omnesis.android.transport.dto.BackendConfig
import dev.omnesis.android.transport.dto.BackendConfigPatch
import dev.omnesis.android.transport.dto.DecisionCalibrationStatus
import dev.omnesis.android.transport.dto.DecisionProbeBody
import dev.omnesis.android.transport.dto.DecisionProbeResult
import dev.omnesis.android.transport.dto.DecisionVerifyResult
import dev.omnesis.android.transport.dto.ModelCredentialEntry
import dev.omnesis.android.ui.models.DecisionSetup.KeyState
import dev.omnesis.android.ui.models.DecisionSetup.SaveRequest
import dev.omnesis.android.ui.models.DecisionSetup.VerifyState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** The Decision setup's view-model against a scripted [DecisionGateway]. All values are invented. */
@OptIn(ExperimentalCoroutinesApi::class)
class DecisionSetupViewModelTest {

    private class FakeGateway : DecisionGateway {
        val calls = mutableListOf<String>()
        /** The `PATCH /admin/config` bodies the saves would send, rendered by the production builder. */
        val patches = mutableListOf<String>()
        var credentials: List<ModelCredentialEntry> = emptyList()
        var credentialsFailure: Throwable? = null
        var saveFailure: Throwable? = null
        var removeFailure: Throwable? = null
        var startFailure: Throwable? = null
        var verifyResult = DecisionVerifyResult(ok = true, answeredBy = "kev", latencyMs = 240)
        /** Each read takes the next scripted outcome; the last one repeats. */
        val calibrationReads = ArrayDeque<Result<DecisionCalibrationStatus>>()
        var calibrationReadCount = 0

        override suspend fun modelCredentials(): List<ModelCredentialEntry> {
            credentialsFailure?.let { throw it }
            return credentials
        }
        override suspend fun setTypeSafeKey(apiKey: String) { calls += "credential:$apiKey" }
        override suspend fun saveBackend(key: String, config: BackendConfig, model: String, enableRemote: Boolean) {
            saveFailure?.let { throw it }
            calls += "save:$key/$model remote=$enableRemote"
            patches += BackendConfigPatch.saveBackend(key, config, model, enableRemote).toString()
        }
        override suspend fun assignTypeSafe(model: String, enableRemote: Boolean) {
            calls += "assign:typesafe/$model remote=$enableRemote"
        }
        override suspend fun disableDecision(key: String, clearAssignment: Boolean) {
            removeFailure?.let { throw it }
            calls += "disable:$key clear=$clearAssignment"
            patches += BackendConfigPatch.disableDecision(key, clearAssignment).toString()
        }
        override suspend fun removeBackend(key: String, clearAssignment: Boolean) {
            removeFailure?.let { throw it }
            calls += "remove:$key clear=$clearAssignment"
            patches += BackendConfigPatch.removeBackend(key, clearAssignment).toString()
        }
        override suspend fun probe(target: ProbeTarget): DecisionProbeResult {
            calls += "probe:${target.id}"
            return DecisionProbeResult(ok = true, models = listOf("kev"), listed = true)
        }
        override suspend fun verifyBackend(key: String, model: String): DecisionVerifyResult {
            calls += "verify:$key/$model"
            return verifyResult
        }
        override suspend fun verifyTypeSafe(model: String): DecisionVerifyResult {
            calls += "verify:typesafe/$model"
            return verifyResult
        }
        override suspend fun calibration(): DecisionCalibrationStatus {
            calibrationReadCount += 1
            val next = if (calibrationReads.size > 1) calibrationReads.removeFirst() else calibrationReads.firstOrNull()
            return (next ?: Result.success(DecisionCalibrationStatus())).getOrThrow()
        }
        override suspend fun startCalibration(): DecisionCalibrationStatus {
            startFailure?.let { throw it }
            calls += "calibrate"
            return running(0)
        }
        override suspend fun cancelCalibration() = running(4).copy(state = "cancelled")
    }

    companion object {
        fun running(done: Int) = DecisionCalibrationStatus(state = "running", assignment = "ollaya/kev", done = done, total = 296)
    }

    private val gateway = FakeGateway()

    @Before fun setUp() { Dispatchers.setMain(UnconfinedTestDispatcher()) }

    @After fun tearDown() { Dispatchers.resetMain() }

    private fun viewModel() = DecisionSetupViewModel(gateway, pollIntervalMs = 2_000)

    private fun TestScope.changesOf(vm: DecisionSetupViewModel): MutableList<Unit> {
        val events = mutableListOf<Unit>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { vm.changes.toList(events) }
        return events
    }

    // --- Saving ---

    @Test fun typesafe_save_writes_the_credential_before_the_assignment_and_then_verifies() = runTest {
        val vm = viewModel()
        val changes = changesOf(vm)
        var saved = false
        vm.save(SaveRequest.TypeSafe("jev-1.14.0", apiKey = " example-key-0006 ").withConsent()) { saved = true }
        assertEquals(
            listOf("credential:example-key-0006", "assign:typesafe/jev-1.14.0 remote=true", "verify:typesafe/jev-1.14.0"),
            gateway.calls,
        )
        assertTrue(saved)
        assertEquals(1, changes.size)
        assertEquals(KeyState.Stored, vm.state.value.typesafeKey)
        assertEquals(VerifyState.Done("typesafe/jev-1.14.0", gateway.verifyResult), vm.state.value.verify)
    }

    @Test fun a_blank_typesafe_key_keeps_the_stored_one() = runTest {
        val vm = viewModel()
        vm.save(SaveRequest.TypeSafe("jev-1.14.0", apiKey = "  ")) {}
        assertEquals(listOf("assign:typesafe/jev-1.14.0 remote=false", "verify:typesafe/jev-1.14.0"), gateway.calls)
    }

    @Test fun a_backend_save_announces_the_change_and_verifies_the_new_assignment() = runTest {
        val vm = viewModel()
        val changes = changesOf(vm)
        var saved = false
        val request = DecisionSetup.newBackendSave("ollama", null, "http://127.0.0.1:11434/v1/systemone", "", "d3:4b")
        vm.save(request) { saved = true }
        assertEquals(listOf("save:ollama/d3:4b remote=false", "verify:ollama/d3:4b"), gateway.calls)
        assertTrue(saved)
        assertEquals(1, changes.size)
        assertFalse(vm.state.value.saving)
        assertNull(vm.state.value.error)
    }

    @Test fun enabling_decisions_on_a_backend_with_a_key_sends_no_key() = runTest {
        val overview = sampleDecisionOverview()
        val enable = DecisionSetup.providerGroups(overview).yours.filterIsInstance<DecisionSetup.Provider.Enable>().single()
        val vm = viewModel()
        vm.save(DecisionSetup.enableSave(enable, enable.decision.url, "", "accounts/fireworks/models/rune").withConsent()) {}
        assertEquals(
            listOf(
                "save:fireworks/accounts/fireworks/models/rune remote=true",
                "verify:fireworks/accounts/fireworks/models/rune",
            ),
            gateway.calls,
        )
        assertEquals(
            listOf(
                """{"inference":{"allowRemoteInference":true,"backends":{"fireworks":{"decision":""" +
                    """{"url":"https://api.fireworks.ai/inference/v1/systemone","protocol":"systemone","auth":"bearer"}}},""" +
                    """"assignments":{"decision":"fireworks/accounts/fireworks/models/rune"}}}""",
            ),
            gateway.patches,
        )
    }

    @Test fun adding_a_both_api_provider_configures_both_and_a_decision_only_one_only_decisions() = runTest {
        val vm = viewModel()
        val fireworks = sampleDecisionPresets().first { it.id == "fireworks" }
        val perplexity = sampleDecisionPresets().first { it.id == "perplexity" }
        vm.save(DecisionSetup.newBackendSave("fireworks-2", fireworks, fireworks.decision!!.url, "example-key-0010", "accounts/fireworks/models/rune")) {}
        vm.save(DecisionSetup.newBackendSave("perplexity", perplexity, perplexity.decision!!.url, "example-key-0011", "pplx-decider-v1.2")) {}
        assertEquals(
            listOf(
                """{"inference":{"backends":{"fireworks-2":{"type":"http","preset":"fireworks",""" +
                    """"url":"https://api.fireworks.ai/inference","apiKey":"example-key-0010",""" +
                    """"decision":{"url":"https://api.fireworks.ai/inference/v1/systemone","protocol":"systemone","auth":"bearer"}}},""" +
                    """"assignments":{"decision":"fireworks-2/accounts/fireworks/models/rune"}}}""",
                """{"inference":{"backends":{"perplexity":{"type":"http","preset":"perplexity","apiKey":"example-key-0011",""" +
                    """"decision":{"url":"https://api.perplexity.ai/v1/decisions","protocol":"systemone","auth":"bearer"}}},""" +
                    """"assignments":{"decision":"perplexity/pplx-decider-v1.2"}}}""",
            ),
            gateway.patches,
        )
    }

    @Test fun a_refused_save_shows_the_gateways_reason_verbatim() = runTest {
        val vm = viewModel()
        val changes = changesOf(vm)
        gateway.saveFailure = GatewayException.ServerError(400, "\"studio\" is already the name of an HTTP backend")
        var saved = false
        vm.save(DecisionSetup.newBackendSave("studio", null, "http://127.0.0.1:8080/v1/systemone", "", "kev")) { saved = true }
        assertEquals("\"studio\" is already the name of an HTTP backend", vm.state.value.error)
        assertFalse(saved)
        assertTrue(changes.isEmpty())
        assertEquals(VerifyState.Idle, vm.state.value.verify)
    }

    // --- Removing ---

    @Test fun removing_resets_the_verify_line_only_when_the_assignment_was_cleared() = runTest {
        val vm = viewModel()
        vm.verify("ollaya/kev")
        val verified = vm.state.value.verify
        assertTrue(verified is VerifyState.Done)

        var removed = 0
        vm.remove(DecisionSetup.Removal("spare", wholeBackend = true, clearAssignment = false)) { removed += 1 }
        assertEquals(verified, vm.state.value.verify)
        vm.remove(DecisionSetup.Removal("ollaya", wholeBackend = true, clearAssignment = true)) { removed += 1 }
        assertEquals(VerifyState.Idle, vm.state.value.verify)
        assertEquals(2, removed)
        assertTrue("remove:ollaya clear=true" in gateway.calls)
    }

    @Test fun a_chat_backend_loses_only_its_decision_api_and_a_decision_only_one_goes_whole() = runTest {
        val vm = viewModel()
        vm.remove(DecisionSetup.Removal("fireworks", wholeBackend = false, clearAssignment = true)) {}
        vm.remove(DecisionSetup.Removal("ollaya", wholeBackend = true, clearAssignment = false)) {}
        assertEquals(listOf("disable:fireworks clear=true", "remove:ollaya clear=false"), gateway.calls)
        assertEquals(
            listOf(
                """{"inference":{"backends":{"fireworks":{"decision":null}},"assignments":{"decision":null}}}""",
                """{"inference":{"backends":{"ollaya":null}}}""",
            ),
            gateway.patches,
        )
    }

    // --- Listing a server's models ---

    @Test fun saved_and_unsaved_servers_are_listed_under_their_own_ids() = runTest {
        val vm = viewModel()
        vm.probe(ProbeTarget.Saved("ollaya"))
        val unsaved = ProbeTarget.Unsaved(DecisionProbeBody(url = "http://127.0.0.1:11434/v1/systemone", preset = "ollama"))
        vm.probe(unsaved)
        assertEquals(listOf("probe:backend:ollaya", "probe:url:http://127.0.0.1:11434/v1/systemone"), gateway.calls)
        val done = ProbeState.Done(DecisionProbeResult(ok = true, models = listOf("kev"), listed = true))
        assertEquals(mapOf("backend:ollaya" to done, unsaved.id to done), vm.state.value.probes)
        // Removing a backend forgets its listing.
        vm.remove(DecisionSetup.Removal("ollaya", wholeBackend = true, clearAssignment = false)) {}
        assertEquals(setOf(unsaved.id), vm.state.value.probes.keys)
    }

    @Test fun a_failed_removal_keeps_everything_and_says_why() = runTest {
        val vm = viewModel()
        vm.verify("ollaya/kev")
        gateway.removeFailure = GatewayException.ServerError(500, "config is read-only")
        var removed = false
        vm.remove(DecisionSetup.Removal("ollaya", wholeBackend = true, clearAssignment = true)) { removed = true }
        assertFalse(removed)
        assertEquals("config is read-only", vm.state.value.error)
        assertTrue(vm.state.value.verify is VerifyState.Done)
    }

    // --- The TypeSafe key ---

    @Test fun an_unreadable_credential_list_is_unknown_not_missing() = runTest {
        gateway.credentialsFailure = GatewayException.Network(java.io.IOException("offline"))
        val vm = viewModel()
        vm.opened()
        assertEquals(KeyState.Unknown("network error"), vm.state.value.typesafeKey)

        gateway.credentialsFailure = null
        gateway.credentials = listOf(ModelCredentialEntry("typesafe", "typesafe", "TypeSafe", CredentialSpec(), configured = true))
        vm.opened()
        assertEquals(KeyState.Stored, vm.state.value.typesafeKey)
    }

    // --- Calibration ---

    @Test fun a_conflicting_start_shows_the_running_job_and_drops_the_error() = runTest {
        gateway.startFailure = GatewayException.ServerError(409, "A calibration is already running")
        gateway.calibrationReads += Result.success(running(40))
        val vm = viewModel()
        vm.startCalibration()
        assertEquals(running(40), vm.state.value.calibration)
        assertNull(vm.state.value.calibrationError)
        assertEquals(1, gateway.calibrationReadCount)
    }

    @Test fun a_refused_start_keeps_the_gateways_reason() = runTest {
        gateway.startFailure = GatewayException.ServerError(400, "Calibration needs the Decision model to be assigned to a decision backend.")
        val vm = viewModel()
        vm.startCalibration()
        assertEquals("Calibration needs the Decision model to be assigned to a decision backend.", vm.state.value.calibrationError)
    }

    @Test fun following_ends_when_the_run_is_done_and_announces_the_stored_calibration() = runTest {
        val vm = viewModel()
        val changes = changesOf(vm)
        vm.startCalibration()
        gateway.calibrationReads += Result.success(running(150))
        gateway.calibrationReads += Result.success(running(296).copy(state = "done"))
        vm.followCalibration()
        assertEquals("done", vm.state.value.calibration?.state)
        assertEquals(2, gateway.calibrationReadCount)
        assertEquals(1, changes.size)
    }

    @Test fun following_ends_on_a_failed_or_cancelled_run_without_announcing_a_change() = runTest {
        for (end in listOf("failed", "cancelled")) {
            val gateway = FakeGateway()
            val vm = DecisionSetupViewModel(gateway, pollIntervalMs = 2_000)
            val changes = changesOf(vm)
            vm.startCalibration()
            gateway.calibrationReads += Result.success(running(10).copy(state = end))
            vm.followCalibration()
            assertEquals(end, vm.state.value.calibration?.state)
            assertEquals(1, gateway.calibrationReadCount)
            assertTrue(changes.isEmpty())
        }
    }

    @Test fun following_gives_up_after_repeated_read_failures_and_shows_the_last_one() = runTest {
        val vm = viewModel()
        vm.startCalibration()
        gateway.calibrationReads += Result.success(running(20))
        // One failure between successes is ridden out…
        gateway.calibrationReads += Result.failure(GatewayException.Network(java.io.IOException("reset")))
        gateway.calibrationReads += Result.success(running(30))
        // …three in a row end the watch.
        gateway.calibrationReads += Result.failure(GatewayException.ServerError(502, "bad gateway"))
        vm.followCalibration()
        assertEquals(6, gateway.calibrationReadCount)
        assertEquals(running(30), vm.state.value.calibration)
        assertEquals("Could not read the calibration's progress: bad gateway", vm.state.value.calibrationError)
    }

    @Test fun nothing_is_followed_when_no_run_is_going() = runTest {
        val vm = viewModel()
        vm.followCalibration()
        assertEquals(0, gateway.calibrationReadCount)
    }
}
