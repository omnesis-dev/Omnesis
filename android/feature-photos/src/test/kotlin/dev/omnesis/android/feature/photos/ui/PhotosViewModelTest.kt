// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos.ui

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.feature.photos.InMemoryKeyValueStore
import dev.omnesis.android.feature.photos.PhotosIntegration
import dev.omnesis.android.feature.photos.PhotosSessionProvider
import dev.omnesis.android.feature.photos.PhotosSettings
import dev.omnesis.android.feature.photos.PhotosSyncCoordinator
import dev.omnesis.android.transport.MembershipOutbox
import dev.omnesis.android.transport.PermissionHealthCoordinator
import dev.omnesis.android.transport.SourceMembership
import dev.omnesis.android.transport.SourceSyncStatusReader
import dev.omnesis.android.transport.dto.SourceSyncStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalCoroutinesApi::class)
class PhotosViewModelTest {
    private lateinit var context: Context

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        context = ApplicationProvider.getApplicationContext()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun reopening_settings_restores_the_gateway_sync_status() {
        val store = InMemoryKeyValueStore()
        val settings = PhotosSettings(store).apply { photosEnabled = true }
        val persisted = SourceSyncStatus(
            sourceId = PhotosSyncCoordinator.SOURCE_ID,
            state = "synced",
            lastSyncAt = "2026-09-03T08:00:00.000Z",
        )
        val sessions = object : PhotosSessionProvider {
            override fun coordinator(): PhotosSyncCoordinator? = null
            override fun deviceId(): String? = null
        }
        val vm = PhotosViewModel(
            settings = settings,
            integration = PhotosIntegration(context, settings),
            sessions = sessions,
            permissionHealth = PermissionHealthCoordinator(
                reporters = { emptySet() },
                admin = { null },
                scope = CoroutineScope(Dispatchers.Unconfined),
            ),
            membership = SourceMembership(
                admin = { null },
                deviceId = sessions::deviceId,
                outbox = MembershipOutbox(read = store::get, write = store::put),
                scope = CoroutineScope(Dispatchers.Unconfined),
            ),
            syncStatusReader = SourceSyncStatusReader { persisted },
        )

        assertEquals(persisted, vm.state.value.authoritativeStatus)
    }

    @Test
    fun foreground_settings_tracks_remote_sync_status_changes() {
        val store = InMemoryKeyValueStore()
        val settings = PhotosSettings(store).apply { photosEnabled = true }
        val initial = SourceSyncStatus(sourceId = PhotosSyncCoordinator.SOURCE_ID, state = "synced")
        val remoteFailure = initial.copy(state = "error", errorMessage = "Photo access is required")
        val statuses = MutableStateFlow<SourceSyncStatus?>(initial)
        val sessions = object : PhotosSessionProvider {
            override fun coordinator(): PhotosSyncCoordinator? = null
            override fun deviceId(): String? = null
        }
        val reader = object : SourceSyncStatusReader {
            override suspend fun read(sourceId: String): SourceSyncStatus? = statuses.value
            override fun observe(sourceId: String): Flow<SourceSyncStatus?> = statuses
        }
        val vm = PhotosViewModel(
            settings = settings,
            integration = PhotosIntegration(context, settings),
            sessions = sessions,
            permissionHealth = PermissionHealthCoordinator(
                reporters = { emptySet() },
                admin = { null },
                scope = CoroutineScope(Dispatchers.Unconfined),
            ),
            membership = SourceMembership(
                admin = { null },
                deviceId = sessions::deviceId,
                outbox = MembershipOutbox(read = store::get, write = store::put),
                scope = CoroutineScope(Dispatchers.Unconfined),
            ),
            syncStatusReader = reader,
        )

        assertEquals(initial, vm.state.value.authoritativeStatus)
        statuses.value = remoteFailure
        assertEquals(remoteFailure, vm.state.value.authoritativeStatus)
    }

    @Test
    fun resume_refresh_retries_after_initial_status_is_unavailable() {
        val store = InMemoryKeyValueStore()
        val settings = PhotosSettings(store).apply { photosEnabled = true }
        val sessions = object : PhotosSessionProvider {
            override fun coordinator(): PhotosSyncCoordinator? = null
            override fun deviceId(): String? = null
        }
        var current: SourceSyncStatus? = null
        val vm = PhotosViewModel(
            settings = settings,
            integration = PhotosIntegration(context, settings),
            sessions = sessions,
            permissionHealth = PermissionHealthCoordinator(
                reporters = { emptySet() },
                admin = { null },
                scope = CoroutineScope(Dispatchers.Unconfined),
            ),
            membership = SourceMembership(
                admin = { null },
                deviceId = sessions::deviceId,
                outbox = MembershipOutbox(read = store::get, write = store::put),
                scope = CoroutineScope(Dispatchers.Unconfined),
            ),
            syncStatusReader = SourceSyncStatusReader { current },
        )
        assertEquals(null, vm.state.value.authoritativeStatus)

        current = SourceSyncStatus(PhotosSyncCoordinator.SOURCE_ID, state = "synced")
        vm.refresh()

        assertEquals(current, vm.state.value.authoritativeStatus)
    }
}
