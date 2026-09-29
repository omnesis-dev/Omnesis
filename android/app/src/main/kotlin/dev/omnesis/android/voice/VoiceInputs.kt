// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.voice

import dev.omnesis.android.transport.dto.DictationStatusDto
import java.io.File
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Picks the engine for each new dictation. A dictation uses the gateway when the
 * paired gateway currently advertises gateway dictation as active (`dictation` on
 * `GET /status`); otherwise — no field, an older gateway, not opted in, no runnable
 * transcriber — it uses the phone's recognizer, exactly as before the feature.
 * The choice is made per dictation, so a switch in Settings applies to the next one.
 */
class VoiceInputs(
    private val gatewayStatus: StateFlow<DictationStatusDto?>,
    private val newOnDevice: () -> VoiceInput,
    private val newGateway: (scope: CoroutineScope, status: DictationStatusDto) -> VoiceInput,
    /** Whether the phone has a speech recognizer at all. */
    private val onDeviceAvailable: () -> Boolean,
    /** Re-reads the gateway's status, dictation gate included. */
    private val refreshGatewayStatus: suspend () -> Unit,
) {
    /**
     * Brings the gateway's dictation status up to date, so a surface opening after the
     * setting or the transcriber changed elsewhere (the portal, another phone) picks the
     * right engine. Best effort: a failed read leaves the last known status.
     */
    fun refreshStatus(scope: CoroutineScope) {
        scope.launch { refreshGatewayStatus() }
    }

    /** The input for a new dictation; [scope] owns a gateway dictation's recording and upload. */
    fun preferred(scope: CoroutineScope): VoiceInput {
        val status = gatewayStatus.value
        return if (status?.active == true) newGateway(scope, status) else newOnDevice()
    }

    /** The phone's own recognizer, for dictating again after a gateway failure. */
    fun onDevice(): VoiceInput = newOnDevice()

    fun onDeviceAvailable(): Boolean = onDeviceAvailable.invoke()

    /** Whether any engine can take a dictation, as the gateway's status changes: recording needs no recognizer. */
    fun anyAvailable(): Flow<Boolean> {
        val onDevice = onDeviceAvailable()
        return gatewayStatus.map { it?.active == true || onDevice }.distinctUntilChanged()
    }
}

/**
 * Where gateway dictations are recorded: one file each, in a private cache folder.
 * Every path that finishes a dictation deletes its file; [sweepStale], run at app start,
 * removes any a killed process left behind.
 */
class DictationRecordings(private val directory: File) {

    fun newFile(): File {
        directory.mkdirs()
        return File(directory, "dictation-${UUID.randomUUID()}.m4a")
    }

    /** Deletes recordings older than [maxAgeMs]; younger ones may belong to a dictation awaiting retry. */
    fun sweepStale(nowMs: Long, maxAgeMs: Long = STALE_AFTER_MS) {
        directory.listFiles()?.forEach { if (nowMs - it.lastModified() > maxAgeMs) it.delete() }
    }

    companion object {
        const val MIME_TYPE = "audio/mp4"
        private const val STALE_AFTER_MS = 60 * 60 * 1000L
    }
}

/**
 * The device language as the two- or three-letter ISO 639 code the transcriber
 * takes as a hint. The language tag is used rather than [Locale.getLanguage],
 * which still reports legacy codes such as `in` for Indonesian.
 */
fun dictationLanguageHint(locale: Locale = Locale.getDefault()): String? =
    locale.toLanguageTag().substringBefore('-').lowercase().takeIf { it.length in 2..3 && it != "und" }
