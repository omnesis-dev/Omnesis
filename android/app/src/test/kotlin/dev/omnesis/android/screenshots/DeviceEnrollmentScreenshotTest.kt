// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.pairing.GatewayPairingApprovalController
import dev.omnesis.android.transport.dto.DeviceEnrollmentRecord
import dev.omnesis.android.transport.dto.DeviceRecord
import dev.omnesis.android.transport.dto.GatewayPairingApprovalRequest
import dev.omnesis.android.ui.devices.DeviceCard
import dev.omnesis.android.ui.devices.GatewayPairingApprovalContent
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.pairing.AccountCloudPairingPane
import dev.omnesis.android.ui.pairing.AccountPairingPhase
import dev.omnesis.android.ui.pairing.accountPairingPreviewState
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Every state sign-in enrollment adds, light and dark. All data is invented. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class DeviceEnrollmentScreenshotTest {
    private companion object {
        const val NOW = 1_772_446_500_000L
        const val HOUR = 3_600_000L
    }

    private fun capture(name: String, large: Boolean = false, content: @Composable () -> Unit) {
        for (dark in listOf(false, true)) {
            captureRoboImage(filePath = "src/test/roborazzi/device-enrollment-$name-${if (dark) "dark" else "light"}.png") {
                val density = LocalDensity.current.density
                CompositionLocalProvider(LocalInspectionMode provides true, LocalDensity provides Density(density, if (large) 1.6f else 1f)) {
                    OmnesisTheme(darkTheme = dark) {
                        Surface(Modifier.fillMaxSize(), color = OmTheme.colors.bgPrimary) { content() }
                    }
                }
            }
        }
    }

    @Composable private fun Padded(content: @Composable () -> Unit) {
        Column(Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary).padding(16.dp)) { content() }
    }

    private val device = DeviceRecord(id = "device-a", name = "Maya's Phone", kind = "android", pairedAt = NOW - HOUR, lastSeenAt = NOW - HOUR, online = false)

    @Test fun device_joined_automatically() = capture("device-automatic") {
        Padded {
            DeviceCard(
                device.copy(enrollment = DeviceEnrollmentRecord("automatic", "google", NOW - HOUR)),
                tokens = Loadable.Content(emptyList()), startExpanded = true, now = NOW, cloudFeatures = true,
            )
        }
    }

    @Test fun device_approved() = capture("device-approved") {
        Padded {
            DeviceCard(
                device.copy(enrollment = DeviceEnrollmentRecord("approved", "passkey", NOW - 48 * HOUR)),
                tokens = Loadable.Content(emptyList()), startExpanded = true, now = NOW, cloudFeatures = true,
            )
        }
    }

    private val request = GatewayPairingApprovalRequest("00000000-0000-4000-8000-000000000901", "android", "Test phone", "pending", "465 774", NOW + HOUR, canTrustSignIn = true, signIn = "google")

    @Test fun approval_offers_to_trust_the_sign_in() = capture("approval-trust") {
        GatewayPairingApprovalContent(GatewayPairingApprovalController.State(requests = listOf(request), trustSignIn = setOf(request.requestId)), NOW, {}, { _, _ -> }, {})
    }

    @Test fun approval_of_a_passkey_with_the_switch_off() = capture("approval-passkey") {
        GatewayPairingApprovalContent(GatewayPairingApprovalController.State(requests = listOf(request.copy(signIn = "passkey"))), NOW, {}, { _, _ -> }, {})
    }

    /** Two devices wait: each has the one sentence, its own code and its two actions. A short code shows the same way. */
    @Test fun approval_of_several_requests() = capture("approval-several") {
        GatewayPairingApprovalContent(
            GatewayPairingApprovalController.State(
                requests = listOf(
                    request.copy(canTrustSignIn = false),
                    request.copy(requestId = "00000000-0000-4000-8000-000000000902", kind = "ios", name = "Jamie's iPhone", verificationCode = "482 915", canTrustSignIn = false, signIn = "passkey"),
                ),
            ),
            NOW, {}, { _, _ -> }, {},
        )
    }

    @Test fun approval_with_large_text() = capture("approval-large", large = true) {
        GatewayPairingApprovalContent(GatewayPairingApprovalController.State(requests = listOf(request)), NOW, {}, { _, _ -> }, {})
    }

    @Test fun approval_with_nothing_waiting() = capture("approval-empty") {
        GatewayPairingApprovalContent(GatewayPairingApprovalController.State(), NOW, {}, { _, _ -> }, {})
    }

    /** A device that joined by signing in, as its card reads before it is opened. */
    @Test fun device_joined_collapsed() = capture("device-automatic-collapsed") {
        Padded {
            DeviceCard(
                device.copy(enrollment = DeviceEnrollmentRecord("automatic", "passkey", NOW - HOUR)),
                tokens = null, now = NOW, cloudFeatures = true,
            )
        }
    }

    @Test fun sign_in_without_a_passkey() = capture("pane-no-passkey") {
        AccountCloudPairingPane(accountPairingPreviewState(AccountPairingPhase.Failed).copy(error = null, notice = "No passkey was used. If this phone has no passkey for your Omnesis account, sign in with Google, or add a passkey to your Omnesis account first."), true, true, {}, {}, {}, {})
    }

    @Test fun sign_in_joining_without_a_code() = capture("pane-joined") {
        AccountCloudPairingPane(accountPairingPreviewState(AccountPairingPhase.Pairing).copy(joined = true, code = null), true, true, {}, {}, {}, {})
    }

    @Test fun sign_in_not_your_gateway() = capture("pane-not-yours") {
        AccountCloudPairingPane(accountPairingPreviewState(AccountPairingPhase.Failed).copy(error = "This doesn't look like your gateway. Nothing was saved. Try again, or pair directly with a QR code."), true, true, {}, {}, {}, {})
    }

    @Test fun sign_in_without_an_omnesis_account() = capture("pane-no-account") {
        AccountCloudPairingPane(accountPairingPreviewState(AccountPairingPhase.Failed).copy(error = "There is no Omnesis account for this sign-in yet. Create one from your gateway: open its portal, go to Settings, then Account, and choose \"Create an Omnesis account\". You can also pair directly with a QR code."), true, true, {}, {}, {}, {})
    }

    @Test fun sign_in_expired_while_waiting() = capture("pane-expired") {
        AccountCloudPairingPane(accountPairingPreviewState(AccountPairingPhase.Failed).copy(error = "Your sign-in expired. Sign in again to connect this device."), true, true, {}, {}, {}, {})
    }

    @Test fun sign_in_gateway_needs_update() = capture("pane-update") {
        AccountCloudPairingPane(accountPairingPreviewState(AccountPairingPhase.Failed).copy(error = "Your gateway needs an update before this device can sign in. Update Omnesis on your gateway, then try again."), true, true, {}, {}, {}, {})
    }
}
