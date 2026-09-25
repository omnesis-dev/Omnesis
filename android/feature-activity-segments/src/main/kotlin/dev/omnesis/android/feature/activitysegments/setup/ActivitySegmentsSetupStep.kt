// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments.setup

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsAvailability
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsIntegration
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsSessionProvider
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsSettings
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
import dev.omnesis.android.setup.ui.startActivitySafely
import dev.omnesis.android.transport.PermissionHealthCoordinator
import dev.omnesis.android.transport.SessionScopeProvider
import dev.omnesis.android.transport.SourceMembership
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow

/**
 * Whether Choose offers Activity Segments. Without a Play services install
 * the user can update, activity can never be detected, so the row says why
 * instead of being selectable.
 */
fun activitySegmentsSetupAvailability(availability: ActivitySegmentsAvailability): SetupAvailability = when (availability) {
    ActivitySegmentsAvailability.NotSupported, ActivitySegmentsAvailability.NotInstalled ->
        SetupAvailability.Disabled("Needs Google Play services")
    ActivitySegmentsAvailability.UpdateRequired, ActivitySegmentsAvailability.Available -> SetupAvailability.Available
}

/**
 * Why an enable cannot ask for physical activity access yet; null once Google
 * Play services can detect activity. Only an update is something the user can
 * do from here, so only that outcome offers an action.
 */
fun activitySegmentsSetupUnavailable(availability: ActivitySegmentsAvailability): SetupOutcome.Unavailable? = when (availability) {
    ActivitySegmentsAvailability.Available -> null
    ActivitySegmentsAvailability.UpdateRequired -> SetupOutcome.Unavailable(
        title = "Google Play services needs an update",
        body = "Update it from the Play Store, then come back.",
        actionLabel = "Update Google Play services",
    )
    ActivitySegmentsAvailability.NotSupported, ActivitySegmentsAvailability.NotInstalled -> SetupOutcome.Unavailable(
        title = "Activity Segments needs Google Play services",
        body = "Google Play services isn't available on this phone.",
        actionLabel = null,
    )
}

/**
 * How an Activity Segments enable reads: Google Play services decides first
 * whether activity can be detected at all, then the physical activity grant.
 */
fun activitySegmentsSetupOutcome(availability: ActivitySegmentsAvailability, granted: Boolean): SetupOutcome =
    activitySegmentsSetupUnavailable(availability) ?: if (granted) SetupOutcome.On else SetupOutcome.NotAllowed

/**
 * The outcome as the phone reads it now. An enabled source follows Play
 * services and the grant; an update that has since landed makes the step
 * unresolved again, so the user can agree once more.
 */
fun activitySegmentsRefreshedOutcome(
    on: Boolean,
    availability: ActivitySegmentsAvailability,
    granted: Boolean,
    previous: SetupOutcome,
): SetupOutcome? = when {
    on -> activitySegmentsSetupOutcome(availability, granted)
    previous is SetupOutcome.Unavailable && availability == ActivitySegmentsAvailability.Available -> null
    else -> previous
}

/**
 * The Activity Segments page of the phone setup flow, and the only way
 * Activity Segments is turned on: its Settings card opens this page too.
 */
@Singleton
class ActivitySegmentsSetupStep @Inject constructor(
    private val integration: ActivitySegmentsIntegration,
    private val settings: ActivitySegmentsSettings,
    private val sessions: ActivitySegmentsSessionProvider,
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
        outcomeAfterEnable = { activitySegmentsSetupOutcome(integration.availability(), integration.hasPermission()) },
        unavailable = { activitySegmentsSetupUnavailable(integration.availability()) },
        choiceOptions = hostedSourceChoices(ActivitySegmentsSetupCopy.name),
    )

    override val id: String = integration.sourceId
    override val order: Int = 20
    override val group: SetupGroup = SetupGroup.SOURCE
    override val sourceId: String = integration.sourceId
    override val copy = ActivitySegmentsSetupCopy
    override val outcomes: Flow<SetupOutcome?> = sequence.outcomes

    override fun availability(): SetupAvailability = activitySegmentsSetupAvailability(integration.availability())

    override fun isOn(): Boolean = settings.activitySegmentsEnabled

    override suspend fun refreshOutcome(previous: SetupOutcome): SetupOutcome? =
        activitySegmentsRefreshedOutcome(isOn(), integration.availability(), integration.hasPermission(), previous)

    override fun notNow() = sequence.notNow()

    override fun resume() = sequence.onResume()

    override fun reset() = sequence.reset()

    @Composable
    override fun rememberController(): SetupStepController {
        val context = LocalContext.current
        // Below API 29 there is no dialog: the permission is granted with the install.
        val launcher = rememberPermissionLauncher(
            permissions = {
                if (Build.VERSION.SDK_INT >= 29) arrayOf(Manifest.permission.ACTIVITY_RECOGNITION) else emptyArray()
            },
            rationalePermission = if (Build.VERSION.SDK_INT >= 29) Manifest.permission.ACTIVITY_RECOGNITION else null,
            accessGranted = { grants -> grants[Manifest.permission.ACTIVITY_RECOGNITION] == true },
            onAnswer = { granted, permanentlyDenied ->
                settings.recordPermissionResult(granted, permanentlyDenied)
                sequence.onAccessResult(granted)
            },
        )
        // "Update Google Play services": the flow re-reads availability when the app comes back.
        return rememberSourceSetupController(sequence, launcher, secondaryAction = { openPlayStoreForGms(context) })
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

/** Opens Google Play services' Play Store listing, or its web listing where the Play Store is absent; false when neither opens. */
fun openPlayStoreForGms(context: Context): Boolean =
    startActivitySafely(context, storeIntent("market://details?id=$GMS_PACKAGE")) ||
        startActivitySafely(context, storeIntent("https://play.google.com/store/apps/details?id=$GMS_PACKAGE"))

private fun storeIntent(uri: String): Intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

private const val GMS_PACKAGE = "com.google.android.gms"
