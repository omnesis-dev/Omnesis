// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos.setup

import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import dev.omnesis.android.feature.photos.PhotosAccess
import dev.omnesis.android.feature.photos.PhotosIntegration
import dev.omnesis.android.feature.photos.PhotosSessionProvider
import dev.omnesis.android.feature.photos.PhotosSettings
import dev.omnesis.android.feature.photos.photosPermissionsToRequest
import dev.omnesis.android.feature.photos.photosRequestGrantsPrimaryAccess
import dev.omnesis.android.feature.photos.requiredPhotosPermission
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

/** How a Photos enable reads once the grant is known: a selection is its own outcome, not a failure. */
fun photosSetupOutcome(access: PhotosAccess): SetupOutcome = when (access) {
    PhotosAccess.FULL -> SetupOutcome.On
    PhotosAccess.LIMITED -> SetupOutcome.Limited
    PhotosAccess.DENIED -> SetupOutcome.NotAllowed
}

/**
 * The Photos page of the phone setup flow, and the only way Photos is turned
 * on: its Settings card opens this page too.
 */
@Singleton
class PhotosSetupStep @Inject constructor(
    private val integration: PhotosIntegration,
    private val settings: PhotosSettings,
    private val sessions: PhotosSessionProvider,
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
        isGranted = { integration.access() != PhotosAccess.DENIED },
        // A selection still shows Android's prompt, where the user can choose to allow every photo.
        grantedWithoutAsking = { integration.access() == PhotosAccess.FULL },
        outcomeAfterEnable = { photosSetupOutcome(integration.access()) },
        choiceOptions = hostedSourceChoices(PhotosSetupCopy.name),
    )

    override val id: String = integration.sourceId
    override val order: Int = 30
    override val group: SetupGroup = SetupGroup.SOURCE
    override val sourceId: String = integration.sourceId
    override val copy = PhotosSetupCopy
    override val illustration: (@Composable () -> Unit) = { PhotosSetupIllustration() }
    override val outcomes: Flow<SetupOutcome?> = sequence.outcomes

    override fun availability(): SetupAvailability = SetupAvailability.Available

    override fun isOn(): Boolean = settings.photosEnabled

    override suspend fun refreshOutcome(previous: SetupOutcome): SetupOutcome? =
        if (isOn()) photosSetupOutcome(integration.access()) else previous

    override fun notNow() = sequence.notNow()

    override fun resume() = sequence.onResume()

    override fun reset() = sequence.reset()

    @Composable
    override fun rememberController(): SetupStepController {
        val launcher = rememberPermissionLauncher(
            permissions = { photosPermissionsToRequest() },
            rationalePermission = remember { requiredPhotosPermission() },
            accessGranted = { grants -> photosRequestGrantsPrimaryAccess(Build.VERSION.SDK_INT, grants) },
            onAnswer = { granted, permanentlyDenied ->
                settings.recordPermissionResult(granted, permanentlyDenied)
                sequence.onAccessResult(granted)
            },
        )
        // "Add more photos": Android offers the selection again, and the outcome follows what it now allows.
        return rememberSourceSetupController(sequence, launcher, secondaryAction = sequence::requestMoreAccess)
    }

    /** The local half, once the gateway accepted this phone; its first sync belongs to the current session. */
    private suspend fun optIn() {
        checkNotNull(sessions.coordinator()) { "Pair this phone before enabling Photos" }
        checkNotNull(sessions.deviceId()) { "Re-pair this phone before enabling Photos" }
        integration.optIn(membership)
        val coordinator = sessions.coordinator()
        val sessionScope = sessionScopes.current()
        if (coordinator != null && sessionScope != null) integration.launchInitialSync(coordinator, sessionScope)
        // Newly contributing: a source the gateway did not know before is reported again.
        permissionHealth.resetReporting()
        permissionHealth.refresh()
    }
}
