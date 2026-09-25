// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.phonesetup

import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.core.content.IntentCompat
import androidx.core.content.PackageManagerCompat
import androidx.core.content.UnusedAppRestrictionsConstants
import dagger.hilt.android.qualifiers.ApplicationContext
import dev.omnesis.android.setup.PhoneSetupStep
import dev.omnesis.android.setup.SetupHighlight
import dev.omnesis.android.setup.SetupStepController
import dev.omnesis.android.setup.SetupStepCopy
import dev.omnesis.android.setup.flow.SetupAccessKind
import dev.omnesis.android.setup.flow.SetupAvailability
import dev.omnesis.android.setup.flow.SetupGroup
import dev.omnesis.android.setup.flow.SetupOutcome
import dev.omnesis.android.setup.flow.SourceEnableActions
import dev.omnesis.android.setup.flow.SourceEnableSequence
import dev.omnesis.android.setup.ui.rememberSourceSetupController
import dev.omnesis.android.setup.ui.rememberSystemScreenLauncher
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

val BackgroundSyncingSetupCopy = SetupStepCopy(
    name = "Background syncing",
    glyph = Icons.Outlined.Sync,
    tint = Color(0xFF5E5CE6),
    row = "Keep contributing when unused",
    value = "Android pauses apps you haven't opened for a few months and removes their permissions. " +
        "Turn that off for Omnesis so this phone keeps contributing.",
    highlights = listOf(
        SetupHighlight(Icons.Outlined.VerifiedUser, "Keeps permissions granted"),
        SetupHighlight(Icons.Outlined.Sync, "Keeps syncs running"),
    ),
    primaryLabel = "Agree & open settings",
    permissionLabel = "background syncing",
    onTitle = "Background syncing is on",
    onBody = "Android won't pause Omnesis or remove its permissions when you don't open it for a while.",
    offTitle = "Background syncing is still limited",
    offBody = "You can change this in Settings any time.",
    workingLabel = "Checking…",
)

/**
 * Where Android's unused-app restriction is switched off, in the words the
 * running version shows: Android 12's Pause app activity, or the App
 * permissions toggle on Android 11 and in the Play services backport on 6–10.
 */
fun backgroundSyncingSettingsSteps(sdkInt: Int = Build.VERSION.SDK_INT): String =
    if (sdkInt >= Build.VERSION_CODES.S) PAUSE_APP_ACTIVITY_STEPS else REMOVE_PERMISSIONS_STEPS

/** The Background syncing page for the running Android version, naming its setting before and after the round trip. */
fun backgroundSyncingSetupCopy(sdkInt: Int = Build.VERSION.SDK_INT): SetupStepCopy {
    val steps = backgroundSyncingSettingsSteps(sdkInt)
    return BackgroundSyncingSetupCopy.copy(fine = steps, settingsSteps = steps)
}

private const val REMOVE_PERMISSIONS_STEPS = "In App permissions, turn off Remove permissions if app isn't used."
private const val PAUSE_APP_ACTIVITY_STEPS = "Turn off Pause app activity if unused."

/** Whether Android's unused-app restrictions currently apply to this app. */
enum class BackgroundSyncingState { ON, LIMITED }

/** Maps the restriction status to what Settings and the flow show; null when the phone has no such restriction. */
fun backgroundSyncingState(status: Int?): BackgroundSyncingState? = when (status) {
    UnusedAppRestrictionsConstants.API_30_BACKPORT,
    UnusedAppRestrictionsConstants.API_30,
    UnusedAppRestrictionsConstants.API_31,
    -> BackgroundSyncingState.LIMITED
    UnusedAppRestrictionsConstants.DISABLED -> BackgroundSyncingState.ON
    else -> null
}

/** How a resolved Background syncing page reads once the restriction is known again; a declined page stays declined while it applies. */
internal fun backgroundSyncingRefreshedOutcome(previous: SetupOutcome, state: BackgroundSyncingState?): SetupOutcome = when (state) {
    BackgroundSyncingState.ON -> SetupOutcome.On
    BackgroundSyncingState.LIMITED -> if (previous == SetupOutcome.Skipped) previous else SetupOutcome.NotAllowed
    null -> previous
}

/**
 * Reads Android's unused-app restrictions for this app. The platform answers
 * asynchronously, so the last answer is kept for the synchronous readers of
 * the flow and Settings, and refreshed on every resume.
 */
@Singleton
class UnusedAppRestrictionsReader @Inject constructor(@ApplicationContext private val context: Context) {
    private val _status = MutableStateFlow<Int?>(null)
    val status: StateFlow<Int?> = _status.asStateFlow()

    suspend fun refresh(): Int? {
        val status = withContext(Dispatchers.IO) {
            try {
                PackageManagerCompat.getUnusedAppRestrictionsStatus(context).get(STATUS_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                null
            }
        }
        _status.value = status
        return status
    }

    /** The system screen where "Pause app activity if unused" is switched for this app. */
    fun manageIntent(): Intent = IntentCompat.createManageUnusedAppRestrictionsIntent(context, context.packageName)

    private companion object {
        const val STATUS_TIMEOUT_SECONDS = 5L
    }
}

/**
 * The Background syncing page of the phone setup flow, offered only while
 * Android's unused-app restrictions apply to Omnesis. The system screen that
 * lifts them gives no answer, so the restriction is read again on return.
 */
@Singleton
class BackgroundSyncingSetupStep @Inject constructor(
    private val restrictions: UnusedAppRestrictionsReader,
) : PhoneSetupStep {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    internal val sequence = SourceEnableSequence(
        scope = scope,
        actions = SourceEnableActions.Local,
        isOn = ::isOn,
        isGranted = { backgroundSyncingState(restrictions.refresh()) == BackgroundSyncingState.ON },
        outcomeAfterEnable = { SetupOutcome.On },
        accessKind = { SetupAccessKind.ROUND_TRIP },
    )

    override val id: String = "background-syncing"
    override val order: Int = 110
    override val group: SetupGroup = SetupGroup.ALSO
    override val sourceId: String? = null
    override val copy: SetupStepCopy = backgroundSyncingSetupCopy()
    override val outcomes: Flow<SetupOutcome?> = sequence.outcomes

    override suspend fun refresh() {
        restrictions.refresh()
    }

    override fun availability(): SetupAvailability =
        if (backgroundSyncingState(restrictions.status.value) == BackgroundSyncingState.LIMITED) {
            SetupAvailability.Available
        } else {
            SetupAvailability.Hidden
        }

    /** Never shown as already on: the page is offered only while the restriction applies. */
    override fun isOn(): Boolean = false

    override suspend fun refreshOutcome(previous: SetupOutcome): SetupOutcome? =
        backgroundSyncingRefreshedOutcome(previous, backgroundSyncingState(restrictions.status.value))

    override fun notNow() = sequence.notNow()

    override fun resume() = sequence.onResume()

    override fun reset() = sequence.reset()

    @Composable
    override fun rememberController(): SetupStepController {
        // Android documents this screen as started for a result; its return is when the restriction is read.
        val launcher = rememberSystemScreenLauncher(
            screenIntent = { restrictions.manageIntent() },
            onFailed = { sequence.onLaunchFailed() },
            onReturned = { sequence.onResume() },
        )
        return rememberSourceSetupController(sequence, launcher)
    }
}
