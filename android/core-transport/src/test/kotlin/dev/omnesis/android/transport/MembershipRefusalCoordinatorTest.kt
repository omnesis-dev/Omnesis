// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The app-scoped consumer of membership refusals: a refusal reaches the
 * source's own opt-in with no screen in the picture, and stays acted on for
 * as long as it stands. All fixture values invented.
 */
class MembershipRefusalCoordinatorTest {

    private lateinit var server: MockWebServer

    /** Every refusal collector a test started, so none outlives its test. */
    private val collectors = mutableListOf<Job>()
    private val store = mutableMapOf<String, String>()
    private val outbox = MembershipOutbox(
        read = { store[it] },
        write = { k, v -> if (v == null) store.remove(k) else store[k] = v },
    )

    /** Counts what a feature module's integration would actually have done. */
    private class RecordingOptIn(override val sourceId: String) : HostedSourceOptIn {
        override fun forget() {}
        var withdrawals = 0
            private set

        override fun withdraw() {
            withdrawals++
        }
    }

    /** An opt-in whose feature module is in no state to be turned off. */
    private class FailingOptIn(override val sourceId: String) : HostedSourceOptIn {
        override fun forget() {}
        override fun withdraw(): Unit = throw IllegalStateException("scheduler unavailable")
    }

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        collectors.forEach(Job::cancel)
        server.shutdown()
    }

    private fun admin() = AdminClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))

    private fun TestScope.membership() = SourceMembership(
        admin = { admin() },
        deviceId = { DEVICE },
        outbox = outbox,
        scope = this,
    )

    /**
     * The app's own refusal consumer, on a scope of its own rather than the
     * test's: the collector never completes, and an unconfined dispatcher
     * applies each refusal the moment it is published.
     */
    private fun startCoordinator(membership: SourceMembership, optIns: Collection<HostedSourceOptIn>) {
        collectors += MembershipRefusalCoordinator(
            membership = membership,
            optIns = { optIns },
            scope = CoroutineScope(Dispatchers.Unconfined),
        ).start()
    }

    /** A gateway that has the row and refuses to add this device to it. */
    private fun enqueueRefusal(code: String = "SOURCE_ALREADY_HOSTED") {
        server.enqueue(
            MockResponse().setBody(
                """{"items":[{"id":"$SOURCE","type":"photos","deviceId":"dev-owner",""" +
                    """"enabled":true,"members":["dev-owner"]}]}""",
            ),
        )
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":"refused","code":"$code"}"""))
    }

    @Test
    fun a_terminal_refusal_captured_before_reactivation_cannot_withdraw_it() = runTest {
        val membership = membership()
        enqueueRefusal()
        membership.resumeContributing(SOURCE)
        val optIn = RecordingOptIn(SOURCE)
        var reactivated = false
        collectors += MembershipRefusalCoordinator(
            membership = membership,
            optIns = {
                if (!reactivated) {
                    // The collector already captured the refusal before enumerating.
                    membership.clearRefusal(SOURCE)
                    reactivated = true
                }
                listOf(optIn)
            },
            scope = CoroutineScope(Dispatchers.Unconfined),
        ).start()
        assertTrue(reactivated)
        assertEquals(0, optIn.withdrawals)
        assertTrue(membership.refusals.value.isEmpty())
    }

    @Test
    fun a_refusal_reaches_the_source_with_no_screen_open() = runTest {
        val optIn = RecordingOptIn(SOURCE)
        val membership = membership()
        startCoordinator(membership, setOf(optIn))
        enqueueRefusal()

        membership.resumeContributing(SOURCE)

        assertEquals(1, optIn.withdrawals)
    }

    @Test
    fun a_refusal_for_another_source_leaves_this_one_alone() = runTest {
        val optIn = RecordingOptIn("photos:local")
        val membership = membership()
        startCoordinator(membership, setOf(optIn))
        enqueueRefusal()

        membership.resumeContributing(SOURCE)

        assertEquals(0, optIn.withdrawals)
    }

    @Test
    fun a_refusal_that_still_stands_is_re_applied_when_another_arrives() = runTest {
        // Nothing tracks what has already been handled, deliberately: a source
        // that is still refused must end every pass turned off, whatever a
        // conflated emission did or did not deliver in between.
        val refused = RecordingOptIn(SOURCE)
        val other = RecordingOptIn(OTHER_SOURCE)
        val membership = membership()
        startCoordinator(membership, setOf(refused, other))
        enqueueRefusal()
        membership.resumeContributing(SOURCE)
        assertEquals(1, refused.withdrawals)

        server.enqueue(
            MockResponse().setBody(
                """{"items":[{"id":"$OTHER_SOURCE","type":"photos","deviceId":"dev-owner",""" +
                    """"enabled":true,"members":["dev-owner"]}]}""",
            ),
        )
        server.enqueue(
            MockResponse().setResponseCode(409).setBody("""{"error":"refused","code":"DEVICE_CANNOT_HOST_TYPE"}"""),
        )
        membership.resumeContributing(OTHER_SOURCE)

        assertEquals(2, refused.withdrawals)
        assertEquals(1, other.withdrawals)
    }

    @Test
    fun clearing_a_refusal_stops_it_being_applied_again() = runTest {
        val refused = RecordingOptIn(SOURCE)
        val membership = membership()
        startCoordinator(membership, setOf(refused))
        enqueueRefusal()
        membership.resumeContributing(SOURCE)
        assertEquals(1, refused.withdrawals)

        // The user asking again is the only thing that drops a refusal.
        membership.clearRefusal(SOURCE)

        assertTrue(membership.refusals.value.isEmpty())
        assertEquals(1, refused.withdrawals)
    }

    @Test
    fun one_source_failing_to_turn_off_does_not_stop_the_next() = runTest {
        val healthy = RecordingOptIn(OTHER_SOURCE)
        val membership = membership()
        startCoordinator(membership, listOf(FailingOptIn(SOURCE), healthy))
        enqueueRefusal()
        membership.resumeContributing(SOURCE)
        server.enqueue(
            MockResponse().setBody(
                """{"items":[{"id":"$OTHER_SOURCE","type":"photos","deviceId":"dev-owner",""" +
                    """"enabled":true,"members":["dev-owner"]}]}""",
            ),
        )
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":"refused","code":"DEVICE_REVOKED"}"""))

        membership.resumeContributing(OTHER_SOURCE)

        assertEquals(1, healthy.withdrawals)
    }

    private companion object {
        const val DEVICE = "dev-phone"
        const val SOURCE = "android-app-usage:dev-phone"
        const val OTHER_SOURCE = "photos:local"
    }
}
