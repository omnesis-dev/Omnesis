// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos.setup

import android.Manifest
import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.testing.WorkManagerTestInitHelper
import dev.omnesis.android.feature.photos.FakePhotosProvider
import dev.omnesis.android.feature.photos.InMemoryKeyValueStore
import dev.omnesis.android.feature.photos.PhotoAnalysisFragment
import dev.omnesis.android.feature.photos.PhotosIntegration
import dev.omnesis.android.feature.photos.PhotosSessionProvider
import dev.omnesis.android.feature.photos.PhotosSettings
import dev.omnesis.android.feature.photos.PhotosSource
import dev.omnesis.android.feature.photos.PhotosSyncCoordinator
import dev.omnesis.android.transport.ActivationStep
import dev.omnesis.android.transport.MembershipOutbox
import dev.omnesis.android.transport.PermissionHealthCoordinator
import dev.omnesis.android.transport.SessionScopeProvider
import dev.omnesis.android.transport.SourceMembership
import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.client.AnalyticsClient
import dev.omnesis.android.transport.client.DocumentsClient
import dev.omnesis.android.transport.http.GatewayHttp
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

/**
 * The Photos setup page's explicit enable against a mock gateway: the source
 * is registered before anything reads the library, a refused registration
 * leaves Photos off and unread, and the first sync runs in the session scope
 * it is handed.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalCoroutinesApi::class)
class PhotosSetupStepTest {
    private lateinit var context: Context
    private lateinit var server: MockWebServer
    private lateinit var settings: PhotosSettings
    private lateinit var step: PhotosSetupStep
    private var rejectRegistration = false
    @Volatile private var registered = false
    @Volatile private var readLibrary = false
    @Volatile private var sessionGeneration = 1L
    @Volatile private var holdListing: CountDownLatch? = null
    @Volatile private var listingHeld = false

    @Before fun setup() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        context = ApplicationProvider.getApplicationContext()
        WorkManagerTestInitHelper.initializeTestWorkManager(context, Configuration.Builder().build())
        ShadowContentResolver.registerProviderInternal("media", Robolectric.buildContentProvider(FakePhotosProvider::class.java).create("media").get())
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.method == "GET" && request.path == "/admin/sources" -> {
                    holdListing?.let { hold ->
                        listingHeld = true
                        hold.await(5, TimeUnit.SECONDS)
                    }
                    MockResponse().setBody("""{"items":[]}""")
                }
                request.method == "POST" && request.path == "/admin/sources" -> {
                    if (rejectRegistration) MockResponse().setResponseCode(503).setBody("""{"error":"unavailable"}""")
                    else { registered = true; MockResponse().setBody("""{"source":{"id":"photos:local","type":"photos","deviceId":"test-phone","multiDeviceMode":"partitioned"}}""") }
                }
                request.method == "GET" -> MockResponse().setBody("""{"cursor":null}""")
                else -> MockResponse().setBody("""{"ok":true}""")
            }
        }
        server.start()
        val http = GatewayHttp(OkHttpClient(), server.url("/").toString(), "test-token")
        val admin = AdminClient(http)
        val store = InMemoryKeyValueStore()
        settings = PhotosSettings(store)
        val integration = PhotosIntegration(context, settings)
        val coordinator = PhotosSyncCoordinator(
            sourceFactory = {
                check(registered) { "protected library read before registration" }
                readLibrary = true
                PhotosSource(context.contentResolver) { _, _ -> PhotoAnalysisFragment() }
            },
            analytics = AnalyticsClient(http), documents = DocumentsClient(http),
            settings = settings, hasPermission = { true }, sendEvent = { _, _ -> },
        )
        val sessions = object : PhotosSessionProvider {
            override fun coordinator() = coordinator
            override fun deviceId() = "test-phone"
        }
        step = PhotosSetupStep(
            integration = integration,
            settings = settings,
            sessions = sessions,
            membership = SourceMembership(
                admin = { admin }, deviceId = sessions::deviceId,
                outbox = MembershipOutbox(read = store::get, write = store::put),
                scope = CoroutineScope(Dispatchers.Unconfined),
                registerAbsentSource = { op, client -> integration.registerForResume(client, op.deviceId) },
            ),
            permissionHealth = PermissionHealthCoordinator({ emptySet() }, { null }, CoroutineScope(Dispatchers.Unconfined)),
            sessionScopes = object : SessionScopeProvider {
                override fun current(): CoroutineScope = CoroutineScope(Dispatchers.IO)
                override val generation: Long get() = sessionGeneration
            },
        )
    }

    @After fun cleanup() { server.shutdown(); Dispatchers.resetMain() }

    @Test fun `the explicit enable registers before its first sync reads the library`() = runBlocking {
        assertEquals(ActivationStep.Ready, step.actions.commit(null))
        assertTrue(settings.photosEnabled)
        assertTrue(registered)
        withContext(Dispatchers.Default) { withTimeout(5_000) { while (!readLibrary) delay(10) } }
    }

    @Test fun `a commit that outlives its pairing leaves Photos off and registers nothing`() = runBlocking {
        val hold = CountDownLatch(1)
        holdListing = hold
        val commit = async(Dispatchers.IO) { step.actions.commit(null) }
        withContext(Dispatchers.Default) { withTimeout(5_000) { while (!listingHeld) delay(10) } }

        // The phone unpairs while the gateway is still answering.
        sessionGeneration++
        step.reset()
        hold.countDown()

        assertTrue(commit.await() is ActivationStep.Failed)
        assertFalse(settings.photosEnabled)
        assertFalse(registered)
        delay(200)
        assertFalse(readLibrary)
    }

    @Test fun `a photo selection still shows Android's prompt so every photo can be allowed`() = runBlocking {
        shadowOf(context as Application).grantPermissions(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
        step.sequence.start()
        withContext(Dispatchers.Default) { withTimeout(5_000) { while (step.sequence.launchRequest.value == null) delay(10) } }
        assertFalse("nothing is committed before Android answers", registered)
        assertFalse(settings.photosEnabled)
    }

    @Test fun `full photo access goes straight to the commit`() = runBlocking {
        shadowOf(context as Application).grantPermissions(Manifest.permission.READ_MEDIA_IMAGES)
        step.sequence.start()
        withContext(Dispatchers.Default) { withTimeout(5_000) { while (!settings.photosEnabled) delay(10) } }
        assertEquals("no prompt is asked for", null, step.sequence.launchRequest.value)
    }

    @Test fun `a refused registration leaves Photos off and never reads the library`() = runBlocking {
        rejectRegistration = true
        assertTrue(step.actions.commit(null) is ActivationStep.Failed)
        assertFalse(settings.photosEnabled)
        assertFalse(readLibrary)
    }
}
