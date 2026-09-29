// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.di

import android.content.Context
import android.os.SystemClock
import android.speech.SpeechRecognizer
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.ui.capture.SpeechTranscriber
import dev.omnesis.android.voice.DictationRecordings
import dev.omnesis.android.voice.GatewayVoiceInput
import dev.omnesis.android.voice.MediaRecorderAudioRecorder
import dev.omnesis.android.voice.OnDeviceVoiceInput
import dev.omnesis.android.voice.VoiceInputs
import dev.omnesis.android.voice.dictationLanguageHint
import java.io.File
import javax.inject.Provider
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object VoiceInputModule {
    @Provides
    @Singleton
    fun provideDictationRecordings(@ApplicationContext context: Context): DictationRecordings =
        DictationRecordings(File(context.cacheDir, "dictation"))

    @Provides
    @Singleton
    fun provideVoiceInputs(
        @ApplicationContext context: Context,
        sessions: SessionManager,
        transcribers: Provider<SpeechTranscriber>,
        recordings: DictationRecordings,
    ): VoiceInputs {
        val onDevice = { OnDeviceVoiceInput(transcribers.get()) }
        return VoiceInputs(
            gatewayStatus = sessions.dictation,
            newOnDevice = onDevice,
            newGateway = { scope, status ->
                // Bound to the gateway paired now, so a retry after a re-pair can never
                // send this recording to a different gateway. Unpaired in the instant
                // before the status clears, the phone's recognizer takes the dictation.
                val client = sessions.session?.dictation
                if (client == null) {
                    onDevice()
                } else {
                    GatewayVoiceInput(
                        recorder = MediaRecorderAudioRecorder(context),
                        newRecordingFile = recordings::newFile,
                        transcribe = { file ->
                            client.transcribe(file, DictationRecordings.MIME_TYPE, dictationLanguageHint())
                        },
                        scope = scope,
                        maxAudioBytes = status.maxAudioBytes,
                        refreshStatus = { sessions.refreshStatus() },
                        clock = SystemClock::elapsedRealtime,
                    )
                }
            },
            onDeviceAvailable = { SpeechRecognizer.isRecognitionAvailable(context) },
            refreshGatewayStatus = { sessions.refreshStatus() },
        )
    }
}
