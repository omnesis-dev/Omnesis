// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording.di

import android.content.Context
import dagger.BindsOptionalOf
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.feature.recording.ChunkSpeechScanner
import dev.omnesis.android.feature.recording.MarkedMomentSink
import dev.omnesis.android.feature.recording.RecordingAvailabilityMemory
import dev.omnesis.android.feature.recording.RecordingController
import dev.omnesis.android.feature.recording.RecordingFiles
import dev.omnesis.android.feature.recording.RecordingOutbox
import dev.omnesis.android.feature.recording.RecordingSettings
import dev.omnesis.android.feature.recording.RecordingUploadScheduler
import dev.omnesis.android.feature.recording.SileroSpeechDetector
import dev.omnesis.android.feature.recording.SqliteRecordingOutbox
import dev.omnesis.android.feature.recording.WearableAudio
import java.io.File
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object RecordingModule {
    @Provides
    @Singleton
    fun provideRecordingOutbox(@ApplicationContext context: Context): RecordingOutbox =
        SqliteRecordingOutbox(context)

    @Provides
    @Singleton
    fun provideRecordingFiles(@ApplicationContext context: Context): RecordingFiles =
        RecordingFiles(File(context.noBackupFilesDir, "recordings"))

    @Provides
    @Singleton
    fun provideRecordingSettings(@ApplicationContext context: Context): RecordingSettings =
        RecordingSettings(context.getSharedPreferences(RecordingSettings.PREFS_NAME, Context.MODE_PRIVATE))

    @Provides
    @Singleton
    fun provideRecordingAvailabilityMemory(@ApplicationContext context: Context): RecordingAvailabilityMemory =
        RecordingAvailabilityMemory(
            context.getSharedPreferences(RecordingAvailabilityMemory.PREFS_NAME, Context.MODE_PRIVATE),
        )

    @Provides
    @Singleton
    fun provideRecordingController(
        @ApplicationContext context: Context,
        outbox: RecordingOutbox,
        files: RecordingFiles,
        settings: RecordingSettings,
    ): RecordingController {
        val detector = SileroSpeechDetector { context.assets.open(SileroSpeechDetector.MODEL_ASSET).use { it.readBytes() } }
        return RecordingController(
            outbox = outbox,
            files = files,
            onWorkQueued = { RecordingUploadScheduler.enqueue(context, settings.wifiOnly) },
            speechCheck = ChunkSpeechScanner(detector)::scan,
        )
    }
}

/** A wearable input is bound by the module that links one; without it, recording uses the phone only. */
@Module
@InstallIn(SingletonComponent::class)
interface WearableAudioModule {
    @BindsOptionalOf
    fun optionalWearableAudio(): WearableAudio

    /** Bound by the app, which saves a marked moment as a note; without it a clip is dropped. */
    @BindsOptionalOf
    fun optionalMarkedMomentSink(): MarkedMomentSink
}
