// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import dev.omnesis.android.designsystem.components.OmnesisCard
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.session.PushPlanState

enum class NotificationSetupIssue {
    CLIENT_CONFIG,
    DIRECT_CREDENTIAL,
    RELAY_CONSENT,
    RELAY_UNAVAILABLE,
    PLAN_FAILED,
    REGISTRATION_FAILED,
    PERMISSION,
}

/**
 * Whether [issue] belongs in the app-wide banner. Only a notification permission the phone's
 * user turned off does, and they can dismiss it. The other issues ask whoever builds the app
 * or runs the gateway to configure push; the Settings notification section explains them, and
 * repeating them over every screen hides the controls beneath.
 */
fun showsNotificationIssueGlobally(issue: NotificationSetupIssue?, dismissed: Boolean): Boolean =
    issue == NotificationSetupIssue.PERMISSION && !dismissed

fun notificationSetupIssue(
    configured: Boolean,
    plan: PushPlanState,
    health: String,
    registrationFailed: Boolean = false,
): NotificationSetupIssue? {
    if (!configured) return NotificationSetupIssue.CLIENT_CONFIG
    return when (plan) {
        PushPlanState.Checking -> null
        PushPlanState.Failed -> NotificationSetupIssue.PLAN_FAILED
        is PushPlanState.Ready -> when (plan.plan.transport) {
            "unavailable" -> when (plan.plan.reasonCode) {
                "no-direct-credential" -> NotificationSetupIssue.DIRECT_CREDENTIAL
                "relay-disabled" -> NotificationSetupIssue.RELAY_CONSENT
                else -> NotificationSetupIssue.RELAY_UNAVAILABLE
            }
            "direct-fcm", "relay" -> when {
                health != "healthy" -> NotificationSetupIssue.PERMISSION
                registrationFailed -> NotificationSetupIssue.REGISTRATION_FAILED
                else -> null
            }
            else -> NotificationSetupIssue.PLAN_FAILED
        }
    }
}

@Composable
fun NotificationSetupBanner(
    issue: NotificationSetupIssue,
    appId: String,
    onRetry: () -> Unit,
    onHelp: () -> Unit,
) {
    val title = when (issue) {
        NotificationSetupIssue.CLIENT_CONFIG -> "This build has no Firebase configuration"
        NotificationSetupIssue.DIRECT_CREDENTIAL -> "Gateway FCM setup is needed"
        NotificationSetupIssue.RELAY_CONSENT -> "Allow relay notifications"
        NotificationSetupIssue.RELAY_UNAVAILABLE -> "Notification delivery is unavailable"
        NotificationSetupIssue.PLAN_FAILED -> "Couldn't check notification delivery"
        NotificationSetupIssue.REGISTRATION_FAILED -> "FCM registration didn't finish"
        NotificationSetupIssue.PERMISSION -> return
    }
    val detail = when (issue) {
        NotificationSetupIssue.CLIENT_CONFIG ->
            "Configure Firebase for $appId and rebuild the app. The phone cannot add build settings after installation."
        NotificationSetupIssue.DIRECT_CREDENTIAL ->
            "No direct FCM credential covers $appId on this gateway. Run omnesis push setup for this package, then retry."
        NotificationSetupIssue.RELAY_CONSENT ->
            "Approve the relay request on this phone to enable background notifications."
        NotificationSetupIssue.RELAY_UNAVAILABLE ->
            "The gateway has no available notification transport for $appId. Check push setup, then retry."
        NotificationSetupIssue.PLAN_FAILED ->
            "The app could not read the gateway push plan. Check the connection, then retry."
        NotificationSetupIssue.REGISTRATION_FAILED ->
            "FCM registration did not finish. Check Google Play services, the connection, and that the gateway and app use the same Firebase project, then retry."
        NotificationSetupIssue.PERMISSION -> return
    }
    OmnesisCard(padding = OmSpacing.lg) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
            Icon(Icons.Outlined.WarningAmber, null, tint = OmTheme.colors.warning)
            Text(title, fontWeight = FontWeight.SemiBold, color = OmTheme.colors.textPrimary)
        }
        Text(detail, style = MaterialTheme.typography.bodySmall, color = OmTheme.colors.textSecondary)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = onHelp) { Text("Setup guide") }
            if (issue != NotificationSetupIssue.CLIENT_CONFIG) {
                TextButton(onClick = onRetry) { Text("Retry") }
            }
        }
    }
}
