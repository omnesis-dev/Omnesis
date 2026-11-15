// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.unit.Density
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.pairing.GatewayPairingApprovalController
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.GatewayPairingApprovalRequest
import dev.omnesis.android.transport.dto.TailscaleJoinRequest
import dev.omnesis.android.ui.devices.DeviceApprovalsContent
import dev.omnesis.android.ui.devices.TailscaleJoinRequestsViewModel
import java.time.Instant
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Devices approvals sheet with both kinds of waiting device: one that signed in with the
 * Omnesis account and ones that asked through Tailscale, each kind alone, and the Tailscale
 * states (gone, step-up, nothing waiting, large text). The sign-in states alone are in
 * [DeviceEnrollmentScreenshotTest].
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class DeviceApprovalsScreenshotTest {
    private val now = Instant.parse("2026-11-14T18:05:00.000Z").toEpochMilli()

    private val phone = GatewayPairingApprovalRequest(
        "00000000-0000-4000-8000-000000000901", "android", "Jamie's phone", "pending", "465 774", now + 600_000,
        signIn = "google", signInEmail = "maya@example.com",
    )
    private val studio = TailscaleJoinRequest(
        id = "join-1", name = "Maya's studio Mac", kind = "collector", machine = "studio-mac", os = "macOS",
        login = "maya@example.com", requestedAt = "2026-11-14T18:02:00.000Z", expiresAt = "2026-11-14T18:12:00.000Z",
    )
    private val buildBox = TailscaleJoinRequest(
        id = "join-2", name = "build-box", kind = "collector", machine = "build-box", os = "Linux",
        login = "maya@example.com", requestedAt = "2026-11-14T18:04:30.000Z", expiresAt = "2026-11-14T18:14:30.000Z",
    )
    private val signIns = GatewayPairingApprovalController.State(requests = listOf(phone))
    private val joins = TailscaleJoinRequestsViewModel.State(requests = listOf(studio, buildBox), loaded = true, available = true)

    @Test fun both_kinds() = capture("device-approvals-both") { sheet(signIns, joins.copy(requests = listOf(studio))) }

    @Test fun tailscale_only() = capture("device-approvals-tailscale") { sheet(null, joins) }

    /** A gateway without Tailscale joins: exactly the sign-in sheet. */
    @Test fun sign_in_only() = capture("device-approvals-sign-in-only") {
        sheet(signIns, TailscaleJoinRequestsViewModel.State(loaded = true, available = false))
    }

    @Test fun tailscale_gone() = capture("device-approvals-tailscale-gone", dark = listOf(false)) {
        sheet(null, joins.copy(requests = listOf(buildBox), notice = "That request expired or was already decided."))
    }

    /** The gateway wants the owner's passkey before it takes the approval from this phone. */
    @Test fun tailscale_step_up() = capture("device-approvals-tailscale-step-up", dark = listOf(false)) {
        sheet(null, joins.copy(requests = listOf(studio), error = GatewayException.ServerError(428, "{}", "STEP_UP_REQUIRED")))
    }

    @Test fun tailscale_empty() = capture("device-approvals-tailscale-empty", dark = listOf(false)) {
        sheet(null, TailscaleJoinRequestsViewModel.State(loaded = true, available = true))
    }

    @Test fun both_kinds_large_text() = capture("device-approvals-both-large", dark = listOf(false), large = true) {
        sheet(signIns, joins.copy(requests = listOf(studio)))
    }

    @Composable private fun sheet(signIns: GatewayPairingApprovalController.State?, joins: TailscaleJoinRequestsViewModel.State?) =
        DeviceApprovalsContent(signIns, now, onRefresh = {}, onDecide = { _, _ -> }, onDismiss = {}, joins = joins)

    private fun capture(name: String, dark: List<Boolean> = listOf(false, true), large: Boolean = false, content: @Composable () -> Unit) {
        for (isDark in dark) {
            captureRoboImage(filePath = "src/test/roborazzi/$name-${if (isDark) "dark" else "light"}.png") {
                val density = LocalDensity.current.density
                CompositionLocalProvider(LocalInspectionMode provides true, LocalDensity provides Density(density, if (large) 1.6f else 1f)) {
                    OmnesisTheme(darkTheme = isDark) {
                        Surface(Modifier.fillMaxSize(), color = OmTheme.colors.bgPrimary) { content() }
                    }
                }
            }
        }
    }
}
