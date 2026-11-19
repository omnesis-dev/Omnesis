// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.omi

import java.util.UUID

/**
 * The Omi pendant's GATT protocol, as its open-source firmware defines it
 * (github.com/BasedHardware/omi, `omi/firmware/omi/src`, MIT): the audio
 * service and its framing, the button, the haptic motor, the settings
 * (capture mute, LED, microphone gain, charging), the clock, the battery,
 * device information, the feature mask and the status of the pendant's own
 * storage. Nothing here touches Bluetooth; [OmiLink] does.
 */
object OmiProtocol {
    val AUDIO_SERVICE: UUID = UUID.fromString("19b10000-e8f2-537e-4f6c-d104768a1214")
    val AUDIO_DATA: UUID = UUID.fromString("19b10001-e8f2-537e-4f6c-d104768a1214")
    val AUDIO_CODEC: UUID = UUID.fromString("19b10002-e8f2-537e-4f6c-d104768a1214")

    val SETTINGS_SERVICE: UUID = UUID.fromString("19b10010-e8f2-537e-4f6c-d104768a1214")
    val CAPTURE_MUTE: UUID = UUID.fromString("19b10015-e8f2-537e-4f6c-d104768a1214")

    val BUTTON_SERVICE: UUID = UUID.fromString("23ba7924-0000-1000-7450-346eac492e92")
    val BUTTON_EVENT: UUID = UUID.fromString("23ba7925-0000-1000-7450-346eac492e92")

    val HAPTIC_SERVICE: UUID = UUID.fromString("cab1ab95-2ea5-4f4d-bb56-874b72cfc984")
    val HAPTIC: UUID = UUID.fromString("cab1ab96-2ea5-4f4d-bb56-874b72cfc984")

    val BATTERY_SERVICE: UUID = UUID.fromString("0000180f-0000-1000-8000-00805f9b34fb")
    val BATTERY_LEVEL: UUID = UUID.fromString("00002a19-0000-1000-8000-00805f9b34fb")

    val DEVICE_INFO_SERVICE: UUID = UUID.fromString("0000180a-0000-1000-8000-00805f9b34fb")
    val MODEL_NUMBER: UUID = UUID.fromString("00002a24-0000-1000-8000-00805f9b34fb")
    val SERIAL_NUMBER: UUID = UUID.fromString("00002a25-0000-1000-8000-00805f9b34fb")
    val FIRMWARE_REVISION: UUID = UUID.fromString("00002a26-0000-1000-8000-00805f9b34fb")
    val HARDWARE_REVISION: UUID = UUID.fromString("00002a27-0000-1000-8000-00805f9b34fb")
    val MANUFACTURER: UUID = UUID.fromString("00002a29-0000-1000-8000-00805f9b34fb")

    /**
     * LED brightness, 0–100. Read only here: firmware 3.0.21 saves every write
     * to flash in its Bluetooth thread, stalling the link long enough to drop it.
     */
    val LED_DIM_RATIO: UUID = UUID.fromString("19b10011-e8f2-537e-4f6c-d104768a1214")

    /** Microphone gain level, 0–8. */
    val MIC_GAIN: UUID = UUID.fromString("19b10012-e8f2-537e-4f6c-d104768a1214")

    /** 1 while charging. Read only: subscribing to its notifications dropped the link on firmware 3.0.21. */
    val CHARGING: UUID = UUID.fromString("19b10013-e8f2-537e-4f6c-d104768a1214")

    val TIME_SYNC_SERVICE: UUID = UUID.fromString("19b10030-e8f2-537e-4f6c-d104768a1214")

    /** Write the UTC time as 32-bit little-endian epoch seconds; the pendant's clock dates what it stores. */
    val TIME_SYNC: UUID = UUID.fromString("19b10031-e8f2-537e-4f6c-d104768a1214")

    val FEATURES_SERVICE: UUID = UUID.fromString("19b10020-e8f2-537e-4f6c-d104768a1214")
    val FEATURES: UUID = UUID.fromString("19b10021-e8f2-537e-4f6c-d104768a1214")

    val STORAGE_SERVICE: UUID = UUID.fromString("30295780-4301-eabd-2904-2849adfeae43")

    /** Four little-endian 32-bit values: bytes used, audio packets not yet read, bytes free, clock set. */
    val STORAGE_STATUS: UUID = UUID.fromString("30295782-4301-eabd-2904-2849adfeae43")

    /** Client characteristic configuration descriptor: turns notifications on and off. */
    val CCC: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    /** Opus, 16 kHz mono, 20 ms frames: the only codec current firmware sends, and the only one accepted. */
    const val CODEC_OPUS_16K_20MS = 21

    /** The MTU the pendant's own app asks for; its firmware sends up to 498-byte packets. */
    const val MTU = 512

    /** Bytes before an audio packet's payload: a 16-bit packet counter and a fragment index. */
    const val AUDIO_HEADER_BYTES = 3

    fun buttonEvent(value: ByteArray): OmiButton? = when (value.firstOrNull()?.toInt()) {
        1 -> OmiButton.TAP
        2 -> OmiButton.DOUBLE_TAP
        4 -> OmiButton.PRESSED
        5 -> OmiButton.RELEASED
        else -> null
    }

    fun battery(value: ByteArray): Int? = value.firstOrNull()?.toInt()?.and(0xFF)?.takeIf { it in 0..100 }

    fun mute(muted: Boolean): ByteArray = byteArrayOf(if (muted) 1 else 0)

    fun epochSeconds(epochMs: Long): ByteArray {
        val s = epochMs / 1000
        return ByteArray(4) { i -> (s shr (8 * i) and 0xFF).toByte() }
    }

    /** A device-information string, trimmed of the NULs some firmware pads with; null when empty. */
    fun text(value: ByteArray?): String? = value?.toString(Charsets.UTF_8)?.trim('\u0000', ' ')?.takeIf { it.isNotEmpty() }

    fun byte(value: ByteArray?): Int? = value?.firstOrNull()?.toInt()?.and(0xFF)

    /** The feature bitmask the firmware reports, as names, in bit order. */
    fun features(value: ByteArray?): List<String>? {
        value ?: return null
        var mask = 0L
        value.take(4).forEachIndexed { i, b -> mask = mask or ((b.toLong() and 0xFF) shl (8 * i)) }
        return FEATURE_NAMES.filterIndexed { bit, _ -> mask and (1L shl bit) != 0L }
    }

    private val FEATURE_NAMES = listOf(
        "Speaker", "Accelerometer", "Button", "Battery", "USB", "Haptics", "Offline storage", "LED dimming", "Microphone gain",
    )

    fun storage(value: ByteArray?): OmiStorage? {
        if (value == null || value.size < 16) return null
        fun u32(at: Int) = (0 until 4).fold(0L) { acc, i -> acc or ((value[at + i].toLong() and 0xFF) shl (8 * i)) }
        return OmiStorage(usedBytes = u32(0), unreadPackets = u32(4), freeBytes = u32(8), clockSet = u32(12) != 0L)
    }
}

/** The pendant's own storage, where it keeps audio while no phone receives it. */
data class OmiStorage(val usedBytes: Long, val unreadPackets: Long, val freeBytes: Long, val clockSet: Boolean)

/** Everything the pendant tells about itself, read when the details are opened. */
data class OmiDetails(
    val name: String? = null,
    val address: String? = null,
    val manufacturer: String? = null,
    val model: String? = null,
    val hardware: String? = null,
    val firmware: String? = null,
    val serial: String? = null,
    val battery: Int? = null,
    val charging: Boolean? = null,
    val encrypted: Boolean = false,
    val mtu: Int? = null,
    val rssi: Int? = null,
    val ledBrightness: Int? = null,
    val micGain: Int? = null,
    val canMute: Boolean = true,
    val features: List<String>? = null,
    val storage: OmiStorage? = null,
    /** Audio frames lost on the link since the current recording started. */
    val framesLost: Int? = null,
)

/** A button event the pendant reports. A long press switches it off and is never reported. */
enum class OmiButton { TAP, DOUBLE_TAP, PRESSED, RELEASED }

/**
 * Vibrations, as the writes to the haptic characteristic they take: the
 * firmware plays 1 as 100 ms, 2 as 300 ms and 3 as 500 ms, one at a time, so
 * a pattern of several pulses is several writes with a pause between them.
 */
enum class Haptic(val pulses: List<Byte>) {
    /** One very short pulse: recording started. */
    STARTED(listOf(1)),

    /** Two very short pulses: recording stopped. */
    STOPPED(listOf(1, 1)),

    /** One long pulse: the recording could not start. */
    FAILED(listOf(3)),
    ;

    companion object {
        /** Between two pulses: the 100 ms pulse plus a gap the wearer can feel. */
        const val GAP_MS = 250L
    }
}

/**
 * Rebuilds Opus frames from the audio notifications. Each notification is
 * `[counter lo, counter hi, fragment]` and a payload; fragment 0 starts a
 * frame, which ends where the next fragment 0 begins. A notification lost in
 * between (a counter that skips, a fragment out of order) drops the frame in
 * progress and waits for the next start, as the pendant's own app does.
 * Single-threaded: feed it from the GATT callback.
 */
class OmiFrameAssembler(private val onFrame: (ByteArray) -> Unit) {
    private var lastCounter = -1
    private var lastFragment = -1
    private var pending: java.io.ByteArrayOutputStream? = null

    /** Frames dropped since the last [reset]. */
    var lost = 0
        private set

    fun accept(packet: ByteArray) {
        if (packet.size < OmiProtocol.AUDIO_HEADER_BYTES) return
        val counter = (packet[0].toInt() and 0xFF) or ((packet[1].toInt() and 0xFF) shl 8)
        val fragment = packet[2].toInt() and 0xFF
        val inOrder = lastCounter >= 0 && counter == (lastCounter + 1) and 0xFFFF
        val previous = pending
        when {
            fragment == 0 -> {
                if (previous != null) {
                    if (inOrder) emit(previous) else lost++
                }
                pending = java.io.ByteArrayOutputStream()
            }
            previous == null -> {
                // Waiting for the start of a frame.
                lastCounter = counter
                return
            }
            !inOrder || fragment != lastFragment + 1 -> {
                lost++
                pending = null
                lastCounter = counter
                return
            }
        }
        pending!!.write(packet, OmiProtocol.AUDIO_HEADER_BYTES, packet.size - OmiProtocol.AUDIO_HEADER_BYTES)
        lastCounter = counter
        lastFragment = fragment
    }

    fun reset() {
        lastCounter = -1
        lastFragment = -1
        pending = null
        lost = 0
    }

    private fun emit(frame: java.io.ByteArrayOutputStream) {
        if (frame.size() > 0) onFrame(frame.toByteArray())
    }
}
