// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.DeviceCapabilities
import dev.omnesis.android.transport.dto.DeviceRecord
import dev.omnesis.android.transport.dto.AwayFromHomeHint
import dev.omnesis.android.transport.dto.NetworkIdentity
import dev.omnesis.android.transport.dto.PairingAddressOption
import dev.omnesis.android.transport.dto.PairingAddressPlan
import dev.omnesis.android.transport.dto.PendingPairing
import dev.omnesis.android.transport.dto.AgentIntegrationCapability
import dev.omnesis.android.transport.dto.TokenRecord
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.devices.DeviceCard
import dev.omnesis.android.ui.devices.DevicesContent
import dev.omnesis.android.ui.devices.DevicesViewModel
import dev.omnesis.android.ui.devices.LegacyPairDeviceContent
import dev.omnesis.android.ui.devices.PairDeviceContent
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Pixel-parity screenshots for the read-only device-management viewer, the
 * Android analogue of the iOS `54-devices-list` /
 * `54b-devices-empty` / `55-device-card-expanded` snapshots. Robolectric +
 * Roborazzi. All sample data is invented (privacy rule), never from the corpus.
 *
 *   ./gradlew :app:recordRoborazziDebug   ->   app/build/outputs/roborazzi/
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class DevicesScreenshotTest {

    private companion object {
        // Wall-clock "now" captured once per fixture build. Recent timestamps are
        // small offsets from this, and each DeviceCard is rendered at this same
        // instant (`now = NOW`), so TimeFormat.relative() buckets them stably
        // ("just now", "Nm/Nh/Nd ago") however long the suite takes to reach it.
        val NOW: Long = System.currentTimeMillis()

        // Fixed absolute epochs for the "older than 7 days" timestamps, which
        // TimeFormat.relative() renders as an absolute "d MMM yyyy, HH:mm" date.
        // Pinning them keeps that rendered date byte-identical across the record
        // and verify runs (a NOW-relative value would tick its minute and flake
        // the verifyRoborazziDebug lane). Invented dates, not corpus-derived.
        // 2 Mar 2026 10:15 UTC and 18 Feb 2026 14:30 UTC.
        const val OLD_EPOCH: Long = 1_772_446_500_000L
        const val OLD_EPOCH_2: Long = 1_771_424_400_000L
    }

    private fun capture(name: String, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { content() }
            }
        }
    }

    // A collector (live, hostname), a phone without a live socket, and an external-agent
    // integration — mirrors the iOS device fixtures.
    //
    // Determinism note: these are tracked goldens that verifyRoborazziDebug
    // compares against in CI. TimeFormat.relative() buckets a delta into
    // "just now" / "Nm ago" / "Nh ago" / "Nd ago" for anything < 7 days, then
    // falls through to an ABSOLUTE "d MMM yyyy, HH:mm" date for older ones.
    //   - Recent timestamps are offsets from the live wall clock (NOW): the
    //     delta is constant run-to-run, so the relative bucket is stable.
    //   - Timestamps older than 7 days render as an absolute date whose minute
    //     would tick between the record and the verify run if it tracked NOW, so
    //     those are pinned to a FIXED epoch (OLD_EPOCH) → a stable absolute date.
    private fun devices(): List<DeviceRecord> = listOf(
        DeviceRecord(
            id = "dev-collector-1",
            name = "Studio Desktop",
            kind = "collector",
            pairedAt = OLD_EPOCH, // > 7d → absolute date; pinned for stability
            lastSeenAt = NOW - 45_000L, // "just now"
            capabilities = DeviceCapabilities(hostname = "studio-desktop.local"),
            online = true,
        ),
        DeviceRecord(
            id = "dev-android-1",
            name = "Maya's Phone",
            kind = "android",
            pairedAt = NOW - 86_400_000L * 5, // "5d ago"
            lastSeenAt = NOW - 600_000L, // "10m ago"
            online = false,
        ),
        DeviceRecord(
            id = "dev-agent-1",
            name = "Northstar Agent",
            kind = "agent",
            pairedAt = NOW - 86_400_000L * 2, // "2d ago"
            lastSeenAt = NOW - 120_000L, // "2m ago"
            capabilities = DeviceCapabilities(
                agentIntegration = AgentIntegrationCapability(
                    harness = "openclaw",
                    maxConcurrentRuns = 2,
                ),
            ),
            online = true,
        ),
    )

    // A laptop CLI whose access was revoked: the row and its sources stay, so
    // it renders with a Revoked badge, a revoked status line, and repair/forget
    // actions. Every timestamp is older than 7 days → pinned
    // absolute dates, stable across record and verify.
    private fun revokedDevice(): DeviceRecord = DeviceRecord(
        id = "dev-cli-old",
        name = "Old Laptop CLI",
        kind = "cli",
        pairedAt = OLD_EPOCH_2,
        lastSeenAt = OLD_EPOCH,
        capabilities = DeviceCapabilities(hostname = "old-laptop.local"),
        online = false,
        revokedAt = OLD_EPOCH,
    )

    private fun tokens(): Map<String, Loadable<List<TokenRecord>>> = mapOf(
        "dev-collector-1" to Loadable.Content(
            listOf(
                TokenRecord(
                    id = "tok-1",
                    deviceId = "dev-collector-1",
                    name = "initial",
                    scopes = listOf("admin", "write:*"),
                    createdAt = OLD_EPOCH, // > 7d → absolute date; pinned
                    lastUsedAt = NOW - 45_000L, // "just now"
                ),
                TokenRecord(
                    id = "tok-2",
                    deviceId = "dev-collector-1",
                    name = null,
                    scopes = listOf("read"),
                    createdAt = OLD_EPOCH_2, // > 7d → absolute date; pinned
                    lastUsedAt = null, // "never"
                ),
            ),
        ),
    )

    @Test
    fun devices_list_dark() = capture("devices_list_dark", dark = true) {
        DevicesContent(devices = Loadable.Content(devices()), tokens = tokens(), onBack = {}, onRetry = {})
    }

    @Test
    fun devices_list_light() = capture("devices_list_light", dark = false) {
        DevicesContent(devices = Loadable.Content(devices()), tokens = tokens(), onBack = {}, onRetry = {})
    }

    @Test
    fun devices_list_this_device_dark() = capture("devices_list_this_device_dark", dark = true) {
        // The current device pinned: a "This device" group (accent border +
        // badge), then Live connections, then a collapsed Other devices group.
        DevicesContent(
            devices = Loadable.Content(devices()),
            // Deliberately pin the phone fixture with no live socket: rendering this
            // active app as inactive was the reported regression.
            thisDeviceId = "dev-android-1",
            tokens = tokens(),
            onBack = {},
            onRetry = {},
        )
    }

    @Test
    fun devices_list_revoked_dark() = capture("devices_list_revoked_dark", dark = true) {
        // A revoked device counts in the stats bar and sits last in the (opened)
        // Other devices group, never under Live connections.
        DevicesContent(
            devices = Loadable.Content(devices() + revokedDevice()),
            thisDeviceId = "dev-android-1",
            tokens = tokens(),
            onBack = {},
            onRetry = {},
            otherExpanded = true,
        )
    }

    @Test
    fun devices_forget_refused_dark() = capture("devices_forget_refused_dark", dark = true) {
        // The gateway refused to forget a device that still hosts sources. The
        // refusal lands on the revoked card the Forget menu sits on, at the
        // bottom of the list, rather than on a banner pinned to the top of it.
        // The copy names a remedy this phone actually offers.
        DevicesContent(
            devices = Loadable.Content(devices() + revokedDevice()),
            thisDeviceId = "dev-android-1",
            tokens = tokens(),
            notice = DevicesViewModel.Notice(
                ok = false,
                text = "This device still hosts sources. Remove them from the Sources screen first, then forget it.",
                deviceId = revokedDevice().id,
            ),
            onBack = {},
            onRetry = {},
            otherExpanded = true,
        )
    }

    @Test
    fun devices_empty_dark() = capture("devices_empty_dark", dark = true) {
        DevicesContent(devices = Loadable.Content(emptyList()), tokens = emptyMap(), onBack = {}, onRetry = {})
    }

    @Test
    fun device_card_expanded_dark() = capture("device_card_expanded_dark", dark = true) {
        ThemedCardSurface {
            DeviceCard(
                device = devices()[0],
                tokens = tokens()["dev-collector-1"],
                startExpanded = true,
                now = NOW,
            )
        }
    }

    @Test
    fun device_card_no_tokens_dark() = capture("device_card_no_tokens_dark", dark = true) {
        ThemedCardSurface {
            DeviceCard(
                device = devices()[2],
                tokens = Loadable.Content(emptyList()),
                startExpanded = true,
                now = NOW,
            )
        }
    }

    @Test
    fun device_card_loading_dark() = capture("device_card_loading_dark", dark = true) {
        // The credential fetch has not resolved: the spinner row stands in for
        // the list, and the CLI footnote waits for the list it belongs under
        // rather than sitting beside the spinner.
        ThemedCardSurface {
            DeviceCard(
                device = devices()[1],
                tokens = Loadable.Loading,
                startExpanded = true,
                now = NOW,
            )
        }
    }

    @Test
    fun device_card_revoked_dark() = capture("device_card_revoked_dark", dark = true) {
        ThemedCardSurface {
            DeviceCard(device = revokedDevice(), tokens = Loadable.Content(emptyList()), startExpanded = true, now = NOW)
        }
    }

    @Test
    fun device_card_revoked_light() = capture("device_card_revoked_light", dark = false) {
        ThemedCardSurface {
            DeviceCard(device = revokedDevice(), tokens = Loadable.Content(emptyList()), startExpanded = true, now = NOW)
        }
    }

    // --- Pair-a-device sheet ------------------------------------------------

    // The form is the kind picker and the generate action only: the gateway
    // grants each kind its canonical scopes.
    @Test
    fun pair_form_dark() = capture("pair_form_dark", dark = true) {
        ThemedSurface { pairForm() }
    }

    @Test
    fun pair_form_light() = capture("pair_form_light", dark = false) {
        ThemedSurface { pairForm() }
    }

    @Composable
    private fun pairForm() {
        PairDeviceContent(
            pending = null,
            kind = null,
            qrPayload = null,
            qrError = null,
            submitting = false,
            error = null,
            onPair = {},
        )
    }

    @Test
    fun repair_form_dark() = capture("repair_form_dark", dark = true) {
        ThemedSurface { repairForm() }
    }

    @Test
    fun repair_form_light() = capture("repair_form_light", dark = false) {
        ThemedSurface { repairForm() }
    }

    @Composable
    private fun repairForm() {
        PairDeviceContent(
            pending = null,
            kind = null,
            qrPayload = null,
            qrError = null,
            submitting = false,
            error = null,
            onPair = {},
            repairTarget = devices()[1],
        )
    }

    // What the gateway answers for an iPhone: every label, summary and reason below is its own text.
    private val tailscaleName = PairingAddressOption(
        "https://gateway.tail1234.ts.net:7600", "gateway.tail1234.ts.net", "Tailscale name", usable = true,
        summary = "Works at home and away, as long as Tailscale is connected on the phone.", reach = "tailnet", systemTrust = true,
    )
    private val lanAddress = PairingAddressOption(
        "https://192.168.1.20:7600", "192.168.1.20", "Local network", usable = true,
        summary = "Works only while the phone is on the same network as the gateway, such as your home Wi-Fi.", reach = "local-network",
    )
    private val omnesisAddress = PairingAddressOption(
        "https://g-7f3a91.relay.example.com", "g-7f3a91.relay.example.com", "Omnesis address", usable = true,
        summary = "Works from anywhere. Needs remote access to stay on.", reach = "anywhere", kind = "relay",
    )
    private val tailscaleIp = PairingAddressOption(
        "https://100.64.0.7:7600", "100.64.0.7", "Tailscale IP", usable = false,
        reason = "iPhones can't use the gateway's Tailscale IP address: its certificate covers the name gateway.tail1234.ts.net, " +
            "which works at home and away while Tailscale is connected on the phone.",
    )

    @Composable
    private fun pairResult(plan: PairingAddressPlan, selected: PairingAddressOption?, expanded: Boolean = true) {
        PairDeviceContent(
            pending = PendingPairing(pairingCode = "7K3M-9QX2", expiresAt = NOW + 540_000L),
            kind = "ios",
            qrPayload = selected?.let { "{\"v\":4,\"gatewayUrl\":\"${it.gatewayUrl}\",\"pairingCode\":\"7K3M-9QX2\",\"tls\":{\"mode\":\"system\"}}" },
            qrError = null,
            submitting = false,
            error = null,
            onPair = {},
            addressPlan = plan,
            selectedUrl = selected?.gatewayUrl,
            expanded = expanded,
        )
    }

    /** As the sheet opens: the QR, where the address works, and both disclosures closed. */
    @Test
    @Config(qualifiers = "w411dp-h1300dp-xxhdpi")
    fun pair_addresses_collapsed_dark() = capture("pair_addresses_collapsed_dark", dark = true) {
        ThemedSurface {
            pairResult(
                PairingAddressPlan("ios", listOf(omnesisAddress, tailscaleName, lanAddress, tailscaleIp), recommendedUrl = omnesisAddress.gatewayUrl),
                omnesisAddress,
                expanded = false,
            )
        }
    }

    @Test
    fun pair_result_relay_dark() = capture("pair_result_relay_dark", dark = true) {
        ThemedSurface {
            pairResult(PairingAddressPlan("ios", listOf(tailscaleName), recommendedUrl = tailscaleName.gatewayUrl), tailscaleName)
        }
    }

    /** A Tailscale name, a LAN address and the Omnesis address to choose from, and one this phone is refused. */
    @Composable
    private fun pairAddresses() = pairResult(
        PairingAddressPlan("ios", listOf(omnesisAddress, tailscaleName, lanAddress, tailscaleIp), recommendedUrl = omnesisAddress.gatewayUrl),
        omnesisAddress,
    )

    @Test
    @Config(qualifiers = "w411dp-h1300dp-xxhdpi")
    fun pair_addresses_light() = capture("pair_addresses_light", dark = false) { ThemedSurface { pairAddresses() } }

    @Test
    @Config(qualifiers = "w411dp-h1300dp-xxhdpi")
    fun pair_addresses_dark() = capture("pair_addresses_dark", dark = true) { ThemedSurface { pairAddresses() } }

    /** Only the home network is offered, so the screen says how to reach the gateway away from home. */
    @Test
    @Config(qualifiers = "w411dp-h1300dp-xxhdpi")
    fun pair_addresses_home_only_light() = capture("pair_addresses_home_only_light", dark = false) {
        ThemedSurface {
            pairResult(
                PairingAddressPlan("ios", listOf(lanAddress, tailscaleIp), recommendedUrl = lanAddress.gatewayUrl, awayFromHome = AwayFromHomeHint(onTailnet = true, tailscaleName = "gateway.tail1234.ts.net")),
                lanAddress,
            )
        }
    }

    @Test
    fun repair_result_relay_dark() = capture("repair_result_relay_dark", dark = true) {
        ThemedSurface { repairResult() }
    }

    @Test
    fun repair_result_relay_light() = capture("repair_result_relay_light", dark = false) {
        ThemedSurface { repairResult() }
    }

    @Composable
    private fun repairResult() {
        PairDeviceContent(
            pending = PendingPairing(pairingCode = "7K3M-9QX2", expiresAt = NOW + 540_000L),
            kind = "android",
            qrPayload = "{\"v\":4,\"gatewayUrl\":\"https://gateway.example:7600\",\"pairingCode\":\"7K3M-9QX2\",\"tls\":{\"mode\":\"system\"}}",
            qrError = null,
            submitting = false,
            error = null,
            onPair = {},
            repairTarget = devices()[1],
            addressPlan = PairingAddressPlan(
                "android",
                listOf(PairingAddressOption("https://gateway.example:7600", "gateway.example", "Public address", usable = true, summary = "Works wherever the phone can reach gateway.example.", reach = "anywhere", systemTrust = true)),
                recommendedUrl = "https://gateway.example:7600",
            ),
            selectedUrl = "https://gateway.example:7600",
        )
    }

    @Test
    fun pair_agent_result_relay_light() = capture("pair_agent_result_relay_light", dark = false) {
        ThemedSurface { agentPairResult() }
    }

    @Test
    fun pair_agent_result_relay_dark() = capture("pair_agent_result_relay_dark", dark = true) {
        ThemedSurface { agentPairResult() }
    }

    /** The agent's commands name the gateway's recommended address; the other one is a tap away. */
    @Composable
    private fun agentPairResult() {
        val agentLan = lanAddress.copy(summary = "Works only while the device is on the same network as the gateway, such as your home Wi-Fi.")
        val agentTailscale = tailscaleName.copy(summary = "Works at home and away, as long as Tailscale is connected on the device.")
        PairDeviceContent(
            pending = PendingPairing(
                pairingCode = "FICTION-2486",
                expiresAt = NOW + 540_000L,
            ),
            kind = "agent",
            qrPayload = null,
            qrError = null,
            submitting = false,
            error = null,
            onPair = {},
            addressPlan = PairingAddressPlan(null, listOf(agentTailscale, agentLan), recommendedUrl = agentTailscale.gatewayUrl),
            selectedUrl = agentTailscale.gatewayUrl,
            expanded = true,
        )
    }

    // --- The pair sheet of a build without cloud connectivity: main's, byte for byte ------
    // These keep main's names and goldens; the cases above render the cloud build's sheet.

    @Test
    fun pair_result_dark() = capture("pair_result_dark", dark = true) {
        ThemedSurface {
            LegacyPairDeviceContent(
                pending = PendingPairing(
                    pairingCode = "7K3M-9QX2",
                    expiresAt = NOW + 540_000L,
                ),
                kind = "ios",
                identities = listOf(
                    NetworkIdentity("host.example", "Public HTTPS", "public", true),
                    NetworkIdentity("192.0.2.42", "LAN (en0)", "lan", false),
                    NetworkIdentity("198.51.100.7", "Tailscale (off-LAN)", "tailscale", true),
                ),
                selectedHostIdx = 0,
                qrPayload = "{\"v\":4,\"gatewayUrl\":\"https://host.example:7600\",\"pairingCode\":\"7K3M-9QX2\",\"tls\":{\"mode\":\"system\"}}",
                qrError = null,
                submitting = false,
                error = null,
                onPair = {},
                onSelectHost = {},
            )
        }
    }

    @Test
    fun repair_result_dark() = capture("repair_result_dark", dark = true) {
        ThemedSurface { legacyRepairResult() }
    }

    @Test
    fun repair_result_light() = capture("repair_result_light", dark = false) {
        ThemedSurface { legacyRepairResult() }
    }

    @Composable
    private fun legacyRepairResult() {
        LegacyPairDeviceContent(
            pending = PendingPairing(pairingCode = "7K3M-9QX2", expiresAt = NOW + 540_000L),
            kind = "android",
            identities = listOf(NetworkIdentity("gateway.example", "Public HTTPS", "public", true)),
            selectedHostIdx = 0,
            qrPayload = "{\"v\":4,\"gatewayUrl\":\"https://gateway.example:7600\",\"pairingCode\":\"7K3M-9QX2\",\"tls\":{\"mode\":\"system\"}}",
            qrError = null,
            submitting = false,
            error = null,
            onPair = {},
            onSelectHost = {},
            repairTarget = devices()[1],
        )
    }

    @Test
    fun pair_agent_result_light() = capture("pair_agent_result_light", dark = false) {
        ThemedSurface { legacyAgentPairResult() }
    }

    @Test
    fun pair_agent_result_dark() = capture("pair_agent_result_dark", dark = true) {
        ThemedSurface { legacyAgentPairResult() }
    }

    @Composable
    private fun legacyAgentPairResult() {
        LegacyPairDeviceContent(
            pending = PendingPairing(
                pairingCode = "FICTION-2486",
                expiresAt = NOW + 540_000L,
            ),
            kind = "agent",
            gatewayUrl = "https://gateway.example:7600",
            identities = emptyList(),
            selectedHostIdx = 0,
            qrPayload = null,
            qrError = null,
            submitting = false,
            error = null,
            onPair = {},
            onSelectHost = {},
        )
    }

    /** A single card on the app background, padded — isolates the expanded-card layout. */
    @Composable
    private fun ThemedCardSurface(content: @Composable () -> Unit) {
        androidx.compose.foundation.layout.Box(
            Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary).padding(OmSpacing.lg),
        ) { content() }
    }

    /** Full-bleed app-background surface for the pair sheet contents. */
    @Composable
    private fun ThemedSurface(content: @Composable () -> Unit) {
        androidx.compose.foundation.layout.Box(
            Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary),
        ) { content() }
    }
}
