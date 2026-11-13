// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import android.content.Context
import dev.omnesis.android.pairing.CloudPairingChallenge
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** UI orchestration only. Cryptographic verification and payload gates remain in core-pairing. */
internal interface GooglePairingAttempt : AutoCloseable {
    suspend fun start(challenge: CloudPairingChallenge, token: String)
    val code: String
    val host: String
    val approved: Boolean
    suspend fun poll()
    fun compare()
    fun payload(): String
}

internal class GooglePairingController(
    private val scope: CoroutineScope,
    private val acquireToken: suspend (Context, String) -> String,
    private val createClient: () -> GooglePairingAttempt,
    private val applyPairing: suspend (String) -> Unit,
    private val changed: (State) -> Unit,
) {
    data class State(
        val phase: PairingViewModel.GooglePhase = PairingViewModel.GooglePhase.Idle,
        val code: String? = null,
        val host: String? = null,
        val compared: Boolean = false,
        val error: String? = null,
        val approved: Boolean = false,
    )
    private var state = State()
    private var generation = 0L
    private var job: Job? = null
    private var client: GooglePairingAttempt? = null
    private fun publish(value: State) { state = value; changed(value) }
    private fun active(id: Long) = generation == id

    fun start(context: Context) {
        if (state.phase !in listOf(PairingViewModel.GooglePhase.Idle, PairingViewModel.GooglePhase.Failed)) return
        cancel()
        val id = generation
        publish(State(PairingViewModel.GooglePhase.SigningIn))
        job = scope.launch {
            try {
                val challenge = CloudPairingChallenge.create("Omnesis Android")
                val token = acquireToken(context, challenge.nonce)
                if (!active(id)) return@launch
                require(token.isNotBlank() && token.length <= 16_384)
                publish(state.copy(phase = PairingViewModel.GooglePhase.Finding))
                val attempt = createClient()
                client = attempt
                attempt.start(challenge, token)
                if (!active(id)) return@launch
                publish(State(PairingViewModel.GooglePhase.Comparing, attempt.code, attempt.host, approved = attempt.approved))
                while (!attempt.approved) {
                    delay(2000)
                    attempt.poll()
                    if (!active(id)) return@launch
                }
                publish(state.copy(approved = true, phase = if (state.compared) PairingViewModel.GooglePhase.Ready else PairingViewModel.GooglePhase.Comparing))
            } catch (_: CancellationException) { if (active(id)) cancel() }
            catch (_: Exception) {
                if (active(id)) fail("Could not pair securely. Check the gateway and try again, or scan its QR code.")
            }
        }
    }

    fun compare() {
        val attempt = client ?: return
        if (state.phase !in listOf(PairingViewModel.GooglePhase.Comparing, PairingViewModel.GooglePhase.Waiting, PairingViewModel.GooglePhase.Ready)) return
        attempt.compare()
        publish(state.copy(compared = true, phase = if (attempt.approved) PairingViewModel.GooglePhase.Ready else PairingViewModel.GooglePhase.Waiting))
    }

    fun finish() {
        val attempt = client ?: return
        if (state.phase != PairingViewModel.GooglePhase.Ready || !state.compared) return
        val id = generation
        publish(state.copy(phase = PairingViewModel.GooglePhase.Pairing))
        job = scope.launch {
            try {
                applyPairing(attempt.payload())
                if (active(id)) cancel()
            } catch (_: CancellationException) { if (active(id)) cancel() }
            catch (_: Exception) {
                if (active(id)) fail("Pairing did not complete. Start again to verify the gateway code.")
            }
        }
    }

    private fun fail(message: String) {
        client?.close(); client = null
        publish(State(PairingViewModel.GooglePhase.Failed, error = message))
    }
    fun cancel() {
        generation++
        job?.cancel(); job = null
        client?.close(); client = null
        publish(State())
    }
}
