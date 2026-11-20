// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.di

import android.util.Log
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.feature.assist.CommandTranscriber
import dev.omnesis.android.feature.assist.CommandTranscribers
import dev.omnesis.android.feature.assist.TranscriberKind
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.wear.OnDeviceFileTranscriber
import java.io.File
import java.io.IOException
import javax.inject.Singleton

/** The two ways a voice command for a webhook or the phone is turned into text. */
@Module
@InstallIn(SingletonComponent::class)
object AssistTranscriberModule {
    @Provides
    @Singleton
    fun provideCommandTranscribers(sessions: SessionManager, onDevice: OnDeviceFileTranscriber): CommandTranscribers =
        CommandTranscribers(
            mapOf(
                TranscriberKind.GATEWAY to GatewayCommandTranscriber(sessions),
                TranscriberKind.PHONE to PhoneCommandTranscriber(onDevice),
            ),
        )
}

/** The paired gateway's transcriber, the one Watch captures use; it keeps nothing. */
class GatewayCommandTranscriber(private val sessions: SessionManager) : CommandTranscriber {
    override fun unavailable(): String? {
        if (sessions.session == null) return "this phone is not paired with a gateway"
        val dictation = sessions.dictation.value ?: return null
        return if (dictation.active) null else dictation.reason ?: "gateway dictation is off"
    }

    override suspend fun transcribe(wav: File, locale: String?): String? {
        val session = sessions.session ?: return null
        return try {
            session.notes.transcribeCapture(wav, "audio/wav", locale)
        } catch (e: GatewayException) {
            Log.w(TAG, "Gateway transcription failed: ${e::class.simpleName}")
            null
        } catch (e: IOException) {
            Log.w(TAG, "Gateway transcription failed: ${e.message}")
            null
        }
    }

    private companion object {
        const val TAG = "Omnesis:Assist"
    }
}

/** The phone's on-device recognizer reading the command's WAV; nothing leaves the phone. */
class PhoneCommandTranscriber(private val onDevice: OnDeviceFileTranscriber) : CommandTranscriber {
    override fun unavailable(): String? = when (onDevice.availability()) {
        OnDeviceFileTranscriber.Availability.READY -> null
        OnDeviceFileTranscriber.Availability.NEEDS_MICROPHONE -> "the speech recognizer needs the microphone permission"
        OnDeviceFileTranscriber.Availability.UNSUPPORTED -> "this phone has no on-device recognizer that reads audio (Android 13 or later)"
    }

    override suspend fun transcribe(wav: File, locale: String?): String? = onDevice.transcribe(wav, locale)
}
