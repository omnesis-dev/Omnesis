// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.di

import android.content.Context
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.notes.NotesGateway
import dev.omnesis.android.notes.NotesRepository
import dev.omnesis.android.notes.PendingNotesStore
import dev.omnesis.android.session.SessionManager
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object NotesModule {

    /**
     * The repository outlives any gateway session, so it resolves the current
     * session's `/notes` client lazily per call — after an unpair it sees null
     * and queues; after a re-pair it sees the fresh client.
     */
    @Provides
    @Singleton
    fun provideNotesRepository(
        @ApplicationContext context: Context,
        session: SessionManager,
    ): NotesRepository = NotesRepository(
        store = PendingNotesStore(context),
        gateway = { session.session?.let { NotesGateway(it.notes, it.pairing.deviceId) } },
    )
}
