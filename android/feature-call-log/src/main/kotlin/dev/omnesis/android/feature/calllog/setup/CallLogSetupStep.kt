// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog.setup

import android.Manifest
import androidx.compose.runtime.Composable
import dev.omnesis.android.feature.calllog.CallLogIntegration
import dev.omnesis.android.feature.calllog.CallLogSessionProvider
import dev.omnesis.android.feature.calllog.CallLogSettings
import dev.omnesis.android.setup.PhoneSetupStep
import dev.omnesis.android.setup.SetupStepController
import dev.omnesis.android.setup.flow.HostedSourceEnableActions
import dev.omnesis.android.setup.flow.SetupAvailability
import dev.omnesis.android.setup.flow.SetupGroup
import dev.omnesis.android.setup.flow.SetupOutcome
import dev.omnesis.android.setup.flow.SourceEnableSequence
import dev.omnesis.android.setup.flow.hostedSourceChoices
import dev.omnesis.android.setup.ui.rememberPermissionLauncher
import dev.omnesis.android.setup.ui.rememberSourceSetupController
import dev.omnesis.android.transport.PermissionHealthCoordinator
import dev.omnesis.android.transport.SessionScopeProvider
import dev.omnesis.android.transport.SourceMembership
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow

/** How a Call Log enable reads once Android answered the READ_CALL_LOG request. */
fun callLogSetupOutcome(granted: Boolean): SetupOutcome =
    if (granted) SetupOutcome.On else SetupOutcome.NotAllowed

/**
 * The Call Log page of the phone setup flow, and the only way Call Log is
 * turned on: its Settings card opens this page too.
 */
@Singleton
class CallLogSetupStep @Inject constructor(
    private val integration: CallLogIntegration,
    private val settings: CallLogSettings,
    private val sessions: CallLogSessionProvider,
    private val membership: SourceMembership,
    private val permissionHealth: PermissionHealthCoordinator,
    private val sessionScopes: SessionScopeProvider,
) : PhoneSetupStep {
    /** Outlives any page, so an enable under way finishes after the user moves on. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    internal val actions = HostedSourceEnableActions(
        membership = membership,
        sourceId = integration.sourceId,
        mode = integration.hostedSourceContract.multiDeviceMode,
        optIn = { optIn() },
        sessionGeneration = { sessionScopes.generation },
    )

    internal val sequence = SourceEnableSequence(
        scope = scope,
        actions = actions,
        isOn = ::isOn,
        isGranted = { integration.hasPermission() },
        outcomeAfterEnable = { callLogSetupOutcome(integration.hasPermission()) },
        choiceOptions = hostedSourceChoices(CallLogSetupCopy.name),
    )

    override val id: String = integration.sourceId
    override val order: Int = 50
    override val group: SetupGroup = SetupGroup.SOURCE
    override val sourceId: String = integration.sourceId
    override val copy = CallLogSetupCopy
    override val outcomes: Flow<SetupOutcome?> = sequence.outcomes

    override fun availability(): SetupAvailability = SetupAvailability.Available

    override fun isOn(): Boolean = settings.callLogEnabled

    override suspend fun refreshOutcome(previous: SetupOutcome): SetupOutcome? =
        if (isOn()) callLogSetupOutcome(integration.hasPermission()) else previous

    override fun notNow() = sequence.notNow()

    override fun resume() = sequence.onResume()

    override fun reset() = sequence.reset()

    @Composable
    override fun rememberController(): SetupStepController {
        val launcher = rememberPermissionLauncher(
            permissions = { arrayOf(Manifest.permission.READ_CALL_LOG) },
            rationalePermission = Manifest.permission.READ_CALL_LOG,
            accessGranted = { grants -> grants[Manifest.permission.READ_CALL_LOG] == true },
            onAnswer = { granted, permanentlyDenied ->
                settings.recordPermissionResult(granted, permanentlyDenied)
                sequence.onAccessResult(granted)
            },
        )
        return rememberSourceSetupController(sequence, launcher)
    }

    /** The local half, once the gateway accepted this phone; its first sync belongs to the current session. */
    private fun optIn() {
        integration.optIn(membership) {
            val coordinator = sessions.coordinator()
            val sessionScope = sessionScopes.current()
            if (coordinator != null && sessionScope != null) integration.launchInitialSync(coordinator, sessionScope)
        }
        // Newly contributing: a source the gateway did not know before is reported again.
        permissionHealth.resetReporting()
        permissionHealth.refresh()
    }
}
