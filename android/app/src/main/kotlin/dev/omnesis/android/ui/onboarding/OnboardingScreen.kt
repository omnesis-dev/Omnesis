// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.onboarding

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.R
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme

/**
 * First-launch hero shown while unpaired. Left-aligned scroll: the Omnesis wordmark, a large
 * headline, a value-prop paragraph, three bullets, and a full-width "Pair" CTA. Ported from
 * the iOS `OnboardingView` — health-specific copy and the SF-Symbol hero are dropped; the
 * brand logo (`R.drawable.omnesis_logo`) stands in for the hero glyph.
 */
@Composable
fun OnboardingScreen(
    modifier: Modifier = Modifier,
    onPairClicked: () -> Unit = {},
) {
    val c = OmTheme.colors
    Surface(modifier = modifier.fillMaxSize(), color = c.bgPrimary) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                // Edge-to-edge: keep content clear of the status + navigation bars.
                .windowInsetsPadding(WindowInsets.systemBars)
                .padding(OmSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(OmSpacing.xl),
            horizontalAlignment = Alignment.Start,
        ) {
            Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
                Image(
                    painter = painterResource(R.drawable.omnesis_logo),
                    contentDescription = "Omnesis",
                    colorFilter = ColorFilter.tint(OmTheme.colors.brandLogo),
                    modifier = Modifier
                        .align(Alignment.CenterHorizontally)
                        .height(56.dp),
                )
                Text(
                    "Search your entire digital life.",
                    // ~iOS .largeTitle (34pt) bold.
                    style = MaterialTheme.typography.titleLarge.copy(fontSize = 34.sp, lineHeight = 40.sp),
                    fontWeight = FontWeight.Bold,
                    color = c.textPrimary,
                )
                Text(
                    "Omnesis indexes your messages, mail, files, and more on your gateway. " +
                        "This app is your window into all of it.",
                    // ~iOS .body (17pt).
                    style = MaterialTheme.typography.bodyLarge.copy(fontSize = 17.sp),
                    color = c.textSecondary,
                )
            }

            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Bullet(Icons.Outlined.Search, "Search your whole index, right from your phone.")
                Bullet(Icons.Outlined.Shield, "Your index stays on your gateway. You choose local or cloud inference.")
                Bullet(Icons.Outlined.Bolt, "Always in sync as your gateway indexes new data.")
            }

            Spacer(Modifier.height(OmSpacing.xl))

            Button(
                onClick = onPairClicked,
                modifier = Modifier.fillMaxWidth().height(52.dp),
                colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = Color.White),
            ) {
                Text("Pair with your gateway", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun Bullet(icon: ImageVector, text: String) {
    val c = OmTheme.colors
    Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.md), verticalAlignment = Alignment.Top) {
        Icon(icon, contentDescription = null, tint = c.accent, modifier = Modifier.width(28.dp))
        // ~iOS .body (17pt).
        Text(text, style = MaterialTheme.typography.bodyLarge.copy(fontSize = 17.sp), color = c.textPrimary)
    }
}

@Preview(name = "Onboarding · Light", showBackground = true)
@Composable
private fun OnboardingPreviewLight() {
    OmnesisTheme(darkTheme = false) { OnboardingScreen() }
}

@Preview(name = "Onboarding · Dark", showBackground = true)
@Composable
private fun OnboardingPreviewDark() {
    OmnesisTheme(darkTheme = true) { OnboardingScreen() }
}
