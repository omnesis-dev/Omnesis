// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.GatewayException

/**
 * Full-screen error placeholder used wherever a top-level data fetch fails before the page
 * can show any content. Ported from the iOS `GatewayErrorView`. Renders a kind-dependent
 * icon, a plain-English title, a friendly explanation, a primary "Retry" button, and a
 * secondary "Open Settings" link.
 *
 * The one exception is the first-run [GatewayErrorKind.AgentNotConfigured] state (no model
 * assigned to the Agent capability yet): when [onOpenModels] is supplied it drops the warning
 * framing and shows a "Set up agent model" jump into the Models screen instead of the settings
 * link, since that's a normal setup step, not a fault.
 *
 * Pass the underlying [error] (not a pre-stringified message) so the classifier can pick the
 * right [GatewayErrorKind]. A null [error] folds to [GatewayErrorKind.Unreachable]. [context]
 * is a short verb-phrase describing what failed ("load triggers", "start the agent").
 */
@Composable
fun GatewayErrorView(
    context: String,
    error: Throwable?,
    onRetry: () -> Unit,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier,
    onOpenModels: (() -> Unit)? = null,
) {
    val c = OmTheme.colors
    val kind = error?.let { gatewayErrorKind(it) } ?: GatewayErrorKind.Unreachable
    Column(
        modifier = modifier
            .fillMaxSize()
            .background(c.bgPrimary)
            .padding(OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            imageVector = kind.icon,
            contentDescription = null,
            tint = kind.tint(c),
            modifier = Modifier.size(42.dp),
        )
        Text(
            text = kind.title(),
            style = MaterialTheme.typography.titleMedium,
            color = c.textPrimary,
            textAlign = TextAlign.Center,
        )
        Text(
            text = kind.detail(context),
            style = MaterialTheme.typography.bodySmall,
            color = c.textSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = OmSpacing.lg),
        )
        // The action pair forms a tight cluster (iOS VStack(spacing: 6) with a small top
        // padding) rather than inheriting the page's 12dp rhythm, so they nearly touch.
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.padding(top = OmSpacing.sm),
        ) {
            if (kind == GatewayErrorKind.AgentNotConfigured && onOpenModels != null) {
                // First-run "no agent model" state: jump straight to Models (where the
                // assignment is made) and drop the settings link — Settings has no model
                // controls, so pointing there would be a dead end.
                Button(
                    onClick = onOpenModels,
                    colors = ButtonDefaults.buttonColors(containerColor = c.accent),
                ) {
                    Text("Set up agent model")
                }
                TextButton(
                    onClick = onRetry,
                    modifier = Modifier.padding(top = 2.dp),
                ) {
                    Text(
                        text = "Retry",
                        style = MaterialTheme.typography.labelLarge,
                        color = c.accent,
                    )
                }
            } else {
                Button(
                    onClick = onRetry,
                    colors = ButtonDefaults.buttonColors(containerColor = c.accent),
                ) {
                    Text("Retry")
                }
                TextButton(
                    onClick = onOpenSettings,
                    modifier = Modifier.padding(top = 2.dp),
                ) {
                    Text(
                        text = "Open Settings",
                        style = MaterialTheme.typography.labelLarge,
                        color = c.accent,
                    )
                }
            }
        }
    }
}

// MARK: - Previews

@Composable
private fun GatewayErrorPreview(
    error: Throwable?,
    context: String,
    dark: Boolean,
    onOpenModels: (() -> Unit)? = null,
) {
    OmnesisTheme(darkTheme = dark) {
        GatewayErrorView(
            context = context,
            error = error,
            onRetry = {},
            onOpenSettings = {},
            onOpenModels = onOpenModels,
        )
    }
}

@Preview(name = "Gateway error — unreachable (dark)")
@Composable
private fun GatewayErrorUnreachableDark() {
    GatewayErrorPreview(GatewayException.Network(Exception("offline")), "load triggers", dark = true)
}

@Preview(name = "Gateway error — unreachable (light)")
@Composable
private fun GatewayErrorUnreachableLight() {
    GatewayErrorPreview(GatewayException.Network(Exception("offline")), "load triggers", dark = false)
}

@Preview(name = "Gateway error — unauthorized (dark)")
@Composable
private fun GatewayErrorUnauthorizedDark() {
    GatewayErrorPreview(GatewayException.Unauthorized(), "load triggers", dark = true)
}

@Preview(name = "Gateway error — no model assigned (dark)")
@Composable
private fun GatewayErrorNoModelDark() {
    GatewayErrorPreview(
        GatewayException.ServerError(
            503,
            "Agent disabled. Set inference.assignments.agent in omnesis.json (e.g. \"anthropic/claude-sonnet-4-6\") to enable it.",
        ),
        "start the agent",
        dark = true,
        onOpenModels = {},
    )
}

@Preview(name = "Gateway error — agent not configured (dark)")
@Composable
private fun GatewayErrorAgentDark() {
    GatewayErrorPreview(
        GatewayException.ServerError(
            503,
            "Agent harness disabled. Set agent.backend to \"anthropic\" in omnesis.json.",
        ),
        "start the agent",
        dark = true,
        onOpenModels = {},
    )
}

@Preview(name = "Gateway error — server (dark)")
@Composable
private fun GatewayErrorServerDark() {
    GatewayErrorPreview(
        GatewayException.ServerError(500, "Service temporarily unavailable. Try again in a few seconds."),
        "load people",
        dark = true,
    )
}
