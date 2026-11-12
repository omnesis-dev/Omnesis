// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.core

import dev.omnesis.android.wearprotocol.DictationGate
import dev.omnesis.android.wearprotocol.WearCodec
import java.io.File
import java.io.IOException

/**
 * The gate the phone last published, kept in a file so it is known at launch
 * before the Data Layer has answered, and when the Data Layer cannot be read.
 */
class GateStore(private val file: File, private val link: PhoneLink) {
    @Volatile
    private var cached: DictationGate? = load()

    /** The gate to act on now: the phone's published one, or the last one seen. */
    suspend fun current(): DictationGate? {
        link.gate()?.let(::remember)
        return cached
    }

    /** The phone published [gate]. */
    fun remember(gate: DictationGate) {
        if (gate == cached) return
        cached = gate
        try {
            file.parentFile?.mkdirs()
            file.writeBytes(WearCodec.encode(gate))
        } catch (_: IOException) {
            // The gate stays in memory and is read from the Data Layer next launch.
        }
    }

    private fun load(): DictationGate? = try {
        WearCodec.decode(file.readBytes()) as? DictationGate
    } catch (_: IOException) {
        null
    }
}
