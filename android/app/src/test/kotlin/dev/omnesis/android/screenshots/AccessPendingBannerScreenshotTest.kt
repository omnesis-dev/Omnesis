// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.access.AccessPendingBannerOffer
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.AccessPendingRequest
import dev.omnesis.android.ui.access.AccessPendingRequestBanner
import dev.omnesis.android.ui.access.PairingRequestBanner
import dev.omnesis.android.access.PairingRequestBannerOffer
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The main-screen banner for the authorization requests waiting on the owner: one waiting,
 * several waiting behind the newest, and a long client name at a narrow phone width.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h240dp-xxhdpi")
class AccessPendingBannerScreenshotTest {
    @Test fun banner_light() = capture("access_pending_banner_light", false) { banner(one) }
    @Test fun banner_dark() = capture("access_pending_banner_dark", true) { banner(one) }

    /** Several requests waiting: the newest is named and the rest are counted behind it. */
    @Test fun banner_several_light() = capture("access_pending_banner_several_light", false) { banner(several) }
    @Test fun banner_several_dark() = capture("access_pending_banner_several_dark", true) { banner(several) }

    /** A narrow phone and a long client name: the name wraps under the title, the actions stay put. */
    @Test
    @Config(sdk = [34], qualifiers = "w320dp-h240dp-xxhdpi")
    fun banner_narrow_light() = capture("access_pending_banner_narrow_light", false) { banner(longNamed) }

    @Test
    @Config(sdk = [34], qualifiers = "w320dp-h240dp-xxhdpi")
    fun banner_narrow_dark() = capture("access_pending_banner_narrow_dark", true) { banner(longNamed) }

    /** A device that signed in waits for approval: the same banner, with the count in its words. */
    @Test fun pairing_banner_light() = capture("pairing_request_banner_light", false) { pairingBanner(1) }
    @Test fun pairing_banner_dark() = capture("pairing_request_banner_dark", true) { pairingBanner(1) }
    @Test fun pairing_banner_several_dark() = capture("pairing_request_banner_several_dark", true) { pairingBanner(3) }

    /** Both kinds of request waiting at once: the banners stack, neither covers the other. */
    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h320dp-xxhdpi")
    fun both_banners_dark() = capture("pending_banners_both_dark", true) { both() }

    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h320dp-xxhdpi")
    fun both_banners_light() = capture("pending_banners_both_light", false) { both() }

    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h420dp-xxhdpi")
    fun pairing_banner_large_text_dark() = capture("pairing_request_banner_large_dark", true) {
        val density = LocalDensity.current.density
        CompositionLocalProvider(LocalDensity provides Density(density, 1.6f)) { pairingBanner(1) }
    }

    @Composable
    private fun pairingBanner(count: Int) {
        Box(Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary).padding(OmSpacing.md)) {
            PairingRequestBanner(offer = PairingRequestBannerOffer(count), onReview = {}, onDismiss = {})
        }
    }

    @Composable
    private fun both() {
        Column(
            Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary).padding(OmSpacing.md),
            verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        ) {
            AccessPendingRequestBanner(offer = one, onReview = {}, onDismiss = {})
            PairingRequestBanner(offer = PairingRequestBannerOffer(2), onReview = {}, onDismiss = {})
        }
    }

    @Composable
    private fun banner(offer: AccessPendingBannerOffer) {
        Box(Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary).padding(OmSpacing.md)) {
            AccessPendingRequestBanner(offer = offer, onReview = {}, onDismiss = {})
        }
    }

    private fun capture(name: String, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark, content = content)
            }
        }
    }

    private val request = AccessPendingRequest(
        id = "request_example",
        clientName = "Aurora Planner",
        userCode = "ABCD-EFGH",
        createdAt = 1_782_000_200_000,
        expiresAt = 1_782_000_800_000,
    )

    private val one = AccessPendingBannerOffer(newest = request, count = 1)
    private val several = AccessPendingBannerOffer(newest = request, count = 3)
    private val longNamed = AccessPendingBannerOffer(
        newest = request.copy(clientName = "Aurora Planner for Shared Workspaces"),
        count = 1,
    )
}
