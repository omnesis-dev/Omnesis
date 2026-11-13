// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import dev.omnesis.android.pairing.AccountCloudPairingClient
import dev.omnesis.android.pairing.CloudPairingChallenge
import dev.omnesis.android.pairing.CloudPairingConfirmation
import dev.omnesis.android.pairing.CloudPairingException
import java.net.URI

internal class AccountPairingSession(private val client: AccountCloudPairingClient) : AccountPairingAttempt {
    private lateinit var pending: CloudPairingConfirmation
    override suspend fun begin(challenge: CloudPairingChallenge) = client.begin(challenge)
    override suspend fun google(token: String) = client.google(token)
    override suspend fun passkeyOptions() = client.passkeyOptions()
    override suspend fun passkey(options: AccountCloudPairingClient.PasskeyOptions, assertion: String) = client.passkey(options, assertion)
    override suspend fun select(gatewayId: String) { pending = client.select(gatewayId) }
    override val code get() = pending.verificationCode ?: throw CloudPairingException()
    override val host get() = URI(pending.origin).host
    override val approved get() = pending.approved
    override val joined get() = pending.joined
    override val retryUntilMillis get() = client.retryUntilMillis
    override suspend fun poll() = client.poll(pending)
    override fun compare() = pending.confirmComparison()
    override fun payload() = pending.pairingPayload()
    override fun close() = client.close()
}
