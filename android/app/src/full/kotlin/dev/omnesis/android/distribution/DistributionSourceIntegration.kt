// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.distribution

import androidx.compose.runtime.Composable
import dev.omnesis.android.feature.calllog.CallLogIntegration
import dev.omnesis.android.feature.calllog.CallLogSessionProvider
import dev.omnesis.android.feature.calllog.CallLogSyncCoordinator
import dev.omnesis.android.feature.calllog.ui.CallLogSettingsSection
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.DeliveryReporter
import dev.omnesis.android.transport.client.AnalyticsClient
import dev.omnesis.android.transport.client.DocumentsClient
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.serialization.json.JsonObject

@Singleton
class DistributionSourceIntegration @Inject constructor(
    private val callLog: CallLogIntegration,
) {
    fun buildSession(
        analytics: AnalyticsClient,
        documents: DocumentsClient,
        sendEvent: (String, JsonObject) -> Unit,
    ): DistributionSourceSession = FullDistributionSourceSession(
        coordinator = callLog.buildCoordinator(analytics, documents, sendEvent),
        integration = callLog,
    )
}

class FullDistributionSourceSession(
    val coordinator: CallLogSyncCoordinator,
    private val integration: CallLogIntegration,
) : DistributionSourceSession {
    override val deliveryReporters: List<DeliveryReporter> = listOf(coordinator)

    override fun handleCommand(type: String, payload: JsonObject, scope: CoroutineScope): Boolean =
        integration.handleCommand(coordinator, type, payload, scope)

    override fun launchInitialSync(scope: CoroutineScope) =
        integration.launchInitialSync(coordinator, scope)
}

@Composable
fun DistributionSettingsSection() {
    CallLogSettingsSection()
}

/** Full-flavor worker access to the current per-session coordinator. */
@Module
@InstallIn(SingletonComponent::class)
object CallLogSyncModule {
    @Provides
    fun provideCallLogSessionProvider(sessionManager: SessionManager): CallLogSessionProvider =
        object : CallLogSessionProvider {
            override fun coordinator(): CallLogSyncCoordinator? =
                (sessionManager.session?.distribution as? FullDistributionSourceSession)?.coordinator

            override fun deviceId(): String? = sessionManager.session?.pairing?.deviceId
        }
}
