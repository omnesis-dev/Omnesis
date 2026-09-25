// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos.di

import android.content.Context
import android.content.SharedPreferences
import dagger.Module
import dev.omnesis.android.feature.photos.setup.PhotosSetupStep
import dev.omnesis.android.setup.PhoneSetupStep
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import dagger.multibindings.IntoSet
import dev.omnesis.android.feature.photos.PhotosIntegration
import dev.omnesis.android.transport.HostedSourceOptIn
import dev.omnesis.android.transport.PermissionHealthReporter
import dev.omnesis.android.feature.photos.KeyValueStore
import dev.omnesis.android.feature.photos.PhotosSettings
import javax.inject.Singleton

/** [KeyValueStore] over SharedPreferences — the production backing for [PhotosSettings]. */
class SharedPreferencesKeyValueStore(private val prefs: SharedPreferences) : KeyValueStore {
    override fun get(key: String): String? = prefs.getString(key, null)

    override fun put(key: String, value: String?) {
        prefs.edit().apply {
            if (value == null) remove(key) else putString(key, value)
        }.apply()
    }
}

@Module
@InstallIn(SingletonComponent::class)
object PhotosModule {
    @Provides @IntoSet
    fun providePermissionReporter(integration: PhotosIntegration): PermissionHealthReporter = integration

    /**
     * The opt-in a refusal is applied to, so the switch goes off and the
     * background work stops with or without a settings screen open.
     */
    @Provides @IntoSet
    fun provideHostedSourceOptIn(integration: PhotosIntegration): HostedSourceOptIn = integration

    /** The Photos page of the phone setup flow. */
    @Provides @IntoSet
    fun providePhoneSetupStep(step: PhotosSetupStep): PhoneSetupStep = step

    @Provides
    @Singleton
    fun providePhotosSettings(@ApplicationContext context: Context): PhotosSettings =
        PhotosSettings(
            SharedPreferencesKeyValueStore(
                context.getSharedPreferences("omnesis.photos", Context.MODE_PRIVATE),
            ),
        )
}
