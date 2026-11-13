// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.pairing.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
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
class AccountPairingControllerTest {
    private val context get() = ApplicationProvider.getApplicationContext<Context>()
    private val choice = AccountGatewayChoice("00000000-0000-4000-8000-000000000001", "https://home.example.test", "Fictional home")
    private val other = AccountGatewayChoice("00000000-0000-4000-8000-000000000002", "https://studio.example.test", "Fictional studio")
    private inner class Attempt(val choices: List<AccountGatewayChoice> = listOf(choice, other)) : AccountPairingAttempt {
        val calls = mutableListOf<String>()
        override val code = "465 774"
        override val host = "home.example.test"
        override var approved = false
        override var joined = false
        override var retryUntilMillis = 0L
        var compared = false
        var closed = false
        var googleError: Exception? = null
        var selectErrors = mutableListOf<Exception>()
        var joinOnSelect = false
        override suspend fun begin(challenge: CloudPairingChallenge): String { calls += "begin"; return "server-nonce" }
        override suspend fun google(token: String): List<AccountGatewayChoice> { calls += "google"; assertEquals("google-token", token); googleError?.let { throw it }; return choices }
        override suspend fun passkeyOptions(): AccountCloudPairingClient.PasskeyOptions { calls += "options"; return AccountCloudPairingClient.PasskeyOptions("ceremony", "assertion-options") }
        override suspend fun passkey(options: AccountCloudPairingClient.PasskeyOptions, assertion: String): List<AccountGatewayChoice> { calls += "passkey"; assertEquals("native-assertion", assertion); return choices }
        override suspend fun select(gatewayId: String) {
            calls += "select"; assertTrue(choices.any { it.gatewayId == gatewayId })
            if (selectErrors.isNotEmpty()) throw selectErrors.removeAt(0)
            if (joinOnSelect) { approved = true; joined = true }
        }
        override suspend fun poll() { calls += "poll"; approved = true }
        override fun compare() { compared = true }
        override fun payload(): String { check(approved && compared); return "strict-pinned-payload" }
        override fun close() { closed = true }
    }
    private fun offline() = AccountPairingException(AccountPairingException.Reason.GATEWAY_OFFLINE)
    private fun TestScope.ports(attempt: Attempt, applied: MutableList<String> = mutableListOf()) = AccountPairingPorts(
        { _, nonce -> assertEquals(listOf("begin"), attempt.calls); assertEquals("server-nonce", nonce); "google-token" },
        { _, _ -> error("Wrong provider") }, { attempt }, { applied += it }, { currentTime },
    )

    @Test fun `nonce precedes native Google, several gateways need a choice, and a held request needs comparison`() = runTest {
        val attempt = Attempt(); var state = AccountPairingState(); val applied = mutableListOf<String>()
        val controller = AccountPairingController(this, ports(attempt, applied)) { state = it }
        controller.finish(); controller.choose(choice.gatewayId)
        controller.start(context, AccountPairingController.Method.Google); controller.start(context, AccountPairingController.Method.Google); runCurrent()
        assertEquals(AccountPairingPhase.Choosing, state.phase); assertEquals(listOf(choice, other), state.gateways)
        assertEquals(listOf("begin", "google"), attempt.calls)
        controller.choose("unknown"); assertEquals(AccountPairingPhase.Choosing, state.phase)
        controller.finish(); assertTrue(applied.isEmpty())
        controller.choose(choice.gatewayId); runCurrent()
        assertEquals(AccountPairingPhase.Comparing, state.phase)
        controller.finish(); assertTrue(applied.isEmpty()); assertFalse(attempt.compared)
        advanceTimeBy(2000); runCurrent(); assertTrue(state.approved)
        controller.finish(); controller.finish(); runCurrent()
        assertEquals(listOf("strict-pinned-payload"), applied); assertTrue(attempt.closed)
        assertEquals(AccountPairingPhase.Idle, state.phase)
    }

    @Test fun `one gateway skips the chooser`() = runTest {
        val attempt = Attempt(listOf(choice)); val states = mutableListOf<AccountPairingState>()
        val controller = AccountPairingController(this, ports(attempt)) { states += it }
        controller.start(context, AccountPairingController.Method.Google); runCurrent()
        assertEquals(listOf("begin", "google", "select"), attempt.calls)
        assertTrue(states.none { it.phase == AccountPairingPhase.Choosing })
        assertEquals(AccountPairingPhase.Comparing, states.last().phase)
        controller.cancel()
    }

    @Test fun `a gateway that joins the device pairs without showing a code`() = runTest {
        val attempt = Attempt(listOf(choice)).apply { joinOnSelect = true }; val states = mutableListOf<AccountPairingState>(); val applied = mutableListOf<String>()
        val controller = AccountPairingController(this, ports(attempt, applied)) { states += it }
        controller.start(context, AccountPairingController.Method.Google); runCurrent()
        assertEquals(listOf("strict-pinned-payload"), applied)
        assertTrue(states.none { it.phase == AccountPairingPhase.Comparing })
        assertTrue(states.any { it.phase == AccountPairingPhase.Pairing && it.joined && it.code == null })
        assertEquals(AccountPairingPhase.Idle, states.last().phase)
    }

    @Test fun `passkey uses its server ceremony and the same explicit gateway choice`() = runTest {
        val attempt = Attempt(); var state = AccountPairingState()
        val ports = AccountPairingPorts({ _, _ -> error("Wrong provider") }, { _, options -> assertEquals("assertion-options", options); "native-assertion" }, { attempt }, { error("Unapproved payload") })
        val controller = AccountPairingController(this, ports) { state = it }
        controller.start(context, AccountPairingController.Method.Passkey); runCurrent()
        assertEquals(listOf("begin", "options", "passkey"), attempt.calls)
        assertEquals(AccountPairingPhase.Choosing, state.phase); controller.cancel()
    }

    @Test fun `an offline gateway waits with backoff and continues when it returns`() = runTest {
        val attempt = Attempt(listOf(choice)).apply { retryUntilMillis = 600_000; selectErrors += listOf(offline(), offline()) }
        var state = AccountPairingState()
        val controller = AccountPairingController(this, ports(attempt)) { state = it }
        controller.start(context, AccountPairingController.Method.Google); runCurrent()
        assertEquals(AccountPairingPhase.WaitingForGateway, state.phase)
        assertEquals(1, attempt.calls.count { it == "select" })
        advanceTimeBy(1_999); runCurrent(); assertEquals(1, attempt.calls.count { it == "select" })
        advanceTimeBy(1); runCurrent(); assertEquals(2, attempt.calls.count { it == "select" })
        assertEquals(AccountPairingPhase.WaitingForGateway, state.phase)
        advanceTimeBy(3_999); runCurrent(); assertEquals(2, attempt.calls.count { it == "select" })
        advanceTimeBy(1); runCurrent(); assertEquals(3, attempt.calls.count { it == "select" })
        assertEquals(AccountPairingPhase.Comparing, state.phase)
        controller.cancel()
    }

    @Test fun `waiting ends when the proof expires and asks to sign in again`() = runTest {
        val attempt = Attempt(listOf(choice)).apply { retryUntilMillis = 5_000; repeat(10) { selectErrors += offline() } }
        var state = AccountPairingState()
        val controller = AccountPairingController(this, ports(attempt)) { state = it }
        controller.start(context, AccountPairingController.Method.Google); runCurrent()
        assertEquals(AccountPairingPhase.WaitingForGateway, state.phase)
        advanceTimeBy(5_001); runCurrent()
        assertEquals(AccountPairingPhase.Failed, state.phase)
        assertEquals("Your sign-in expired. Sign in again to connect this device.", state.error)
        assertTrue(attempt.closed)
    }

    @Test fun `cancelling while waiting stops the retries`() = runTest {
        val attempt = Attempt(listOf(choice)).apply { retryUntilMillis = 600_000; repeat(10) { selectErrors += offline() } }
        var state = AccountPairingState()
        val controller = AccountPairingController(this, ports(attempt)) { state = it }
        controller.start(context, AccountPairingController.Method.Google); runCurrent()
        controller.cancel()
        val tries = attempt.calls.count { it == "select" }
        advanceTimeBy(120_000); runCurrent()
        assertEquals(tries, attempt.calls.count { it == "select" })
        assertEquals(AccountPairingPhase.Idle, state.phase)
    }

    @Test fun `a passkey prompt that ends without a passkey explains, and a closed Google dialog says nothing`() = runTest {
        val attempt = Attempt(listOf(choice))
        var state = AccountPairingState()
        val noPasskey = AccountPairingPorts({ _, _ -> error("Wrong provider") }, { _, _ -> throw AccountNoPasskey() }, { attempt }, {}, { currentTime })
        val controller = AccountPairingController(this, noPasskey) { state = it }
        controller.start(context, AccountPairingController.Method.Passkey); runCurrent()
        // The choices come back with an explanation that is not a failure.
        assertEquals(AccountPairingPhase.Failed, state.phase)
        assertEquals(null, state.error)
        assertEquals(
            "No passkey was used. If this phone has no passkey for your Omnesis account, sign in with Google, or add a passkey to your Omnesis account first.",
            state.notice,
        )
        assertTrue(attempt.closed)

        val second = Attempt(listOf(choice))
        val dismissed = AccountPairingPorts({ _, _ -> throw AccountSignInDismissed() }, { _, _ -> error("Wrong provider") }, { second }, {}, { currentTime })
        val google = AccountPairingController(this, dismissed) { state = it }
        google.start(context, AccountPairingController.Method.Google); runCurrent()
        assertEquals(AccountPairingState(), state)
        assertTrue(second.closed)
    }

    @Test fun `every failure reads as it does on the iPhone`() = runTest {
        for ((reason, text) in listOf(
            AccountPairingException.Reason.NO_GATEWAYS to "This Omnesis account has no gateway yet. Connect your gateway to it first, or pair directly with a QR code.",
            AccountPairingException.Reason.NOT_YOUR_GATEWAY to "This doesn't look like your gateway. Nothing was saved. Try again, or pair directly with a QR code.",
            AccountPairingException.Reason.GATEWAY_UPDATE_REQUIRED to "Your gateway needs an update before this device can sign in. Update Omnesis on your gateway, then try again.",
            AccountPairingException.Reason.UNAVAILABLE to "Couldn't connect with your Omnesis account. Check your internet connection and try again, or pair directly with a QR code.",
        )) {
            val attempt = Attempt(listOf(choice)).apply { selectErrors += AccountPairingException(reason) }
            var state = AccountPairingState()
            val controller = AccountPairingController(this, ports(attempt)) { state = it }
            controller.start(context, AccountPairingController.Method.Google); runCurrent()
            assertEquals(text, state.error)
        }
    }

    @Test fun `a refusal or an older gateway says so and saves nothing`() = runTest {
        for ((reason, text) in listOf(
            AccountPairingException.Reason.NOT_YOUR_GATEWAY to "This doesn't look like your gateway",
            AccountPairingException.Reason.GATEWAY_UPDATE_REQUIRED to "needs an update",
        )) {
            val attempt = Attempt(listOf(choice)).apply { selectErrors += AccountPairingException(reason) }
            var state = AccountPairingState(); val applied = mutableListOf<String>()
            val controller = AccountPairingController(this, ports(attempt, applied)) { state = it }
            controller.start(context, AccountPairingController.Method.Google); runCurrent()
            assertEquals(AccountPairingPhase.Failed, state.phase); assertTrue(state.error!!, state.error!!.contains(text))
            assertTrue(applied.isEmpty()); assertTrue(attempt.closed)
        }
    }

    @Test fun `late native provider completion after cancellation cannot select or pair`() = runTest {
        val attempt = Attempt(); var state = AccountPairingState(); val token = CompletableDeferred<String>()
        val ports = AccountPairingPorts({ _, _ -> withContext(NonCancellable) { token.await() } }, { _, _ -> error("Wrong provider") }, { attempt }, { error("Cancelled payload") })
        val controller = AccountPairingController(this, ports) { state = it }
        controller.start(context, AccountPairingController.Method.Google); runCurrent()
        controller.cancel(); token.complete("google-token"); runCurrent()
        assertEquals(AccountPairingPhase.Idle, state.phase); assertTrue(attempt.closed)
        assertEquals(listOf("begin"), attempt.calls)
    }

    @Test fun `a sign-in without an Omnesis account says how to create one and leaves the sign-in choices`() = runTest {
        assertEquals(
            "There is no Omnesis account for this sign-in yet. Create one from your gateway: open its portal, go to Settings, then Account, and choose \"Create an Omnesis account\". You can also pair directly with a QR code.",
            ACCOUNT_PAIRING_NO_ACCOUNT_MESSAGE,
        )
        val refused = Attempt().apply { googleError = AccountPairingException(AccountPairingException.Reason.NO_ACCOUNT) }
        val attempts = mutableListOf(refused, Attempt(listOf(choice)).apply { joinOnSelect = true })
        var state = AccountPairingState(); val applied = mutableListOf<String>()
        val ports = AccountPairingPorts({ _, _ -> "google-token" }, { _, _ -> error("Wrong provider") }, { attempts.removeAt(0) }, { applied += it })
        val controller = AccountPairingController(this, ports) { state = it }
        controller.start(context, AccountPairingController.Method.Google); runCurrent()
        assertEquals(AccountPairingPhase.Failed, state.phase); assertEquals(ACCOUNT_PAIRING_NO_ACCOUNT_MESSAGE, state.error)
        assertTrue(refused.closed); assertEquals(listOf("begin", "google"), refused.calls)
        // Another sign-in starts from the same screen.
        controller.start(context, AccountPairingController.Method.Google); runCurrent()
        assertEquals(listOf("strict-pinned-payload"), applied)
    }

    @Test fun `missing gateway is distinct from a gateway connection failure and remains retryable`() = runTest {
        val attempt = Attempt().apply { googleError = AccountPairingException(AccountPairingException.Reason.NO_GATEWAYS) }; var state = AccountPairingState()
        val ports = AccountPairingPorts({ _, _ -> "google-token" }, { _, _ -> error("Wrong provider") }, { attempt }, { error("Unapproved payload") })
        val controller = AccountPairingController(this, ports) { state = it }
        controller.start(context, AccountPairingController.Method.Google); runCurrent()
        assertEquals(AccountPairingPhase.Failed, state.phase); assertTrue(state.error!!.contains("This Omnesis account has no gateway yet"))
        assertTrue(attempt.closed); controller.cancel()
    }
}
