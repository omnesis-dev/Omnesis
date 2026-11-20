// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import kotlinx.coroutines.flow.StateFlow

/**
 * One wearable heard by several listeners at once — the recorder and a
 * wake-word listener, say. Each takes a [view], which behaves like the
 * wearable itself: the device streams while at least one view streams and
 * goes quiet once the last one stops. Every frame reaches every streaming
 * view, and a dropped link is reported to each of them, after which each
 * starts again on its own.
 */
class SharedWearableAudio(private val source: WearableAudio) {
    private val sinks = LinkedHashMap<View, WearableAudio.FrameSink>()

    private val fanOut = object : WearableAudio.FrameSink {
        override fun onFrame(frame: ByteArray, receivedAtMs: Long) {
            val now = synchronized(this@SharedWearableAudio) { sinks.values.toList() }
            for (sink in now) sink.onFrame(frame, receivedAtMs)
        }

        override fun onLinkLost() {
            val lost = synchronized(this@SharedWearableAudio) { sinks.values.toList().also { sinks.clear() } }
            for (sink in lost) sink.onLinkLost()
        }
    }

    /** A listener's own handle on the wearable. */
    fun view(): WearableAudio = View()

    private inner class View : WearableAudio {
        override val name: String get() = source.name
        override val ready: StateFlow<Boolean> get() = source.ready

        override fun startStreaming(sink: WearableAudio.FrameSink): Boolean = synchronized(this@SharedWearableAudio) {
            if (sinks.containsKey(this)) {
                sinks[this] = sink
                return true
            }
            val first = sinks.isEmpty()
            sinks[this] = sink
            if (first && !source.startStreaming(fanOut)) {
                sinks.remove(this)
                return false
            }
            true
        }

        override fun stopStreaming() = synchronized(this@SharedWearableAudio) {
            if (sinks.remove(this) != null && sinks.isEmpty()) source.stopStreaming()
        }
    }
}
