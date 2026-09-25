// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.phonesetup

import android.Manifest
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.SyncProblem
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import dev.omnesis.android.notifications.FcmPushManager
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.setup.PhoneSetupStep
import dev.omnesis.android.setup.SetupHighlight
import dev.omnesis.android.setup.SetupStepController
import dev.omnesis.android.setup.SetupStepCopy
import dev.omnesis.android.setup.flow.NotificationPermissionState
import dev.omnesis.android.setup.flow.SetupAvailability
import dev.omnesis.android.setup.flow.SetupGroup
import dev.omnesis.android.setup.flow.SetupOutcome
import dev.omnesis.android.setup.flow.SourceEnableActions
import dev.omnesis.android.setup.flow.SourceEnableSequence
import dev.omnesis.android.setup.flow.notificationRow
import dev.omnesis.android.setup.ui.rememberPermissionLauncher
import dev.omnesis.android.setup.ui.rememberSourceSetupController
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch

val NotificationsSetupCopy = SetupStepCopy(
    name = "Notifications",
    glyph = Icons.Outlined.NotificationsActive,
    tint = Color(0xFFFFD60A),
    row = "Answers and approvals",
    value = "Know when a slow answer is ready, when something needs your approval, and when a source stops syncing.",
    highlights = listOf(
        SetupHighlight(Icons.Outlined.AccessTime, "Answers that took a while"),
        SetupHighlight(Icons.Outlined.Shield, "Requests waiting for your approval"),
        SetupHighlight(Icons.Outlined.SyncProblem, "Sources that need attention"),
    ),
    fine = "Android asks next. You can change this in Settings any time.",
    permissionLabel = "notifications",
    onTitle = "Notifications are on",
    onBody = "You'll hear when an answer is ready, when something needs your approval, or when a source needs attention.",
    offTitle = "Notifications are off",
    offBody = "You can turn them on in Settings any time.",
    settingsSteps = "In Settings, turn on notifications for Omnesis.",
    workingLabel = "Turning on notifications…",
)

/** How a resolved Notifications page reads once the grant is known again; a declined page stays declined. */
internal fun notificationsRefreshedOutcome(previous: SetupOutcome, granted: Boolean): SetupOutcome = when {
    previous == SetupOutcome.Skipped -> previous
    granted -> SetupOutcome.On
    else -> SetupOutcome.NotAllowed
}

/**
 * The Notifications page of the phone setup flow: the one place, beside the
 * button in Settings, that asks Android for the notification permission.
 * Offered only by a build that can deliver notifications.
 */
@Singleton
class NotificationsSetupStep @Inject constructor(
    private val pushManager: FcmPushManager,
    private val session: SessionManager,
) : PhoneSetupStep {
    /** Outlives any page, so Android's answer is kept however the page that asked went away. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    internal val sequence = SourceEnableSequence(
        scope = scope,
        actions = SourceEnableActions.Local,
        isOn = ::isOn,
        isGranted = { isOn() },
        outcomeAfterEnable = { if (isOn()) SetupOutcome.On else SetupOutcome.NotAllowed },
    )

    override val id: String = "notifications"
    override val order: Int = 100
    override val group: SetupGroup = SetupGroup.ALSO
    override val sourceId: String? = null
    override val copy = NotificationsSetupCopy
    override val outcomes: Flow<SetupOutcome?> = sequence.outcomes

    override fun availability(): SetupAvailability =
        notificationRow(id, pushManager.notificationPermissionState(), pushManager.configured).availability

    override fun isOn(): Boolean = pushManager.notificationPermissionState() == NotificationPermissionState.GRANTED

    override suspend fun refreshOutcome(previous: SetupOutcome): SetupOutcome? = notificationsRefreshedOutcome(previous, isOn())

    override fun notNow() = sequence.notNow()

    /** Back on this page while it is unresolved: the gateway hears where delivery stands, and a grant made in Settings is read. */
    override fun resume() {
        reportAnswer()
        sequence.onResume()
    }

    override fun reset() = sequence.reset()

    @Composable
    override fun rememberController(): SetupStepController {
        val launcher = rememberPermissionLauncher(
            permissions = {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) arrayOf(Manifest.permission.POST_NOTIFICATIONS) else emptyArray()
            },
            rationalePermission = null,
            accessGranted = { grants -> grants.isNotEmpty() && grants.values.all { it } },
            onAnswer = { granted, _ ->
                pushManager.markNotificationPermissionPrompted()
                reportAnswer()
                sequence.onAccessResult(granted)
            },
            settingsIntent = ::notificationSettingsIntent,
        )
        return rememberSourceSetupController(sequence = sequence, launcher = launcher)
    }

    /**
     * Tells the gateway where notification delivery stands and registers for
     * push at once, now that Android answered: a relay request the gateway
     * needs then usually arrives while setup is still showing, which asks on
     * its own page before Finish.
     */
    private fun reportAnswer() {
        scope.launch {
            try {
                session.reportNotificationHealth()
                session.retryFcmRegistration()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Delivery health is reported again on the next foreground.
            }
        }
    }
}

private fun notificationSettingsIntent(context: Context): Intent =
    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
