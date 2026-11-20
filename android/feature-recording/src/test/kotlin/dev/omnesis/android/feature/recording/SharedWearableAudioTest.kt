// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedWearableAudioTest {
    private class Device : WearableAudio {
        override val name = "Pendant"
        override val ready: StateFlow<Boolean> = MutableStateFlow(true)
        var sink: WearableAudio.FrameSink? = null
        var starts = 0
        var stops = 0
        var accept = true

        override fun startStreaming(sink: WearableAudio.FrameSink): Boolean {
            if (!accept) return false
            starts++
            this.sink = sink
            return true
        }

        override fun stopStreaming() {
            stops++
            sink = null
        }

        fun send(vararg bytes: Byte) = sink!!.onFrame(bytes, 0)

        fun drop() = sink!!.also { sink = null }.onLinkLost()
    }

    private class Heard : WearableAudio.FrameSink {
        val frames = mutableListOf<Byte>()
        var lost = 0
        override fun onFrame(frame: ByteArray, receivedAtMs: Long) {
            frames += frame.toList()
        }

        override fun onLinkLost() {
            lost++
        }
    }

    @Test fun theDeviceStreamsWhileAnyViewDoes() {
        val device = Device()
        val shared = SharedWearableAudio(device)
        val recorder = shared.view()
        val listener = shared.view()
        val a = Heard()
        val b = Heard()

        assertTrue(listener.startStreaming(b))
        device.send(1)
        assertTrue(recorder.startStreaming(a))
        device.send(2)
        assertEquals(1, device.starts)

        recorder.stopStreaming()
        device.send(3)
        assertEquals(0, device.stops)
        listener.stopStreaming()
        assertEquals(1, device.stops)
        assertNull(device.sink)

        assertEquals(listOf<Byte>(2), a.frames)
        assertEquals(listOf<Byte>(1, 2, 3), b.frames)
    }

    @Test fun aLostLinkReachesEveryViewAndEachStartsAgainOnItsOwn() {
        val device = Device()
        val shared = SharedWearableAudio(device)
        val recorder = shared.view()
        val listener = shared.view()
        val a = Heard()
        val b = Heard()
        recorder.startStreaming(a)
        listener.startStreaming(b)

        device.drop()
        assertEquals(1, a.lost)
        assertEquals(1, b.lost)

        assertTrue(listener.startStreaming(b))
        assertEquals(2, device.starts)
        device.send(4)
        assertEquals(listOf<Byte>(4), b.frames)
        assertTrue(a.frames.isEmpty())
    }

    @Test fun aRefusedStartLeavesNothingBehind() {
        val device = Device().apply { accept = false }
        val shared = SharedWearableAudio(device)
        val view = shared.view()
        assertFalse(view.startStreaming(Heard()))
        view.stopStreaming()
        assertEquals(0, device.stops)
        device.accept = true
        assertTrue(view.startStreaming(Heard()))
        assertEquals(1, device.starts)
    }

    @Test fun startingAgainReplacesTheViewsSink() {
        val device = Device()
        val view = SharedWearableAudio(device).view()
        val first = Heard()
        val second = Heard()
        view.startStreaming(first)
        view.startStreaming(second)
        device.send(5)
        assertTrue(first.frames.isEmpty())
        assertEquals(listOf<Byte>(5), second.frames)
        assertEquals(1, device.starts)
    }
}
