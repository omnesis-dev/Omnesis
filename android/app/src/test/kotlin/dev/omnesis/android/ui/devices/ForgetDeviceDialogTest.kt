// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.DeviceForgetData
import dev.omnesis.android.transport.dto.DeviceForgetImpact
import dev.omnesis.android.transport.dto.DeviceForgetSourceImpact
import dev.omnesis.android.transport.dto.DeviceRecord
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class ForgetDeviceDialogTest {
    @get:Rule val compose = createComposeRule()
    private val device = DeviceRecord("retired-phone", name = "Retired phone", kind = "android", revokedAt = 1)
    private val impact = DeviceForgetImpact(
        listOf(DeviceForgetSourceImpact("activity:local", "activity", "partitioned", 1, "partition")),
        "review-1",
    )

    @Test fun `confirmation keeps historical data by default`() {
        val choices = mutableListOf<DeviceForgetData>()
        compose.setContent {
            OmnesisTheme {
                ForgetDeviceDialog(DevicesViewModel.ForgetState(device, impact, loading = false), { choices += it }, {}, {})
            }
        }
        compose.onNodeWithText("Forget device").performClick()
        assertEquals(listOf(DeviceForgetData.Keep), choices)
    }

    @Test fun `deletion requires explicit selection and a destructive confirmation`() {
        val choices = mutableListOf<DeviceForgetData>()
        compose.setContent {
            OmnesisTheme {
                ForgetDeviceDialog(DevicesViewModel.ForgetState(device, impact, loading = false), { choices += it }, {}, {})
            }
        }
        compose.onNodeWithText("Delete this device’s data").performClick()
        assertEquals(emptyList<DeviceForgetData>(), choices)
        compose.onNodeWithText("Forget and delete data").performClick()
        assertEquals(listOf(DeviceForgetData.Delete), choices)
    }

    @Test fun `a refreshed source impact resets the choice to keep`() {
        val choices = mutableListOf<DeviceForgetData>()
        val state = mutableStateOf(DevicesViewModel.ForgetState(device, impact, loading = false))
        compose.setContent {
            OmnesisTheme { ForgetDeviceDialog(state.value, { choices += it }, {}, {}) }
        }
        compose.onNodeWithText("Delete this device’s data").performClick()
        compose.runOnIdle { state.value = state.value.copy(impact = impact.copy(fingerprint = "review-2")) }
        compose.onNodeWithText("Forget device").performClick()
        assertEquals(listOf(DeviceForgetData.Keep), choices)
    }

    @Test fun `a pending request cannot be confirmed twice or dismissed`() {
        compose.setContent {
            OmnesisTheme {
                ForgetDeviceDialog(DevicesViewModel.ForgetState(device, impact, loading = false, submitting = true), {}, {}, {})
            }
        }
        compose.onNodeWithText("Forgetting…").assertIsNotEnabled()
        compose.onNodeWithText("Cancel").assertIsNotEnabled()
    }
}
