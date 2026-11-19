// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.omi

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class OmiProtocolTest {
    private val frames = mutableListOf<List<Int>>()
    private val assembler = OmiFrameAssembler { frames += it.map(Byte::toInt) }

    private fun packet(counter: Int, fragment: Int, vararg payload: Int) =
        byteArrayOf((counter and 0xFF).toByte(), (counter shr 8 and 0xFF).toByte(), fragment.toByte()) +
            payload.map(Int::toByte).toByteArray()

    @Test fun aFrameIsDeliveredWhenTheNextOneStarts() {
        assembler.accept(packet(7, 0, 1, 2))
        assertEquals(emptyList<List<Int>>(), frames)
        assembler.accept(packet(8, 0, 3))
        assertEquals(listOf(listOf(1, 2)), frames)
    }

    @Test fun fragmentsOfOneFrameAreJoined() {
        assembler.accept(packet(1, 0, 1))
        assembler.accept(packet(2, 1, 2))
        assembler.accept(packet(3, 2, 3))
        assembler.accept(packet(4, 0, 9))
        assertEquals(listOf(listOf(1, 2, 3)), frames)
    }

    @Test fun theCounterWrapsAround() {
        assembler.accept(packet(65_535, 0, 1))
        assembler.accept(packet(0, 0, 2))
        assembler.accept(packet(1, 0, 3))
        assertEquals(listOf(listOf(1), listOf(2)), frames)
    }

    @Test fun aLostPacketDropsTheFrameItBelongedTo() {
        assembler.accept(packet(1, 0, 1))
        assembler.accept(packet(2, 1, 2))
        // 3 is lost: the frame in progress is incomplete.
        assembler.accept(packet(4, 2, 3))
        assembler.accept(packet(5, 0, 4))
        assembler.accept(packet(6, 0, 5))
        assertEquals(listOf(listOf(4)), frames)
        assertEquals(1, assembler.lost)
    }

    @Test fun aLostSingleFramePacketDropsTheFrameBeforeTheGap() {
        assembler.accept(packet(1, 0, 1))
        assembler.accept(packet(3, 0, 3)) // 2 lost: frame 1 may have continued in it
        assembler.accept(packet(4, 0, 4))
        assertEquals(listOf(listOf(3)), frames)
        assertEquals(1, assembler.lost)
    }

    @Test fun aStreamJoinedMidFrameWaitsForTheNextStart() {
        assembler.accept(packet(10, 1, 7))
        assembler.accept(packet(11, 0, 1))
        assembler.accept(packet(12, 0, 2))
        assertEquals(listOf(listOf(1)), frames)
        assertEquals(0, assembler.lost)
    }

    @Test fun resetForgetsTheFrameInProgress() {
        assembler.accept(packet(1, 0, 1))
        assembler.reset()
        assembler.accept(packet(2, 0, 2))
        assembler.accept(packet(3, 0, 3))
        assertEquals(listOf(listOf(2)), frames)
    }

    @Test fun shortPacketsAreIgnored() {
        assembler.accept(byteArrayOf(1, 0))
        assertEquals(emptyList<List<Int>>(), frames)
    }

    @Test fun deviceDetails() {
        assertEquals("3.0.21", OmiProtocol.text("3.0.21\u0000\u0000".toByteArray()))
        assertNull(OmiProtocol.text(byteArrayOf(0, 0)))
        // Button, battery, USB, haptics, offline storage, LED dimming: 0b1111_1100.
        assertEquals(
            listOf("Button", "Battery", "USB", "Haptics", "Offline storage", "LED dimming"),
            OmiProtocol.features(byteArrayOf(0xFC.toByte(), 0, 0, 0)),
        )
        assertEquals(listOf("Microphone gain"), OmiProtocol.features(byteArrayOf(0, 1)))
        val status = byteArrayOf(0x00, 0x10, 0, 0, 0x2A, 0, 0, 0, 0x00, 0x00, 0x00, 0x01, 1, 0, 0, 0)
        assertEquals(
            OmiStorage(usedBytes = 4_096, unreadPackets = 42, freeBytes = 16_777_216, clockSet = true),
            OmiProtocol.storage(status),
        )
        assertNull(OmiProtocol.storage(ByteArray(8)))
    }

    @Test fun theClockIsWrittenAsLittleEndianEpochSeconds() {
        // 1_795_086_000 s = 0x6AFED6B0; the milliseconds are dropped.
        assertEquals(
            listOf(0xB0, 0xD6, 0xFE, 0x6A),
            OmiProtocol.epochSeconds(1_795_086_000_123L).map { it.toInt() and 0xFF },
        )
    }

    @Test fun buttonAndBatteryValues() {
        assertEquals(OmiButton.TAP, OmiProtocol.buttonEvent(byteArrayOf(1, 0, 0, 0)))
        assertEquals(OmiButton.DOUBLE_TAP, OmiProtocol.buttonEvent(byteArrayOf(2)))
        assertEquals(OmiButton.RELEASED, OmiProtocol.buttonEvent(byteArrayOf(5)))
        assertNull(OmiProtocol.buttonEvent(byteArrayOf(3)))
        assertNull(OmiProtocol.buttonEvent(byteArrayOf()))
        assertEquals(87, OmiProtocol.battery(byteArrayOf(87)))
        assertNull(OmiProtocol.battery(byteArrayOf(-1)))
    }
}
