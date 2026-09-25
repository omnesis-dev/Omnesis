// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import android.content.ComponentName
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.junit4.AndroidComposeTestRule
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.navigation.NavHostController
import androidx.navigation.compose.ComposeNavigator
import androidx.navigation.compose.DialogNavigator
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.rules.ActivityScenarioRule
import dagger.Module
import dagger.Provides
import dagger.hilt.EntryPoint
import dagger.hilt.EntryPoints
import dagger.hilt.InstallIn
import dagger.hilt.android.AndroidEntryPoint
import dagger.hilt.android.testing.HiltTestApplication
import dagger.hilt.components.SingletonComponent
import dagger.hilt.testing.TestInstallIn
import dev.omnesis.android.AppVersionInfo
import dev.omnesis.android.di.AppModule
import dev.omnesis.android.di.PushModule
import dev.omnesis.android.notifications.FcmRegistrationTokens
import dev.omnesis.android.notifications.NotificationLaunchBus
import dev.omnesis.android.pairing.InMemoryStore
import dev.omnesis.android.pairing.PairingService
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.DeviceCapabilities
import dev.omnesis.android.transport.HostedSourceOptIn
import dev.omnesis.android.transport.tls.LeafCertPinner
import dev.omnesis.android.transport.tls.PinnedOkHttp
import dev.omnesis.android.transport.ws.DeviceSocket
import kotlinx.coroutines.runBlocking
import okhttp3.Protocol
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.rules.TestRule
import org.junit.runner.Description
import org.junit.runners.model.Statement
import org.robolectric.Shadows.shadowOf
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicReference
import javax.inject.Singleton

/*
 * A JVM harness for the paired shell's launch-time navigation.
 *
 * `HomeScaffold` is composed on the real Hilt graph — every `@Singleton` the shell and its
 * child screens inject is the production one — with two modules replaced: the pairing store
 * is in memory, paired through the real exchange to a [MockGateway] that speaks TLS with a
 * leaf the app pins, and the push carrier never reaches the Firebase SDK. The session
 * manager therefore builds its real clients, and a screen the shell navigates to loads
 * from the same mock gateway.
 *
 * A test drives three inputs: the [NotificationLaunchBus] an explicit launch arrives on, the
 * activity lifecycle (background / foreground), and the timing of the gateway's replies —
 * the approvals queue reply can be held so it lands after a launch was handled.
 */

/** The Hilt-injected host every shell test composes into. */
@AndroidEntryPoint
class HomeScaffoldHostActivity : ComponentActivity()

/**
 * Makes [HomeScaffoldHostActivity] launchable. It lives in test sources, so no manifest
 * declares it, and Robolectric refuses to start an activity it cannot resolve; registering
 * it with the package manager before the compose rule launches it is what a manifest entry
 * would have done. Order this rule after [dagger.hilt.android.testing.HiltAndroidRule] and
 * before the compose rule.
 */
class HomeScaffoldHostActivityRule : TestRule {
    override fun apply(base: Statement, description: Description): Statement = object : Statement() {
        override fun evaluate() {
            val application = ApplicationProvider.getApplicationContext<HiltTestApplication>()
            shadowOf(application.packageManager).addActivityIfNotPresent(
                ComponentName(application, HomeScaffoldHostActivity::class.java),
            )
            base.evaluate()
        }
    }
}

/**
 * The production modules the harness replaces. A `@TestInstallIn` module applies to every
 * Hilt test in this source set, not only to the shell tests, so what it provides has to stand
 * on its own: an unpaired in-memory pairing store — a graph built on it reads as unpaired
 * until a test pairs it — and a push carrier that never hands out a token.
 */
@Module
@TestInstallIn(components = [SingletonComponent::class], replaces = [AppModule::class, PushModule::class])
object HomeScaffoldTestModule {
    @Provides
    @Singleton
    fun provideAppVersionInfo(): AppVersionInfo = AppVersionInfo(
        version = "test",
        build = "0",
        wireProtocol = DeviceSocket.PROTOCOL_VERSION,
    )

    @Provides
    @Singleton
    fun provideDeviceCapabilities(
        optIns: Set<@JvmSuppressWildcards HostedSourceOptIn>,
        appVersion: AppVersionInfo,
    ): DeviceCapabilities = DeviceCapabilities.android(
        optIns.map(HostedSourceOptIn::hostedSourceContract),
        version = appVersion.version,
        pushAppId = "dev.omnesis.android",
    )

    @Provides
    @Singleton
    fun providePairingService(deviceCapabilities: DeviceCapabilities): PairingService = PairingService(
        store = InMemoryStore(),
        deviceName = "Test phone",
        deviceCapabilities = deviceCapabilities,
        clientFactory = { fingerprint -> PinnedOkHttp.build(fingerprint, requirePin = fingerprint != null) },
    )

    @Provides
    @Singleton
    fun provideFcmRegistrationTokens(): FcmRegistrationTokens = FcmRegistrationTokens { null }
}

@EntryPoint
@InstallIn(SingletonComponent::class)
interface HomeScaffoldHarnessEntryPoint {
    fun pairingService(): PairingService
    fun notificationLaunchBus(): NotificationLaunchBus
    fun sessionManager(): SessionManager
}

/**
 * A gateway that answers what the shell asks on launch and nothing more. Every route is a
 * fixed reply except the approvals queue, whose reply can be held until the test releases it,
 * and the held answer it reports is the test's to set. HTTP/1.1 only, so a held reply occupies
 * the one connection carrying that request and no other request queues behind it.
 */
class MockGateway : AutoCloseable {
    private val leaf = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
    private val server = MockWebServer()
    private val approvalsHold = AtomicReference<ApprovalsHold?>(null)

    /** The id of the one held answer the queue reports, or null for an empty queue. */
    @Volatile
    var heldApprovalId: String? = null

    /**
     * The `pendingRequests` array the access overview lists, as JSON, or null for a gateway
     * that does not list pending requests at all.
     */
    @Volatile
    var pendingAccessRequestsJson: String? = null

    /** Whether the access overview answers with a server error instead of its listing. */
    @Volatile
    var accessOverviewFails: Boolean = false

    /** Every request path the gateway received, in arrival order. */
    val requestPaths = CopyOnWriteArrayList<String>()

    /** Every request the gateway received as "METHOD path", without the query, in arrival order. */
    val requests = CopyOnWriteArrayList<String>()

    val url: String get() = server.url("/").toString()
    val fingerprint: String = LeafCertPinner.sha256Hex(leaf.certificate.encoded)

    /** A held approvals reply: the connection serving it waits here until [release]. */
    class ApprovalsHold {
        private val latch = CountDownLatch(1)
        fun release() = latch.countDown()
        internal fun await() = latch.await()
    }

    init {
        server.useHttps(
            HandshakeCertificates.Builder().heldCertificate(leaf).build().sslSocketFactory(),
            false,
        )
        server.protocols = listOf(Protocol.HTTP_1_1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                requestPaths += path
                requests += "${request.method} ${path.substringBefore('?')}"
                val route = path.substringBefore('?')
                return when {
                    request.method == "POST" && route == "/devices/pair" -> json(
                        """{"device":{"id":"device-test","name":"Test phone","kind":"android"},""" +
                            """"tokenId":"token-row-test","token":"token-test","scopes":["admin"]}""",
                    )
                    route == "/status" -> json("""{"documents":{"total":0,"bySource":{}},"experimental":false}""")
                    route == "/admin/privacy/approvals" -> approvalsPage()
                    route.startsWith("/admin/privacy/approvals/") -> json(
                        """{"approval":{"id":"${route.substringAfterLast('/')}","status":"pending",""" +
                            """"question":"What is the next milestone?","candidateAnswer":"An invented answer."}}""",
                    )
                    route == "/admin/access" && accessOverviewFails -> MockResponse().setResponseCode(500)
                    route == "/admin/access" -> json(
                        """{"principals":[],"sources":[],"policyFamilies":[]""" +
                            (pendingAccessRequestsJson?.let { ""","pendingRequests":$it""" } ?: "") + "}",
                    )
                    route.startsWith("/admin/access/authorizations/") -> json(
                        """{"request":{"id":"${route.substringAfterLast('/')}","approvalId":"approval-test",""" +
                            """"status":"pending","clientId":"client-test","clientName":"Aurora Planner",""" +
                            """"redirectOrigin":"http://127.0.0.1:10000","resource":"https://gateway.example.com/mcp",""" +
                            """"scope":"omnesis:access","expiresAt":2000000000000,"requiresAnswer":false}}""",
                    )
                    route == "/agent/conversations" -> json("""{"conversations":[],"nextCursor":null}""")
                    route == "/agent/events" -> MockResponse().setResponseCode(200).setBody("")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    /** Holds every approvals-queue reply from now until the returned hold is released. */
    fun holdApprovalsReplies(): ApprovalsHold = ApprovalsHold().also { approvalsHold.set(it) }

    private fun approvalsPage(): MockResponse {
        approvalsHold.get()?.await()
        val held = heldApprovalId
            ?: return json("""{"approvals":[],"nextCursor":null,"totalCount":0}""")
        return json(
            """{"approvals":[{"id":"$held","taskId":"task-$held","workflowId":"workflow-test",""" +
                """"conversationId":"conversation-test","workflowName":"Prepare project update",""" +
                """"externalAgent":{"displayName":"Northstar Assistant","source":"token"},""" +
                """"status":"pending","createdAt":1,"expiresAt":2,"resolvedAt":null}],""" +
                """"nextCursor":null,"totalCount":1}""",
        )
    }

    /** How many times the approvals queue has been read. */
    fun approvalsReads(): Int = requestPaths.count { it.substringBefore('?') == "/admin/privacy/approvals" }

    /** How many times the access overview has been read. */
    fun accessOverviewReads(): Int = requestPaths.count { it.substringBefore('?') == "/admin/access" }

    private fun json(body: String): MockResponse =
        MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(body)

    override fun close() {
        approvalsHold.getAndSet(null)?.release()
        // MockWebServer gives up with an IOException when a streaming connection
        // the app held open has not drained within its shutdown wait, which a
        // slow machine reaches. Every test has already asserted by then, and
        // the next test starts its own server.
        try {
            server.shutdown()
        } catch (_: java.io.IOException) {
        }
    }
}

/**
 * Composes [HomeScaffold] into the Hilt host activity and exposes the handles a launch test
 * drives and reads: the navigation controller, the launch bus, the lifecycle, and the gateway.
 */
class HomeScaffoldHarness(
    private val compose: AndroidComposeTestRule<ActivityScenarioRule<HomeScaffoldHostActivity>, HomeScaffoldHostActivity>,
) : AutoCloseable {
    val gateway = MockGateway()

    lateinit var nav: NavHostController
        private set
    lateinit var viewModel: HomeViewModel
        private set
    private var shellComposed = false
    private var closed = false

    /** Every destination the controller moved to, in order: the route pattern and its approval id, if any. */
    val visited = mutableListOf<Pair<String?, String?>>()

    private val entryPoint: HomeScaffoldHarnessEntryPoint
        get() = EntryPoints.get(
            ApplicationProvider.getApplicationContext<HiltTestApplication>(),
            HomeScaffoldHarnessEntryPoint::class.java,
        )

    val launchBus: NotificationLaunchBus get() = entryPoint.notificationLaunchBus()
    val session: SessionManager get() = entryPoint.sessionManager()

    /** Pairs the graph's in-memory store to the mock gateway through the real exchange. */
    fun pair() {
        val service = entryPoint.pairingService()
        runBlocking { service.pairManually(gateway.url, "ABCD-EFGH", gateway.fingerprint) }
    }

    /**
     * Composes the shell. The controller exists, and is listened to, before the first frame,
     * so a destination reached synchronously during composition is recorded like any other.
     * The activity is already resumed, so ON_START replays into the shell at once.
     */
    fun composeShell() {
        nav = NavHostController(compose.activity).apply {
            navigatorProvider.addNavigator(ComposeNavigator())
            navigatorProvider.addNavigator(DialogNavigator())
            addOnDestinationChangedListener { _, destination, arguments ->
                visited += destination.route to arguments?.getString("approvalId")
            }
        }
        compose.setContent {
            viewModel = hiltViewModel()
            HomeScaffold(vm = viewModel, nav = nav)
        }
        shellComposed = true
        compose.waitForIdle()
    }

    fun background() {
        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        compose.waitForIdle()
    }

    fun foreground() {
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        compose.waitForIdle()
    }

    val currentRoute: String? get() = nav.currentBackStackEntry?.destination?.route
    val currentApprovalId: String? get() = nav.currentBackStackEntry?.arguments?.getString("approvalId")

    /** The approval destinations the controller moved to, by id, in order. */
    val approvalsOpened: List<String>
        get() = visited.filter { it.first == PRIVACY_APPROVAL_ROUTE }.mapNotNull { it.second }

    /**
     * Waits on [condition] under the compose rule's own clock, settling the main looper before
     * each poll: a gateway reply resumes the view model there, and Robolectric runs that looper
     * only when it is idled. A timeout reports what the shell and the gateway had done by then.
     */
    fun waitUntil(condition: () -> Boolean) {
        try {
            compose.waitUntil(WAIT_TIMEOUT_MILLIS) {
                shadowOf(Looper.getMainLooper()).idle()
                condition()
            }
        } catch (timeout: ComposeTimeoutException) {
            throw AssertionError(
                "condition not met within ${WAIT_TIMEOUT_MILLIS}ms; route=$currentRoute " +
                    "approvalId=$currentApprovalId visited=$visited " +
                    "pending=${viewModel.privacyPendingCount.value} " +
                    "offer=${viewModel.pendingApprovalToPresent.value} requests=${gateway.requestPaths}",
                timeout,
            )
        }
        compose.waitForIdle()
    }

    /**
     * Tears the gateway session down the way the app's own re-pair does: the pairing is wiped
     * and the session manager rebuilds to unpaired, which stops the device socket's reconnect
     * loop, the agent stream and the per-session sync jobs.
     */
    fun stopSession() {
        if (!shellComposed) return
        session.beginRepair()
        compose.waitForIdle()
    }

    override fun close() {
        if (closed) return
        closed = true
        stopSession()
        gateway.close()
    }

    companion object {
        const val PRIVACY_APPROVAL_ROUTE = "privacy/approvals/{approvalId}"
        private const val WAIT_TIMEOUT_MILLIS = 30_000L
    }
}
