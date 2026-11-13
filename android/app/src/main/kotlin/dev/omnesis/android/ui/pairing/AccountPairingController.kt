// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import android.content.Context
import dev.omnesis.android.pairing.AccountCloudPairingClient
import dev.omnesis.android.pairing.AccountGatewayChoice
import dev.omnesis.android.pairing.AccountPairingException
import dev.omnesis.android.pairing.CloudPairingChallenge
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The native provider supplies the sign-in; the gateway decides whether the device joins or waits for a person. */
enum class AccountPairingPhase { Idle, Connecting, SigningIn, Finding, Choosing, WaitingForGateway, Comparing, Pairing, Failed }
data class AccountPairingState(
    val phase: AccountPairingPhase = AccountPairingPhase.Idle,
    val gateways: List<AccountGatewayChoice> = emptyList(),
    val code: String? = null,
    val host: String? = null,
    val approved: Boolean = false,
    /** The gateway joined this device on its own checks, so there is no code to compare. */
    val joined: Boolean = false,
    val error: String? = null,
    /** An explanation that is not a failure, such as a passkey prompt that found no passkey. */
    val notice: String? = null,
)

/** The person closed the system sign-in dialog. Nothing went wrong, so the choices return without a message. */
internal class AccountSignInDismissed : Exception("sign-in dismissed")

/**
 * Passkey sign-in ended without a passkey. Android reports a phone that holds none and a
 * dismissed prompt separately; both leave the same choices open, so one notice covers them.
 */
internal class AccountNoPasskey : Exception("no passkey used")

/**
 * The phone's passkey provider refused or failed the request after it started, for example when
 * Google Play services cannot validate the relay as the passkey's site. The network was not involved.
 */
internal class AccountPasskeyUnavailable : Exception("passkey provider failed")

internal const val ACCOUNT_PAIRING_PASSKEY_UNAVAILABLE_MESSAGE =
    "Couldn't use your passkey on this phone. Try Sign in with Google, or pair directly with a QR code."

internal const val ACCOUNT_PAIRING_NO_PASSKEY_NOTICE =
    "No passkey was used. If this phone has no passkey for your Omnesis account, sign in with Google, " +
        "or add a passkey to your Omnesis account first."

/** Shown when the sign-in worked and the relay has no Omnesis account for it. */
internal const val ACCOUNT_PAIRING_NO_ACCOUNT_MESSAGE =
    "There is no Omnesis account for this sign-in yet. Create one from your gateway: open its portal, go to Settings, then Account, " +
        "and choose \"Create an Omnesis account\". You can also pair directly with a QR code."

internal const val ACCOUNT_PAIRING_NO_GATEWAYS_MESSAGE =
    "This Omnesis account has no gateway yet. Connect your gateway to it first, or pair directly with a QR code."
internal const val ACCOUNT_PAIRING_NOT_YOUR_GATEWAY_MESSAGE =
    "This doesn't look like your gateway. Nothing was saved. Try again, or pair directly with a QR code."
internal const val ACCOUNT_PAIRING_UPDATE_MESSAGE =
    "Your gateway needs an update before this device can sign in. Update Omnesis on your gateway, then try again."
internal const val ACCOUNT_PAIRING_EXPIRED_MESSAGE = "Your sign-in expired. Sign in again to connect this device."
internal const val ACCOUNT_PAIRING_FAILED_MESSAGE =
    "Couldn't connect with your Omnesis account. Check your internet connection and try again, or pair directly with a QR code."

internal interface AccountPairingAttempt : AutoCloseable {
    suspend fun begin(challenge: CloudPairingChallenge): String
    suspend fun google(token: String): List<AccountGatewayChoice>
    suspend fun passkeyOptions(): AccountCloudPairingClient.PasskeyOptions
    suspend fun passkey(options: AccountCloudPairingClient.PasskeyOptions, assertion: String): List<AccountGatewayChoice>
    suspend fun select(gatewayId: String)
    val code: String
    val host: String
    val approved: Boolean
    val joined: Boolean
    val retryUntilMillis: Long
    suspend fun poll()
    fun compare()
    fun payload(): String
}

internal class AccountPairingPorts(
    val acquireGoogle: suspend (Context, String) -> String,
    val acquirePasskey: suspend (Context, String) -> String,
    val createClient: () -> AccountPairingAttempt,
    val applyPairing: suspend (String) -> Unit,
    val now: () -> Long = System::currentTimeMillis,
)

internal class AccountPairingController(
    private val scope: CoroutineScope,
    private val ports: AccountPairingPorts,
    private val changed: (AccountPairingState) -> Unit,
) {
    enum class Method { Google, Passkey }
    private var state = AccountPairingState()
    private var generation = 0L
    private var job: Job? = null
    private var client: AccountPairingAttempt? = null
    private fun publish(value: AccountPairingState) { state = value; changed(value) }
    private fun active(id: Long) = id == generation

    fun start(context: Context, method: Method) {
        if (state.phase !in listOf(AccountPairingPhase.Idle, AccountPairingPhase.Failed)) return
        cancel()
        val id = generation
        publish(AccountPairingState(AccountPairingPhase.Connecting))
        job = scope.launch {
            try {
                val attempt = ports.createClient(); client = attempt
                val nonce = attempt.begin(CloudPairingChallenge.create("Omnesis Android"))
                if (!active(id)) return@launch
                publish(state.copy(phase = AccountPairingPhase.SigningIn))
                val choices = when (method) {
                    Method.Google -> {
                        val token = ports.acquireGoogle(context, nonce)
                        if (!active(id)) return@launch
                        require(token.isNotBlank() && token.length <= 16_384)
                        publish(state.copy(phase = AccountPairingPhase.Finding))
                        attempt.google(token)
                    }
                    Method.Passkey -> {
                        val options = attempt.passkeyOptions()
                        if (!active(id)) return@launch
                        val assertion = ports.acquirePasskey(context, options.options)
                        if (!active(id)) return@launch
                        publish(state.copy(phase = AccountPairingPhase.Finding))
                        attempt.passkey(options, assertion)
                    }
                }
                if (!active(id)) return@launch
                // With one gateway there is nothing to choose.
                val only = choices.singleOrNull()
                if (only != null) enroll(id, attempt, only.gatewayId)
                else publish(AccountPairingState(AccountPairingPhase.Choosing, gateways = choices))
            } catch (_: CancellationException) { if (active(id)) cancel() }
            catch (error: Exception) { if (active(id)) fail(error) }
        }
    }
    fun choose(gatewayId: String) {
        val attempt = client ?: return
        if (state.phase != AccountPairingPhase.Choosing || state.gateways.none { it.gatewayId == gatewayId }) return
        val id = generation
        publish(state.copy(phase = AccountPairingPhase.Connecting))
        job = scope.launch {
            try { enroll(id, attempt, gatewayId) }
            catch (_: CancellationException) { if (active(id)) cancel() }
            catch (error: Exception) { if (active(id)) fail(error) }
        }
    }

    private suspend fun enroll(id: Long, attempt: AccountPairingAttempt, gatewayId: String) {
        publish(state.copy(phase = AccountPairingPhase.Connecting))
        selectWhenOnline(id, attempt, gatewayId)
        if (!active(id)) return
        if (attempt.joined) {
            publish(AccountPairingState(AccountPairingPhase.Pairing, host = attempt.host, approved = true, joined = true))
            attempt.compare()
            ports.applyPairing(attempt.payload())
            if (active(id)) cancel()
            return
        }
        publish(AccountPairingState(AccountPairingPhase.Comparing, code = attempt.code, host = attempt.host, approved = attempt.approved))
        while (!attempt.approved) {
            delay(2000); attempt.poll()
            if (!active(id)) return
        }
        publish(state.copy(approved = true))
    }

    /** Keeps the sign-in alive through a gateway outage for as long as the gateway could still accept it. */
    private suspend fun selectWhenOnline(id: Long, attempt: AccountPairingAttempt, gatewayId: String) {
        var wait = FIRST_RETRY_MILLIS
        while (true) {
            try {
                attempt.select(gatewayId)
                return
            } catch (error: AccountPairingException) {
                if (error.reason != AccountPairingException.Reason.GATEWAY_OFFLINE) throw error
            }
            if (!active(id)) return
            val remaining = attempt.retryUntilMillis - ports.now()
            if (remaining <= 0) throw AccountPairingException(AccountPairingException.Reason.EXPIRED)
            publish(state.copy(phase = AccountPairingPhase.WaitingForGateway))
            delay(minOf(wait, remaining))
            if (!active(id)) return
            wait = minOf(wait * 2, LAST_RETRY_MILLIS)
        }
    }

    fun finish() {
        val attempt = client ?: return
        if (state.phase != AccountPairingPhase.Comparing || !state.approved || !attempt.approved) return
        val id = generation
        publish(state.copy(phase = AccountPairingPhase.Pairing))
        job = scope.launch {
            try {
                attempt.compare()
                ports.applyPairing(attempt.payload())
                if (active(id)) cancel()
            } catch (_: CancellationException) { if (active(id)) cancel() }
            catch (error: Exception) { if (active(id)) fail(error) }
        }
    }
    fun cancel() {
        generation++; job?.cancel(); job = null; client?.close(); client = null
        publish(AccountPairingState())
    }
    private fun fail(error: Exception) {
        if (error is AccountSignInDismissed) return cancel()
        if (error is AccountNoPasskey) {
            client?.close(); client = null
            return publish(AccountPairingState(AccountPairingPhase.Failed, notice = ACCOUNT_PAIRING_NO_PASSKEY_NOTICE))
        }
        val message = if (error is AccountPasskeyUnavailable) ACCOUNT_PAIRING_PASSKEY_UNAVAILABLE_MESSAGE
        else when ((error as? AccountPairingException)?.reason) {
            AccountPairingException.Reason.NO_ACCOUNT -> ACCOUNT_PAIRING_NO_ACCOUNT_MESSAGE
            AccountPairingException.Reason.NO_GATEWAYS -> ACCOUNT_PAIRING_NO_GATEWAYS_MESSAGE
            AccountPairingException.Reason.NOT_YOUR_GATEWAY -> ACCOUNT_PAIRING_NOT_YOUR_GATEWAY_MESSAGE
            AccountPairingException.Reason.GATEWAY_UPDATE_REQUIRED -> ACCOUNT_PAIRING_UPDATE_MESSAGE
            AccountPairingException.Reason.EXPIRED -> ACCOUNT_PAIRING_EXPIRED_MESSAGE
            else -> ACCOUNT_PAIRING_FAILED_MESSAGE
        }
        client?.close(); client = null
        publish(AccountPairingState(AccountPairingPhase.Failed, error = message))
    }

    private companion object {
        const val FIRST_RETRY_MILLIS = 2_000L
        const val LAST_RETRY_MILLIS = 30_000L
    }
}
