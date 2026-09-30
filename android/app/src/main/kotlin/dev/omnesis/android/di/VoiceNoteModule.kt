// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.di

import android.content.Context
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.notes.VoiceNoteFiles
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.voice.GatewayVoiceNoteSessions
import dev.omnesis.android.voice.VoiceNoteSessions

@Module
@InstallIn(SingletonComponent::class)
object VoiceNoteModule {
    @Provides
    fun provideVoiceNoteSessions(
        @ApplicationContext context: Context,
        session: SessionManager,
        files: VoiceNoteFiles,
    ): VoiceNoteSessions = GatewayVoiceNoteSessions(context, session.dictation, files)
}
