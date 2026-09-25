// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage.setup

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.runtime.Composable
import dev.omnesis.android.feature.appusage.AppUsageIntegration
import dev.omnesis.android.feature.appusage.AppUsageSessionProvider
import dev.omnesis.android.feature.appusage.AppUsageSettings
import dev.omnesis.android.setup.PhoneSetupStep
import dev.omnesis.android.setup.SetupStepController
import dev.omnesis.android.setup.flow.ExplicitEnableMemory
import dev.omnesis.android.setup.flow.HostedSourceEnableActions
import dev.omnesis.android.setup.flow.SetupAccessKind
import dev.omnesis.android.setup.flow.SetupAvailability
import dev.omnesis.android.setup.flow.SetupGroup
import dev.omnesis.android.setup.flow.SetupOutcome
import dev.omnesis.android.setup.flow.SourceEnableSequence
import dev.omnesis.android.setup.flow.hostedSourceChoices
import dev.omnesis.android.setup.ui.rememberSourceSetupController
import dev.omnesis.android.setup.ui.rememberSystemScreenLauncher
import dev.omnesis.android.setup.ui.startActivitySafely
import dev.omnesis.android.transport.ActivationChoice
import dev.omnesis.android.transport.PermissionHealthCoordinator
import dev.omnesis.android.transport.SessionScopeProvider
import dev.omnesis.android.transport.SourceMembership
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow

/** How an App Usage enable reads once the grant is known. */
fun appUsageSetupOutcome(granted: Boolean): SetupOutcome =
    if (granted) SetupOutcome.On else SetupOutcome.NotAllowed

/**
 * The App Usage page of the phone setup flow, and the only way App Usage is
 * turned on: its Settings card opens this page too.
 *
 * Usage access is granted on a system screen that returns no answer, so the
 * grant is read when the app resumes. A grant alone never turns App Usage on:
 * only one the user agreed to on this page does, which is why the agreement
 * is persisted — it lets an enable the user started complete even when the
 * app was restarted while they were on the usage-access screen.
 */
@Singleton
class AppUsageSetupStep internal constructor(
    private val integration: AppUsageIntegration,
    private val settings: AppUsageSettings,
    private val sessions: AppUsageSessionProvider,
    private val membership: SourceMembership,
    private val permissionHealth: PermissionHealthCoordinator,
    private val sessionScopes: SessionScopeProvider,
    private val hasUsageAccess: () -> Boolean,
) : PhoneSetupStep {
    @Inject
    constructor(
        integration: AppUsageIntegration,
        settings: AppUsageSettings,
        sessions: AppUsageSessionProvider,
        membership: SourceMembership,
        permissionHealth: PermissionHealthCoordinator,
        sessionScopes: SessionScopeProvider,
    ) : this(integration, settings, sessions, membership, permissionHealth, sessionScopes, integration::hasUsageAccess)

    /** Outlives any page, so an enable under way finishes after the user moves on. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    internal val actions = HostedSourceEnableActions(
        membership = membership,
        sourceId = integration.sourceId,
        mode = integration.hostedSourceContract.multiDeviceMode,
        optIn = { optIn() },
        sessionGeneration = { sessionScopes.generation },
    )

    private val agreement = object : ExplicitEnableMemory {
        override var pending: Boolean
            get() = settings.explicitEnablePending
            set(value) {
                settings.explicitEnablePending = value
            }
        override var choice: ActivationChoice?
            get() = settings.explicitEnableChoice?.let { name -> ActivationChoice.entries.firstOrNull { it.name == name } }
            set(value) {
                settings.explicitEnableChoice = value?.name
            }
    }

    internal val sequence = SourceEnableSequence(
        scope = scope,
        actions = actions,
        isOn = ::isOn,
        isGranted = { hasUsageAccess() },
        outcomeAfterEnable = { appUsageSetupOutcome(hasUsageAccess()) },
        accessKind = { SetupAccessKind.ROUND_TRIP },
        memory = agreement,
        choiceOptions = hostedSourceChoices(AppUsageSetupCopy.name),
    )

    override val id: String = integration.sourceId
    override val order: Int = 40
    override val group: SetupGroup = SetupGroup.SOURCE
    override val sourceId: String = integration.sourceId
    override val copy = AppUsageSetupCopy
    override val outcomes: Flow<SetupOutcome?> = sequence.outcomes

    override fun availability(): SetupAvailability = SetupAvailability.Available

    override fun isOn(): Boolean = settings.appUsageEnabled

    override suspend fun refreshOutcome(previous: SetupOutcome): SetupOutcome? =
        if (isOn()) appUsageSetupOutcome(hasUsageAccess()) else previous

    override fun notNow() = sequence.notNow()

    override fun resume() = sequence.onResume()

    override fun reset() = sequence.reset()

    @Composable
    override fun rememberController(): SetupStepController {
        val launcher = rememberSystemScreenLauncher(
            screenIntent = ::usageAccessSettingsIntent,
            onFailed = sequence::onLaunchFailed,
            onReturned = sequence::onResume,
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

/**
 * `ACTION_USAGE_ACCESS_SETTINGS` is the only entry point for this grant — there
 * is no request dialog. Attaching a `package:` data URI deep-links straight to
 * this app's row on OEMs that support it; on others it just opens the full
 * list, which is still a correct fallback.
 */
fun usageAccessSettingsIntent(context: Context): Intent =
    Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).apply {
        data = Uri.fromParts("package", context.packageName, null)
    }

/** Opens the usage-access screen; false when the phone has none or refuses to open it. */
fun openUsageAccessSettings(context: Context): Boolean = startActivitySafely(context, usageAccessSettingsIntent(context))
