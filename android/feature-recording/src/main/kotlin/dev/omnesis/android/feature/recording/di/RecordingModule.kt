// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording.di

import android.content.Context
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.feature.recording.RecordingController
import dev.omnesis.android.feature.recording.RecordingFiles
import dev.omnesis.android.feature.recording.RecordingOutbox
import dev.omnesis.android.feature.recording.RecordingSettings
import dev.omnesis.android.feature.recording.RecordingUploadScheduler
import dev.omnesis.android.feature.recording.SqliteRecordingOutbox
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
    fun provideRecordingController(
        @ApplicationContext context: Context,
        outbox: RecordingOutbox,
        files: RecordingFiles,
        settings: RecordingSettings,
    ): RecordingController =
        RecordingController(
            outbox = outbox,
            files = files,
            onWorkQueued = { RecordingUploadScheduler.enqueue(context, settings.wifiOnly) },
        )
}
