// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.unit.Density
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.pairing.CloudAccountSettingsController
import dev.omnesis.android.transport.dto.CloudRelayAbilities
import dev.omnesis.android.transport.dto.CloudRelayAccountLink
import dev.omnesis.android.transport.dto.CloudRelayCertificate
import dev.omnesis.android.transport.dto.CloudRelayCertificateIncident
import dev.omnesis.android.transport.dto.CloudRelayCertificateMonitor
import dev.omnesis.android.transport.dto.CloudRelayConfig
import dev.omnesis.android.transport.dto.CloudRelayConnect
import dev.omnesis.android.transport.dto.CloudRelayEnrollment
import dev.omnesis.android.transport.dto.CloudRelayPublicMcp
import dev.omnesis.android.transport.dto.CloudRelayStatus
import dev.omnesis.android.transport.dto.CloudRelayTunnel
import dev.omnesis.android.transport.dto.DeviceEnrollmentSettings
import dev.omnesis.android.ui.settings.CloudAccountContent
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.util.TimeZone

/** Settings → Omnesis account in each state worth a look, light and dark, and the main ones in large text. All data is invented. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class CloudAccountScreenshotTest {
    private companion object {
        const val RELAY = "https://relay.example.com"
        const val HOSTNAME = "g-7f3a91.relay.example.com"
        const val TALL = "w411dp-h1500dp-xxhdpi"
        const val TALLEST = "w411dp-h2500dp-xxhdpi"
    }

    private fun capture(name: String, state: CloudAccountSettingsController.State, large: Boolean = false) {
        for (dark in listOf(false, true)) {
            captureRoboImage(filePath = "src/test/roborazzi/cloud-account-$name-${if (dark) "dark" else "light"}.png") {
                val density = LocalDensity.current.density
                CompositionLocalProvider(LocalInspectionMode provides true, LocalDensity provides Density(density, if (large) 1.6f else 1f)) {
                    OmnesisTheme(darkTheme = dark) {
                        Surface(Modifier.fillMaxSize(), color = OmTheme.colors.bgPrimary) {
                            CloudAccountContent(state, onBack = {}, zone = TimeZone.getTimeZone("UTC"))
                        }
                    }
                }
            }
        }
    }

    private fun shown(status: CloudRelayStatus, connectIntent: String? = null) =
        CloudAccountSettingsController.State(status = status, loading = false, connectIntent = connectIntent)

    private val fresh = CloudRelayStatus(
        enabled = false,
        serviceConfigured = true,
        config = CloudRelayConfig(RELAY, "https://acme.example.org/directory", "https://acme.example.org/terms"),
        enrollment = CloudRelayEnrollment("unconfigured"),
        tunnel = CloudRelayTunnel("disabled"),
        certificate = CloudRelayCertificate("unconfigured"),
        account = CloudRelayAccountLink(configured = true),
        can = CloudRelayAbilities(configure = true),
    )

    private val connected = CloudRelayStatus(
        enabled = true,
        serviceConfigured = true,
        gatewayId = "gw_7f3a91c2",
        hostname = HOSTNAME,
        publicOrigin = "https://$HOSTNAME",
        config = CloudRelayConfig(RELAY, "https://acme.example.org/directory"),
        enrollment = CloudRelayEnrollment("enrolled"),
        tunnel = CloudRelayTunnel("online", JsonPrimitive("2026-11-10T08:15:00.000Z")),
        certificate = CloudRelayCertificate("valid", JsonPrimitive("2027-02-08T10:00:00.000Z"), JsonPrimitive("2026-11-10T08:14:00.000Z")),
        publicMcp = CloudRelayPublicMcp(ready = true, url = "https://$HOSTNAME/mcp"),
        account = CloudRelayAccountLink(activated = true, configured = true, linked = true, canUnlink = true),
        deviceEnrollment = DeviceEnrollmentSettings("ask"),
        certificateMonitor = CloudRelayCertificateMonitor("observing", JsonPrimitive("2026-11-10T06:00:00.000Z")),
        can = CloudRelayAbilities(disable = true, reconnect = true),
    )

    private val off = connected.copy(
        enabled = false,
        tunnel = CloudRelayTunnel("disabled", JsonPrimitive("2026-11-10T08:15:00.000Z")),
        publicMcp = CloudRelayPublicMcp(ready = false, url = "https://$HOSTNAME/mcp"),
        can = CloudRelayAbilities(enable = true),
    )

    /** The address stopped answering, a renewal failed and a certificate nobody asked for turned up. */
    private val troubled = connected.copy(
        certificate = CloudRelayCertificate("expiring", JsonPrimitive("2026-11-20T10:00:00.000Z"), JsonPrimitive("2026-08-22T10:00:00.000Z"), "certificate-renewal-failed"),
        publicMcp = CloudRelayPublicMcp(ready = false, url = "https://$HOSTNAME/mcp", lastError = "public-endpoint-unreachable"),
        certificateMonitor = CloudRelayCertificateMonitor(
            "incident",
            JsonPrimitive("2026-11-10T06:00:00.000Z"),
            incidents = listOf(CloudRelayCertificateIncident(hostname = HOSTNAME, issuer = "Example Issuing CA", serial = "0a1b2c")),
        ),
    )

    @Test fun not_connected_offers_two_ways_in() = capture("not-connected", shown(fresh))

    @Test
    @Config(qualifiers = TALL)
    fun not_connected_large_text() = capture("not-connected-large", shown(fresh), large = true)

    @Test fun waiting_shows_the_code_for_another_device() = capture(
        "waiting",
        shown(
            fresh.copy(
                connect = CloudRelayConnect(
                    state = "waiting",
                    authorizeUrl = "$RELAY/_relay/v3/signup/begin?request=req-1",
                    connectUrl = "$RELAY/_relay/connect",
                    connectShortUrl = "https://example.org/connect",
                    code = "KXTP-4M9Q",
                    expiresAt = JsonPrimitive(1_794_300_000),
                ),
            ),
            connectIntent = "create",
        ),
    )

    @Test
    @Config(qualifiers = TALL)
    fun failed_points_at_the_portal_when_only_it_can_help() = capture(
        "failed-portal",
        shown(fresh.copy(enrollment = CloudRelayEnrollment("failed", "invitation-required"))),
    )

    @Test fun unavailable_installation() = capture(
        "unavailable",
        shown(fresh.copy(serviceConfigured = false, serviceError = "relay-service-unavailable")),
    )

    @Test fun could_not_load() = capture("unreachable", CloudAccountSettingsController.State(loading = false, unreachable = true))

    @Test
    @Config(qualifiers = TALL)
    fun connected_account_remote_access_and_new_devices() = capture("connected", shown(connected))

    @Test
    @Config(qualifiers = TALLEST)
    fun connected_large_text() = capture("connected-large", shown(connected), large = true)

    @Test
    @Config(qualifiers = TALL)
    fun connected_while_the_address_is_still_being_checked() = capture(
        "checking",
        shown(connected.copy(publicMcp = CloudRelayPublicMcp(ready = false, url = "https://$HOSTNAME/mcp"))),
    )

    @Test
    @Config(qualifiers = TALL)
    fun remote_access_off_turns_on_and_keeps_the_account() = capture("off", shown(off))

    @Test
    @Config(qualifiers = TALLEST)
    fun remote_access_off_large_text() = capture("off-large", shown(off), large = true)

    @Test
    @Config(qualifiers = TALLEST)
    fun problems_are_said_in_one_box() = capture("problem", shown(troubled))

    @Test
    @Config(qualifiers = TALLEST)
    fun problems_large_text() = capture("problem-large", shown(troubled), large = true)

    @Test
    @Config(qualifiers = TALL)
    fun disconnected_offers_reconnect() = capture(
        "disconnected",
        shown(connected.copy(tunnel = CloudRelayTunnel("offline", JsonPrimitive("2026-11-10T08:15:00.000Z"), "relay-unreachable"), publicMcp = CloudRelayPublicMcp(ready = false, url = "https://$HOSTNAME/mcp"))),
    )
}
