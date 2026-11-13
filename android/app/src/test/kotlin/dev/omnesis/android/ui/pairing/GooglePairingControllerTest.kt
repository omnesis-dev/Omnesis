// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.pairing.CloudPairingChallenge
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GooglePairingControllerTest {
    private val context get() = ApplicationProvider.getApplicationContext<Context>()
    private class Attempt : GooglePairingAttempt {
        override val code = "ABCD-1234-5678-9012-3456"
        override val host = "gateway.example.com"
        override var approved = false
        var compared = false
        var closed = 0
        var starts = 0
        var polls = 0
        var startAction: suspend () -> Unit = {}
        var pollAction: suspend () -> Unit = { approved = true }
        var payloadError = false
        override suspend fun start(challenge: CloudPairingChallenge, token: String) {
            assertEquals("token", token); assertTrue(challenge.nonce.isNotBlank()); starts++; startAction()
        }
        override suspend fun poll() { polls++; pollAction() }
        override fun compare() { compared = true }
        override fun payload(): String { check(approved && compared && !payloadError); return "verified-payload" }
        override fun close() { closed++ }
    }

    @Test fun `approval alone and comparison alone never apply a pairing and double submit is ignored`() = runTest {
        val attempt = Attempt()
        var state = GooglePairingController.State()
        val applied = mutableListOf<String>()
        val controller = GooglePairingController(this, { _, _ -> "token" }, { attempt }, { applied += it }, { state = it })
        controller.compare(); controller.finish()
        controller.start(context); controller.start(context); runCurrent()
        assertEquals(1, attempt.starts)
        assertEquals(PairingViewModel.GooglePhase.Comparing, state.phase)
        controller.finish(); assertTrue(applied.isEmpty())
        controller.compare(); assertEquals(PairingViewModel.GooglePhase.Waiting, state.phase)
        controller.finish(); assertTrue(applied.isEmpty())
        advanceTimeBy(2000); runCurrent()
        assertEquals(PairingViewModel.GooglePhase.Ready, state.phase)
        controller.compare() // ready cannot reset the gate
        controller.finish(); controller.finish(); runCurrent()
        assertEquals(listOf("verified-payload"), applied)
        assertEquals(PairingViewModel.GooglePhase.Idle, state.phase)
        assertEquals(1, attempt.closed)
    }

    @Test fun `already approved response still requires local comparison`() = runTest {
        val attempt = Attempt().apply { approved = true }
        var state = GooglePairingController.State()
        val controller = GooglePairingController(this, { _, _ -> "token" }, { attempt }, {}, { state = it })
        controller.start(context); runCurrent()
        assertEquals(PairingViewModel.GooglePhase.Comparing, state.phase)
        controller.finish(); assertEquals(PairingViewModel.GooglePhase.Comparing, state.phase)
        controller.compare(); assertEquals(PairingViewModel.GooglePhase.Ready, state.phase)
        controller.cancel()
    }

    @Test fun `provider failures malformed tokens discovery errors and expired poll clear sensitive state`() = runTest {
        for (failure in listOf("provider", "blank", "large", "factory", "start", "poll")) {
            val attempt = Attempt().apply {
                if (failure == "start") startAction = { error("remote sensitive details") }
                if (failure == "poll") pollAction = { error("expired") }
            }
            var state = GooglePairingController.State()
            val controller = GooglePairingController(this, { _, _ ->
                when (failure) { "provider" -> error("provider secret"); "blank" -> ""; "large" -> "x".repeat(16_385); else -> "token" }
            }, { if (failure == "factory") error("factory"); attempt }, {}, { state = it })
            controller.start(context); runCurrent()
            if (failure == "poll") { controller.compare(); advanceTimeBy(2000); runCurrent() }
            assertEquals(failure, PairingViewModel.GooglePhase.Failed, state.phase)
            assertNull(state.code); assertNull(state.host); assertFalse(state.compared)
            assertFalse(state.error!!.contains("secret"))
            controller.compare(); controller.finish(); controller.cancel()
        }
    }

    @Test fun `pairing payload or session failure closes the client and requires a new comparison`() = runTest {
        for (payloadFailure in listOf(false, true)) {
            val attempt = Attempt().apply { approved = true; payloadError = payloadFailure }
            var state = GooglePairingController.State()
            val controller = GooglePairingController(this, { _, _ -> "token" }, { attempt }, { error("session") }, { state = it })
            controller.start(context); runCurrent(); controller.compare(); controller.finish(); runCurrent()
            assertEquals(PairingViewModel.GooglePhase.Failed, state.phase)
            assertEquals(1, attempt.closed)
            assertNull(state.code)
            controller.finish(); controller.cancel()
        }
    }

    @Test fun `cancelled provider and late discovery or poll cannot overwrite a new attempt`() = runTest {
        for (stage in listOf("provider", "start", "poll")) {
            val release = CompletableDeferred<Unit>()
            val old = Attempt()
            val next = Attempt()
            var calls = 0
            var state = GooglePairingController.State()
            suspend fun late() = withContext(NonCancellable) { release.await() }
            if (stage == "start") old.startAction = { late() }
            if (stage == "poll") old.pollAction = { late(); old.approved = true }
            val controller = GooglePairingController(this, { _, _ ->
                if (stage == "provider" && calls++ == 0) late()
                "token"
            }, { if (stage != "provider" && calls++ == 0) old else next }, {}, { state = it })
            controller.start(context); runCurrent()
            if (stage == "poll") { advanceTimeBy(2000); runCurrent() }
            controller.cancel(); controller.start(context); runCurrent()
            release.complete(Unit); runCurrent()
            assertEquals(PairingViewModel.GooglePhase.Comparing, state.phase)
            assertFalse(state.compared)
            assertFalse(next.approved)
            controller.cancel()
        }
    }

    @Test fun `obsolete errors cannot fail a replacement and failed attempts can retry`() = runTest {
        for (stage in listOf("provider", "start", "poll", "apply")) {
            val release = CompletableDeferred<Unit>()
            val old = Attempt().apply { approved = stage == "apply" }
            val next = Attempt()
            var clients = 0
            var providers = 0
            var state = GooglePairingController.State()
            suspend fun lateError(): Unit = withContext(NonCancellable) { release.await(); error("obsolete") }
            if (stage == "start") old.startAction = { lateError() }
            if (stage == "poll") old.pollAction = { lateError() }
            val controller = GooglePairingController(this, { _, _ ->
                if (stage == "provider" && providers++ == 0) lateError()
                "token"
            }, { if (stage != "provider" && clients++ == 0) old else next }, {
                if (stage == "apply") lateError()
            }, { state = it })
            controller.start(context); runCurrent()
            if (stage == "start") { controller.compare(); controller.finish() }
            if (stage == "poll") { advanceTimeBy(2000); runCurrent() }
            if (stage == "apply") { controller.compare(); controller.finish(); runCurrent() }
            controller.cancel(); controller.start(context); runCurrent()
            release.complete(Unit); runCurrent()
            assertEquals(PairingViewModel.GooglePhase.Comparing, state.phase)
            assertNull(state.error)
            controller.cancel()
        }
        var attempts = 0
        val retry = Attempt()
        var state = GooglePairingController.State()
        val controller = GooglePairingController(this, { _, _ ->
            if (attempts++ == 0) error("provider failure")
            "token"
        }, { retry }, {}, { state = it })
        controller.start(context); runCurrent()
        assertEquals(PairingViewModel.GooglePhase.Failed, state.phase)
        controller.start(context); runCurrent()
        assertEquals(PairingViewModel.GooglePhase.Comparing, state.phase)
        controller.cancel()
    }

    @Test fun `cancelling an in-flight cancellable session cannot publish a failure or revive credentials`() = runTest {
        val attempt = Attempt().apply { approved = true }
        var state = GooglePairingController.State()
        val controller = GooglePairingController(this, { _, _ -> "token" }, { attempt }, {
            kotlinx.coroutines.awaitCancellation()
        }, { state = it })
        controller.start(context); runCurrent(); controller.compare(); controller.finish(); runCurrent()
        assertEquals(PairingViewModel.GooglePhase.Pairing, state.phase)
        controller.cancel(); runCurrent()
        assertEquals(PairingViewModel.GooglePhase.Idle, state.phase)
        assertNull(state.code); assertNull(state.host); assertNull(state.error)
        assertEquals(1, attempt.closed)
    }

    @Test fun `cancellation exceptions never become failure and late session completion cannot clear new state`() = runTest {
        val attempt = Attempt().apply { approved = true }
        val release = CompletableDeferred<Unit>()
        var state = GooglePairingController.State()
        val controller = GooglePairingController(this, { _, _ -> "token" }, { attempt }, {
            withContext(NonCancellable) { release.await() }
        }, { state = it })
        controller.start(context); runCurrent(); controller.compare(); controller.finish(); runCurrent()
        controller.cancel(); controller.start(context); runCurrent()
        release.complete(Unit); runCurrent()
        assertEquals(PairingViewModel.GooglePhase.Comparing, state.phase)
        controller.cancel()
        val cancelled = GooglePairingController(this, { _, _ -> throw CancellationException() }, { attempt }, {}, { state = it })
        cancelled.start(context); runCurrent(); assertEquals(PairingViewModel.GooglePhase.Idle, state.phase)
        cancelled.cancel()
        val applyCancelled = GooglePairingController(this, { _, _ -> "token" }, { attempt }, { throw CancellationException() }, { state = it })
        applyCancelled.start(context); runCurrent(); applyCancelled.compare(); applyCancelled.finish(); runCurrent()
        assertEquals(PairingViewModel.GooglePhase.Idle, state.phase)
        applyCancelled.cancel()
    }
}
