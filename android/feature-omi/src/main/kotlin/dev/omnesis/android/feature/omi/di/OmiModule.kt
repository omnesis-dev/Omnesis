// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.omi.di

import android.content.Context
import dagger.Binds
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.feature.omi.OmiLink
import dev.omnesis.android.feature.omi.OmiPairing
import dev.omnesis.android.feature.omi.OmiPairingStore
import dev.omnesis.android.feature.recording.WearableAudio
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object OmiModule {
    @Provides
    @Singleton
    fun providePairingStore(@ApplicationContext context: Context): OmiPairingStore =
        OmiPairingStore(context.getSharedPreferences(OmiPairingStore.PREFS_NAME, Context.MODE_PRIVATE))

    @Provides
    @Singleton
    fun providePairing(@ApplicationContext context: Context, store: OmiPairingStore): OmiPairing = OmiPairing(context, store)

    @Provides
    @Singleton
    fun provideLink(@ApplicationContext context: Context, store: OmiPairingStore): OmiLink = OmiLink(context, store)
}

/** The pendant is the recorder's wearable input. */
@Module
@InstallIn(SingletonComponent::class)
interface OmiWearableModule {
    @Binds
    fun bindWearableAudio(link: OmiLink): WearableAudio
}
