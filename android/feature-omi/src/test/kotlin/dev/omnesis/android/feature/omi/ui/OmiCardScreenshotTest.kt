// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.omi.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.feature.omi.OmiDetails
import dev.omnesis.android.feature.omi.OmiStatus
import dev.omnesis.android.feature.omi.OmiStorage
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Render-review screenshots for the Omi pendant: its Settings card (not
 * linked, linking, connected with and without encryption or a capture mute,
 * out of reach, firmware the app cannot read), the details panel and the
 * one-line status on the Recordings screen, light + dark.
 *
 *   ./gradlew :feature-omi:recordRoborazziDebug   ->   feature-omi/src/test/roborazzi/
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class OmiCardScreenshotTest {

    private fun capture(name: String, dark: Boolean, state: OmiCardState) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) {
                    Box(Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary).padding(16.dp)) {
                        OmiCardContent(state, onAssociate = {}, onForget = {})
                    }
                }
            }
        }
    }

    private fun captureDetails(name: String, dark: Boolean, status: OmiStatus, details: OmiDetails?) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) {
                    Box(Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary).padding(top = 16.dp)) {
                        OmiDetailsContent(status, details, onFind = {})
                    }
                }
            }
        }
    }

    /** Invented values in the shape firmware 3.0.21 reports. */
    private val details = OmiDetails(
        name = "Omi",
        address = "AA:BB:CC:00:00:01",
        manufacturer = "Example Hardware",
        model = "Omi CV1",
        hardware = "Seeed Xiao BLE Sense",
        firmware = "3.0.21",
        battery = 89,
        charging = false,
        encrypted = true,
        mtu = 498,
        rssi = -58,
        ledBrightness = 100,
        micGain = 4,
        canMute = false,
        features = listOf("Button", "Battery", "USB", "Haptics", "Offline storage", "LED dimming"),
        storage = OmiStorage(usedBytes = 3_400_000, unreadPackets = 1_250, freeBytes = 120_000_000, clockSet = true),
    )

    @Test fun always_on_light() = capture("omi_card_always_on_light", false, OmiCardState(OmiStatus.Ready(89, true), alwaysOn = true))
    @Test fun always_on_dark() = capture("omi_card_always_on_dark", true, OmiCardState(OmiStatus.Ready(89, true), alwaysOn = true))

    @Test fun details_light() = captureDetails("omi_details_light", false, OmiStatus.Ready(89, true, canMute = false), details)
    @Test fun details_dark() = captureDetails("omi_details_dark", true, OmiStatus.Ready(89, true, canMute = false), details)
    @Test fun details_not_linked_light() = captureDetails("omi_details_not_linked_light", false, OmiStatus.Disconnected, null)

    private fun captureRow(name: String, dark: Boolean, status: OmiStatus) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) {
                    Box(Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary).padding(16.dp)) {
                        OmiRecordingRowContent(status, onOpenSettings = {})
                    }
                }
            }
        }
    }

    @Test fun row_connected_light() = captureRow("omi_row_connected_light", false, OmiStatus.Ready(89, true))
    @Test fun row_connected_dark() = captureRow("omi_row_connected_dark", true, OmiStatus.Ready(89, true))
    @Test fun row_not_linked_light() = captureRow("omi_row_not_linked_light", false, OmiStatus.NotPaired)
    @Test fun row_disconnected_light() = captureRow("omi_row_disconnected_light", false, OmiStatus.Disconnected)

    @Test fun formatsSignalAndSizes() {
        assertEquals("strong", signalWord(-58))
        assertEquals("weak", signalWord(-80))
        assertEquals("3.4 MB", bytes(3_400_000))
        assertEquals("512 bytes", bytes(512))
    }

    @Test fun not_linked_light() = capture("omi_not_linked_light", false, OmiCardState())
    @Test fun not_linked_dark() = capture("omi_not_linked_dark", true, OmiCardState())

    @Test fun linking_light() = capture("omi_linking_light", false, OmiCardState(associating = true))

    @Test fun pairing_error_light() = capture(
        "omi_pairing_error_light",
        false,
        OmiCardState(error = "Nearby devices access is needed to link the pendant."),
    )

    @Test fun connected_light() = capture("omi_connected_light", false, OmiCardState(OmiStatus.Ready(battery = 82, encrypted = true)))
    @Test fun connected_dark() = capture("omi_connected_dark", true, OmiCardState(OmiStatus.Ready(battery = 82, encrypted = true)))

    @Test fun no_mute_light() = capture(
        "omi_no_mute_light",
        false,
        OmiCardState(OmiStatus.Ready(battery = 91, encrypted = true, canMute = false)),
    )

    @Test fun unencrypted_light() = capture("omi_unencrypted_light", false, OmiCardState(OmiStatus.Ready(battery = 40, encrypted = false)))

    @Test fun connecting_dark() = capture("omi_connecting_dark", true, OmiCardState(OmiStatus.Connecting))

    @Test fun disconnected_light() = capture("omi_disconnected_light", false, OmiCardState(OmiStatus.Disconnected))

    @Test fun unsupported_light() = capture("omi_unsupported_light", false, OmiCardState(OmiStatus.Unsupported(codec = 1)))
}
