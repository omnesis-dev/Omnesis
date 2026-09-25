// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.root

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.NotificationsActive
import androidx.compose.material.icons.outlined.NorthEast
import androidx.compose.material.icons.outlined.PanTool
import androidx.compose.material.icons.outlined.Smartphone
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.setup.ui.SetupCard
import dev.omnesis.android.setup.ui.SetupGradient
import dev.omnesis.android.setup.ui.SetupSecondaryButton
import dev.omnesis.android.setup.ui.setupPalette

/**
 * What Omnesis says when asking to use the push relay: the consent sheet and
 * phone setup's own relay page both show it through [RelayConsentBody] and
 * [RelayConsentAnswers].
 */
internal object RelayConsentCopy {
    const val TITLE = "Allow private notification wakes"
    const val EXPLANATION = "This build is not covered by your gateway’s direct push credentials. " +
        "With your permission, it can use the Omnesis relay to receive content-blind wakes."
    const val ENROLLMENT_TITLE = "During enrollment"
    const val ENROLLMENT_DETAIL = "The relay receives Android, this phone’s FCM token, and this app ID:"
    const val AFTER_ENROLLMENT_TITLE = "After enrollment"
    const val AFTER_ENROLLMENT_DETAIL =
        "Your gateway sends an authenticated request with an empty body when it needs to wake this phone."
    const val NEVER_RECEIVES_TITLE = "The relay never receives"
    const val NEVER_RECEIVES_DETAIL = "Notification text, your gateway address, your account, or which notification fired."
    const val ALLOW = "Allow relay notifications"
    const val ALLOWING = "Allowing…"
    const val NOT_NOW = "Not now"
}

/**
 * Device-scoped authorization for the content-blind push relay, as a modal
 * bottom sheet. While the approval is being saved it cannot be dismissed.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RelayConsentSheet(
    prompt: SessionManager.RelayConsentPrompt,
    appId: String,
    onGrant: () -> Unit,
    onDismiss: () -> Unit,
) {
    val requesting by rememberUpdatedState(prompt.requesting)
    val sheetState = rememberModalBottomSheetState(
        skipPartiallyExpanded = true,
        confirmValueChange = { value -> value != SheetValue.Hidden || !requesting },
    )
    ModalBottomSheet(
        onDismissRequest = { if (!requesting) onDismiss() },
        sheetState = sheetState,
        containerColor = setupPalette.base,
    ) {
        RelayConsentSheetContent(
            appId = appId,
            requesting = prompt.requesting,
            error = prompt.error,
            onAllow = onGrant,
            onNotNow = onDismiss,
            modifier = Modifier.verticalScroll(rememberScrollState()),
        )
    }
}

/** The sheet's content: the shared body and answers, with the sheet's margins. */
@Composable
internal fun RelayConsentSheetContent(
    appId: String,
    requesting: Boolean,
    error: String?,
    onAllow: () -> Unit,
    onNotNow: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp)
            .padding(top = 4.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        RelayConsentBody(appId)
        RelayConsentAnswers(requesting, error, onAllow, onNotNow)
    }
}

/** What asking to use the relay says: the bell, the title and explanation, and what the relay receives and never does. */
@Composable
internal fun RelayConsentBody(appId: String, modifier: Modifier = Modifier, iconTint: Color = OmTheme.colors.accent) {
    val palette = setupPalette
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(
                Icons.Filled.NotificationsActive,
                contentDescription = null,
                tint = iconTint,
                modifier = Modifier.size(48.dp),
            )
            Text(
                RelayConsentCopy.TITLE,
                style = MaterialTheme.typography.headlineSmall.copy(fontSize = 24.sp, lineHeight = 30.sp),
                fontWeight = FontWeight.Bold,
                color = palette.textPrimary,
            )
            Text(
                RelayConsentCopy.EXPLANATION,
                style = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp, lineHeight = 21.sp),
                color = palette.textSecondary,
            )
        }
        SetupCard {
            DisclosureRow(Icons.Outlined.Smartphone, RelayConsentCopy.ENROLLMENT_TITLE, RelayConsentCopy.ENROLLMENT_DETAIL) {
                Text(
                    appId,
                    modifier = Modifier.horizontalScroll(rememberScrollState()),
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, fontSize = 13.sp),
                    color = palette.textPrimary,
                    maxLines = 1,
                )
            }
            HorizontalDivider(Modifier.padding(vertical = 12.dp), thickness = 1.dp, color = palette.cardBorder)
            DisclosureRow(Icons.Outlined.NorthEast, RelayConsentCopy.AFTER_ENROLLMENT_TITLE, RelayConsentCopy.AFTER_ENROLLMENT_DETAIL)
            HorizontalDivider(Modifier.padding(vertical = 12.dp), thickness = 1.dp, color = palette.cardBorder)
            DisclosureRow(Icons.Outlined.PanTool, RelayConsentCopy.NEVER_RECEIVES_TITLE, RelayConsentCopy.NEVER_RECEIVES_DETAIL)
        }
    }
}

/** The two answers, with what went wrong saving the last one. */
@Composable
internal fun RelayConsentAnswers(
    requesting: Boolean,
    error: String?,
    onAllow: () -> Unit,
    onNotNow: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = setupPalette
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        error?.let {
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = palette.danger, modifier = Modifier.size(18.dp))
                Text(it, style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, lineHeight = 18.sp), color = palette.danger)
            }
        }
        RelayAllowButton(requesting, onAllow, Modifier.fillMaxWidth())
        SetupSecondaryButton(RelayConsentCopy.NOT_NOW, onNotNow, Modifier.fillMaxWidth(), enabled = !requesting)
    }
}

/** Allowing the relay: the gradient action, which says what it is doing while the approval is saved. */
@Composable
internal fun RelayAllowButton(requesting: Boolean, onAllow: () -> Unit, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(26.dp)
    Box(
        modifier
            .heightIn(min = 52.dp)
            .clip(shape)
            .background(Brush.linearGradient(SetupGradient), shape)
            .clickable(enabled = !requesting, role = Role.Button, onClick = onAllow)
            .padding(horizontal = 18.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (requesting) OmSpinner(modifier = Modifier.size(16.dp), color = Color.White, strokeWidth = 2.dp)
            Text(
                if (requesting) RelayConsentCopy.ALLOWING else RelayConsentCopy.ALLOW,
                style = MaterialTheme.typography.titleSmall.copy(fontSize = 16.sp, lineHeight = 20.sp),
                fontWeight = FontWeight.SemiBold,
                color = Color.White,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun DisclosureRow(
    icon: ImageVector,
    title: String,
    detail: String,
    trailing: (@Composable () -> Unit)? = null,
) {
    val palette = setupPalette
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(Modifier.width(28.dp)) {
            Icon(icon, contentDescription = null, tint = OmTheme.colors.accent, modifier = Modifier.size(22.dp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                title,
                style = MaterialTheme.typography.bodyLarge.copy(fontSize = 16.sp, lineHeight = 21.sp),
                fontWeight = FontWeight.SemiBold,
                color = palette.textPrimary,
            )
            Text(
                detail,
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.5.sp, lineHeight = 18.sp),
                color = palette.textSecondary,
            )
            trailing?.invoke()
        }
    }
}
