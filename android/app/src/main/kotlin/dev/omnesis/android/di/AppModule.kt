// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.di

import android.content.Context
import android.os.Build
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.AppVersionInfo
import dev.omnesis.android.BuildConfig
import dev.omnesis.android.pairing.EncryptedPreferencesStore
import dev.omnesis.android.pairing.PairingService
import dev.omnesis.android.transport.DeviceCapabilities
import dev.omnesis.android.transport.HostedSourceOptIn
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    /**
     * This build's version identity. Bound once so the wire payload and the
     * Settings screen can never quote different numbers.
     */
    @Provides
    @Singleton
    fun provideAppVersionInfo(): AppVersionInfo = AppVersionInfo.current()

    @Provides
    @Singleton
    fun provideDeviceCapabilities(
        optIns: Set<@JvmSuppressWildcards HostedSourceOptIn>,
        appVersion: AppVersionInfo,
    ): DeviceCapabilities = DeviceCapabilities.android(
        optIns.map(HostedSourceOptIn::hostedSourceContract),
        version = appVersion.version,
        pushAppId = BuildConfig.APPLICATION_ID,
    )

    @Provides
    @Singleton
    fun providePairingService(
        @ApplicationContext context: Context,
        deviceCapabilities: DeviceCapabilities,
    ): PairingService =
        PairingService(
            store = EncryptedPreferencesStore(context),
            deviceName = Build.MODEL ?: "Android",
            deviceCapabilities = deviceCapabilities,
        )
}
