// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import dev.omnesis.android.pairing.CloudPairingChallenge
import dev.omnesis.android.pairing.CloudPairingConfirmation
import dev.omnesis.android.pairing.GoogleCloudPairingClient
import java.net.URI

internal class GooglePairingSession(private val client: GoogleCloudPairingClient) : GooglePairingAttempt {
    constructor(relay: String, clientId: String, presenters: Set<String>) :
        this(GoogleCloudPairingClient(relay, clientId, presenterClientIds = presenters))
    private lateinit var pending: CloudPairingConfirmation
    override suspend fun start(challenge: CloudPairingChallenge, token: String) { pending = client.start(challenge, token) }
    override val code get() = pending.verificationCode
    override val host get() = URI(pending.origin).host
    override val approved get() = pending.approved
    override suspend fun poll() = client.poll(pending)
    override fun compare() = pending.confirmComparison()
    override fun payload() = pending.pairingPayload()
    override fun close() = client.close()
}
