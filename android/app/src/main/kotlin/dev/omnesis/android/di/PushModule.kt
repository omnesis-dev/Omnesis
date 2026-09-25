// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.di

import android.content.Context
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.notifications.FcmRegistrationTokens
import dev.omnesis.android.notifications.FirebaseRegistrationTokens
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object PushModule {
    /** Registration tokens come from the Firebase SDK; a test graph replaces this module to keep the SDK out. */
    @Provides
    @Singleton
    fun provideFcmRegistrationTokens(@ApplicationContext context: Context): FcmRegistrationTokens =
        FirebaseRegistrationTokens(context)
}
