// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.distribution

import androidx.compose.runtime.Composable
import dev.omnesis.android.transport.DeliveryReporter
import dev.omnesis.android.transport.client.AnalyticsClient
import dev.omnesis.android.transport.client.DocumentsClient
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.serialization.json.JsonObject

@Singleton
class DistributionSourceIntegration @Inject constructor() {
    fun buildSession(
        @Suppress("UNUSED_PARAMETER") analytics: AnalyticsClient,
        @Suppress("UNUSED_PARAMETER") documents: DocumentsClient,
        @Suppress("UNUSED_PARAMETER") sendEvent: (String, JsonObject) -> Unit,
    ): DistributionSourceSession = PlayDistributionSourceSession
}

private object PlayDistributionSourceSession : DistributionSourceSession {
    override val deliveryReporters: List<DeliveryReporter> = emptyList()

    override fun handleCommand(type: String, payload: JsonObject, scope: CoroutineScope): Boolean = false

    override fun launchInitialSync(scope: CoroutineScope) = Unit
}

@Composable
fun DistributionSettingsSection() = Unit
