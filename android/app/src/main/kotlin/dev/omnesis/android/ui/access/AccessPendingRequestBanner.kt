// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.access

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import dev.omnesis.android.access.AccessPendingBannerOffer
import dev.omnesis.android.access.PairingRequestBannerOffer
import dev.omnesis.android.designsystem.components.OmnesisCard
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme

internal const val ACCESS_PENDING_BANNER_TITLE = "Access request waiting"
internal const val ACCESS_PENDING_BANNER_ACTION = "Configure & Approve"
internal const val ACCESS_PENDING_BANNER_DISMISS = "Dismiss"

/**
 * The requests waiting on the owner, named on the main screen by the newest and how many
 * more wait behind it. Tapping the card, whose action reads "Configure & Approve", opens the
 * wizard for the newest; the close button hides the banner until what is waiting changes.
 */
@Composable
fun AccessPendingRequestBanner(
    offer: AccessPendingBannerOffer,
    onReview: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) = PendingRequestBanner(
    icon = Icons.Outlined.Key,
    title = ACCESS_PENDING_BANNER_TITLE,
    detail = offer.detail,
    action = ACCESS_PENDING_BANNER_ACTION,
    dismissLabel = ACCESS_PENDING_BANNER_DISMISS,
    onReview = onReview,
    onDismiss = onDismiss,
    modifier = modifier,
)

internal const val PAIRING_REQUEST_BANNER_DISMISS = "Dismiss pairing request"

/** Devices that signed in and wait for approval, as one banner with their count. Tapping it opens Pairing requests. */
@Composable
fun PairingRequestBanner(
    offer: PairingRequestBannerOffer,
    onReview: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) = PendingRequestBanner(
    icon = Icons.Outlined.VerifiedUser,
    title = offer.text,
    detail = null,
    action = PairingRequestBannerOffer.ACTION,
    dismissLabel = PAIRING_REQUEST_BANNER_DISMISS,
    onReview = onReview,
    onDismiss = onDismiss,
    modifier = modifier.testTag("home.pairingRequestBanner"),
)

/**
 * One request waiting on the owner, above the main screen's content: what waits, the action
 * in words, and a close button. Every kind of waiting request uses this one banner.
 */
@Composable
private fun PendingRequestBanner(
    icon: ImageVector,
    title: String,
    detail: String?,
    action: String,
    dismissLabel: String,
    onReview: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = OmTheme.colors
    OmnesisCard(
        modifier = modifier.fillMaxWidth().clickable(
            onClickLabel = action,
            role = Role.Button,
            onClick = onReview,
        ),
        padding = OmSpacing.md,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        ) {
            Icon(icon, contentDescription = null, tint = c.accent)
            Column(Modifier.weight(1f)) {
                Text(title, fontWeight = FontWeight.SemiBold, color = c.textPrimary)
                Text(
                    buildAnnotatedString {
                        if (detail != null) {
                            append(detail)
                            append(" · ")
                        }
                        withStyle(SpanStyle(color = c.accent, fontWeight = FontWeight.SemiBold)) { append(action) }
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textSecondary,
                )
            }
            IconButton(onClick = onDismiss) {
                Icon(Icons.Outlined.Close, contentDescription = dismissLabel, tint = c.textMuted)
            }
        }
    }
}
