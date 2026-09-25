// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.sse

import java.io.ByteArrayOutputStream

/**
 * One completed SSE frame: the joined `data:` payload plus the effective event
 * [id]. Per the SSE spec the last seen `id:` persists across frames until a new
 * `id:` line changes it, so [id] reflects the most recent id field (null until
 * the stream emits one). Mirrors the iOS `SSEFrame`.
 */
data class SSEFrame(val data: String, val id: String?)

/**
 * Byte-level Server-Sent-Events frame parser. Faithful port of the iOS
 * `SSEFrameParser`: feed bytes one at a time; a line ends at LF (0x0A); a blank line
 * (empty or CR-only) ends a frame and yields the joined `data:` lines (trailing `\n`
 * trimmed so single-line JSON payloads round-trip) plus the effective `id:`. Comment
 * lines (starting with `:`) are heartbeats and ignored. Parsing at the byte level
 * avoids the buffered/gzip line reader stalls that delay streamed tokens until the
 * connection closes.
 */
class SSEFrameParser {

    private val lineBytes = ByteArrayOutputStream()
    private val dataBuf = StringBuilder()

    /**
     * Last `id:` value seen. Per the SSE spec it persists across frames until a new
     * `id:` line changes it, so it's the effective id for every subsequent frame —
     * the gateway emits `id: <seq>` only on real (non-control) events, so a control
     * frame (e.g. `agent.resync`) keeps the prior id.
     */
    private var lastEventId: String? = null

    /**
     * Pushes one byte (0–255). Returns the completed frame (payload + effective id)
     * when this byte was the LF terminating a blank line AND at least one `data:`
     * line was seen since the previous boundary; null otherwise.
     */
    fun consume(byte: Int): SSEFrame? {
        if (byte != LF) {
            lineBytes.write(byte)
            return null
        }
        val line = lineBytes.toString(Charsets.UTF_8.name())
        lineBytes.reset()

        val isBlank = line.isEmpty() || line == "\r"
        if (isBlank) {
            if (dataBuf.isEmpty()) return null
            val payload = if (dataBuf.endsWith("\n")) dataBuf.substring(0, dataBuf.length - 1) else dataBuf.toString()
            dataBuf.setLength(0)
            return SSEFrame(payload, lastEventId)
        }

        val trimmed = if (line.endsWith("\r")) line.substring(0, line.length - 1) else line
        if (trimmed.startsWith(":")) return null // comment / heartbeat
        if (trimmed.startsWith("data:")) {
            val value = trimmed.substring("data:".length).dropWhile { it == ' ' }
            dataBuf.append(value)
            dataBuf.append('\n')
        } else if (trimmed.startsWith("id:")) {
            lastEventId = trimmed.substring("id:".length).dropWhile { it == ' ' }
        }
        // Other SSE fields (event, retry) are unused by the gateway.
        return null
    }

    private companion object {
        const val LF = 0x0A
    }
}
