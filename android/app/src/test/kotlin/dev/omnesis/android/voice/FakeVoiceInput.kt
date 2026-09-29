// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.voice

import dev.omnesis.android.transport.dto.DictationStatusDto
import kotlinx.coroutines.flow.MutableStateFlow

/** A scripted [VoiceInput]: records what the surface asked for and hands the test its listener. */
class FakeVoiceInput(private val available: Boolean = true) : VoiceInput {
    var listener: VoiceInput.Listener? = null
    var endpointing: Endpointing? = null
    var startCount = 0
    var stopCount = 0
    var cancelCount = 0
    var retryCount = 0

    override fun isAvailable() = available

    override fun start(endpointing: Endpointing, listener: VoiceInput.Listener) {
        this.endpointing = endpointing
        this.listener = listener
        startCount++
    }

    override fun stop() {
        stopCount++
    }

    override fun cancel() {
        cancelCount++
    }

    override fun retry() {
        retryCount++
    }
}

/** [VoiceInputs] whose gateway and on-device engines hand out the given fakes in order. */
class ScriptedVoiceInputs(
    gatewayActive: Boolean,
    private val gateway: MutableList<FakeVoiceInput> = mutableListOf(),
    private val onDevice: MutableList<FakeVoiceInput> = mutableListOf(),
    onDeviceAvailable: Boolean = true,
) {
    val status = MutableStateFlow(
        if (gatewayActive) DictationStatusDto(visible = true, enabled = true, modelAssigned = true, active = true) else null,
    )
    val gatewayMade = mutableListOf<FakeVoiceInput>()
    var statusRefreshes = 0
    val onDeviceMade = mutableListOf<FakeVoiceInput>()
    val inputs = VoiceInputs(
        gatewayStatus = status,
        newOnDevice = { onDevice.removeAt(0).also(onDeviceMade::add) },
        newGateway = { _, _ -> gateway.removeAt(0).also(gatewayMade::add) },
        onDeviceAvailable = { onDeviceAvailable },
        refreshGatewayStatus = { statusRefreshes++ },
    )
}
