// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The membership state machine against a real [AdminClient] over MockWebServer,
 * and the outbox's durability rules. All fixture values invented.
 */
class SourceMembershipTest {

    private lateinit var server: MockWebServer
    private val store = mutableMapOf<String, String>()
    private val outbox = MembershipOutbox(read = { store[it] }, write = { k, v -> if (v == null) store.remove(k) else store[k] = v })

    @Test fun removal_between_inventory_and_unpause_keeps_explicit_resume_for_registration_retry() = runTest {
        val holder = SourceMembership(
            admin = { admin() }, deviceId = { "dev-phone" }, outbox = outbox, scope = this,
            registerAbsentSource = { op, client ->
                client.createSource("photos", "local", op.deviceId)
            },
        )
        server.enqueue(MockResponse().setBody("""{"items":[{"id":"photos:local","type":"photos","deviceId":"dev-phone","enabled":false}]}"""))
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        assertTrue(holder.resumeContributing("photos:local") is SourceMembership.Outcome.Retry)
        assertEquals(listOf(resumeOp()), outbox.pending())
        server.enqueue(MockResponse().setBody("""{"items":[]}"""))
        server.enqueue(MockResponse().setBody("""{"source":{"id":"photos:local","type":"photos"}}"""))
        holder.drain()
        assertTrue(outbox.pending().isEmpty())
        assertEquals(listOf("GET", "PATCH", "GET", "POST"), List(4) { server.takeRequest().method })
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test fun delayed_removal_refusal_consumer_does_not_withdraw_a_new_activation() = runTest {
        var withdrawals = 0
        val source = object : HostedSourceOptIn {
            override fun forget() {}
            override val sourceId = "photos:local"
            override fun withdraw() { withdrawals++ }
        }
        val reconciler = SourceRemovalReconciler { listOf(source) }
        val holder = SourceMembership(
            admin = { null }, pairingIdentity = { PairingIdentity("dev-phone", null, null) },
            outbox = outbox, scope = backgroundScope, removalReconciler = reconciler,
        )
        reconciler.reconcile { listOf(source.sourceId) }
        runCurrent() // Publish the already-applied removal notice.
        assertEquals("SOURCE_REMOVED", holder.refusals.value[source.sourceId]?.code)
        MembershipRefusalCoordinator(holder, { listOf(source) }, backgroundScope).start()
        reconciler.activating(source.sourceId) { Unit }
        runCurrent() // A delayed consumer must not replay the old withdrawal.
        assertEquals(1, withdrawals)
        assertTrue(holder.refusals.value.isEmpty())
        reconciler.reconcile { listOf(source.sourceId) }
        reconciler.invalidateSession()
        runCurrent()
        assertTrue(holder.refusals.value.isEmpty())
    }

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun admin() = AdminClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))

    private fun generatedAdmin(generation: String?) = AdminClient(
        GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok", generation),
    )

    private fun TestScope.membership(deviceId: String? = "dev-phone", admin: AdminClient? = admin()) =
        SourceMembership(admin = { admin }, deviceId = { deviceId }, outbox = outbox, scope = this)

    private fun detachOp(sourceId: String = "photos:local") = MembershipOp(sourceId, "dev-phone", MembershipIntent.DETACH)

    private fun resumeOp(sourceId: String = "photos:local") = MembershipOp(sourceId, "dev-phone", MembershipIntent.RESUME)

    @Test
    fun offline_detach_is_visible_until_the_gateway_settles_it() = runTest {
        var client: AdminClient? = null
        val membership = SourceMembership(admin = { client }, deviceId = { "dev-phone" }, outbox = outbox, scope = this)
        membership.stopContributing("photos:local")?.join()
        assertEquals(listOf(detachOp()), membership.pending.value)
        assertEquals(listOf(detachOp()), outbox.pending())
        client = admin()
        server.enqueue(MockResponse().setBody("""{"source":{"id":"photos:local","type":"photos","deviceId":"dev-other"},"members":["dev-other"]}"""))
        membership.drain()
        assertTrue(membership.pending.value.isEmpty())
        assertTrue(outbox.pending().isEmpty())
    }

    @Test
    fun pending_intents_from_another_pairing_are_not_shown() = runTest {
        outbox.record(detachOp())
        assertTrue(membership(deviceId = "dev-other").pending.value.isEmpty())
    }

    @Test
    fun removal_snapshot_distinguishes_tombstone_detach_and_never_added() = runTest {
        val response = """{"items":[{"id":"notes:local","type":"notes","deviceId":"dev-other","members":["dev-other"]}],"removedSourceIds":["files:local"]}"""
        server.enqueue(MockResponse().setBody(response))
        assertEquals(listOf("files:local", "notes:local"), admin().sourcesToWithdraw("dev-phone"))
    }

    @Test
    fun old_gateway_without_tombstone_field_never_implies_removal() = runTest {
        server.enqueue(MockResponse().setBody("""{"items":[]}"""))
        assertTrue(admin().sourcesToWithdraw("dev-phone").isEmpty())
    }

    @Test
    fun offline_resume_retries_missing_row_registration_after_cleanup() = runTest {
        var client: AdminClient? = null
        val source = object : HostedSourceOptIn {
            override fun forget() {}
            override val sourceId = "photos:local"
            override fun withdraw() = error("Explicit resume must stay enabled")
        }
        val reconciler = SourceRemovalReconciler { listOf(source) }
        val membership = SourceMembership(
            admin = { client }, pairingIdentity = { PairingIdentity("dev-phone", null, null) },
            outbox = outbox, scope = backgroundScope, removalReconciler = reconciler,
            registerAbsentSource = { op, admin ->
                reconciler.reconcile { listOf(op.sourceId) }
                source.registerForResume(admin, op.deviceId)
            },
        )
        assertTrue(membership.resumeContributing(source.sourceId) is SourceMembership.Outcome.Retry)
        client = admin()
        server.enqueue(MockResponse().setBody("""{"items":[]}"""))
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"code":"SOURCE_REMOVAL_IN_PROGRESS","error":"Cleanup running"}"""))
        membership.drain()
        assertEquals(listOf(resumeOp()), outbox.pending())
        server.enqueue(MockResponse().setBody("""{"items":[]}"""))
        server.enqueue(MockResponse().setBody("""{"source":{"id":"photos:local","type":"photos"}}"""))
        membership.drain()
        assertTrue(outbox.pending().isEmpty())
        assertTrue(membership.pending.value.isEmpty())
        assertEquals(4, server.requestCount)
        assertEquals("GET", server.takeRequest().method)
        val registration = server.takeRequest()
        assertEquals("POST", registration.method)
        assertEquals("/admin/sources", registration.path)
        assertTrue(registration.body.readUtf8().contains("\"accountId\":\"local\""))
    }

    @Test
    fun inventory_decodes_pending_cleanup_separately_from_active_sources() = runTest {
        server.enqueue(MockResponse().setBody("""{"items":[],"pendingRemovals":[{"id":"notes:local","type":"notes","accountId":"local","removedAt":123,"state":"removing"}],"removedSourceIds":["notes:local"]}"""))
        val inventory = admin().sourceInventory()
        assertTrue(inventory.items.isEmpty())
        assertEquals("notes:local", inventory.pendingRemovals.single().id)
        assertEquals("removing", inventory.pendingRemovals.single().state)
    }

    @Test
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    fun late_registration_cannot_clear_a_newer_same_source_resume() = runTest {
        repeat(2) { server.enqueue(MockResponse().setBody("""{"items":[]}""")) }
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var registrations = 0
        val membership = SourceMembership(
            admin = { admin() }, pairingIdentity = { PairingIdentity("dev-phone", null, null) },
            outbox = outbox, scope = this,
            registerAbsentSource = { _, _ -> registrations++; started.complete(Unit); release.await() },
        )
        val first = async { membership.resumeContributing("photos:local") }
        started.await()
        val second = async { membership.resumeContributing("photos:local") }
        runCurrent()
        release.complete(Unit)
        assertEquals(SourceMembership.Outcome.Superseded, first.await())
        assertEquals(SourceMembership.Outcome.Resumed, second.await())
        assertEquals(2, registrations)
        assertTrue(outbox.pending().isEmpty())
    }

    @Test
    fun late_registration_completion_does_not_settle_a_different_pairing() = runTest {
        server.enqueue(MockResponse().setBody("""{"items":[]}"""))
        var identity = PairingIdentity("dev-phone", "https://gateway.example.com", "old")
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val membership = SourceMembership(
            admin = { admin() }, pairingIdentity = { identity }, outbox = outbox, scope = this,
            registerAbsentSource = { _, _ -> started.complete(Unit); release.await() },
        )
        val first = async { membership.resumeContributing("photos:local") }
        started.await()
        identity = identity.copy(generation = "new")
        release.complete(Unit)
        assertEquals(SourceMembership.Outcome.Superseded, first.await())
        assertEquals("old", outbox.pending().single().pairingGeneration)
        membership.drain()
        assertTrue(outbox.pending().isEmpty())
    }

    @Test
    fun restored_resume_is_protected_before_foreground_retry_and_after_session_rebuild() = runTest {
        outbox.record(resumeOp())
        var withdrawn = false
        val source = object : HostedSourceOptIn {
            override fun forget() {}
            override val sourceId = "photos:local"
            override fun withdraw() { withdrawn = true }
        }
        val reconciler = SourceRemovalReconciler { listOf(source) }
        SourceMembership(
            admin = { null }, pairingIdentity = { PairingIdentity("dev-phone", null, null) },
            outbox = outbox, scope = backgroundScope, removalReconciler = reconciler,
        )
        reconciler.invalidateSession()
        reconciler.reconcile { listOf(source.sourceId) }
        assertTrue(!withdrawn)
        assertEquals(listOf(resumeOp()), outbox.pending())
    }

    // ── detach state machine ──────────────────────────────────────────

    @Test
    fun queued_membership_runs_only_for_the_exact_pairing_and_gateway() = runTest {
        val gateway = server.url("/").toString()
        val exact = MembershipOp(
            "photos:local",
            "dev-phone",
            MembershipIntent.DETACH,
            "generation-1",
            gateway,
        )
        outbox.record(exact)
        server.enqueue(
            MockResponse().setBody(
                """{"source":{"id":"photos:local","type":"photos","deviceId":"dev-owner"},"members":["dev-owner"]}""",
            ),
        )
        SourceMembership(
            admin = { generatedAdmin("generation-1") },
            pairingIdentity = { PairingIdentity("dev-phone", gateway, "generation-1") },
            outbox = outbox,
            scope = this,
        ).drain()

        assertTrue(outbox.pending().isEmpty())
        assertEquals("generation-1", server.takeRequest().getHeader("Omnesis-Pairing-Generation"))
    }

    @Test
    fun old_or_unattributable_membership_intents_never_cross_a_repair_or_gateway() = runTest {
        val gatewayB = server.url("/").toString()
        val membership = SourceMembership(
            admin = { generatedAdmin("generation-2") },
            pairingIdentity = { PairingIdentity("dev-phone", gatewayB, "generation-2") },
            outbox = outbox,
            scope = this,
        )

        outbox.record(
            MembershipOp(
                "photos:local",
                "dev-phone",
                MembershipIntent.DETACH,
                "generation-1",
                gatewayB,
            ),
        )
        membership.drain()
        outbox.record(MembershipOp("photos:local", "dev-phone", MembershipIntent.DETACH))
        membership.drain()

        assertTrue(outbox.pending().isEmpty())
        assertEquals(0, server.requestCount)
    }

    @Test
    fun detach_200_is_done_with_no_pause() = runTest {
        server.enqueue(MockResponse().setBody("""{"source":{"id":"photos:local","type":"photos","deviceId":"dev-owner"},"members":["dev-owner"]}"""))
        assertEquals(SourceMembership.Outcome.Detached, membership().perform(detachOp()))
        assertEquals("/admin/sources/photos:local/members/dev-phone", server.takeRequest().path)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun detach_404_is_done() = runTest {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"source not found"}"""))
        assertEquals(SourceMembership.Outcome.NotAMember, membership().perform(detachOp()))
    }

    @Test
    fun detach_of_a_non_member_is_done() = runTest {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":"device dev-phone does not host photos:local","code":"DEVICE_NOT_MEMBER"}"""))
        assertEquals(SourceMembership.Outcome.NotAMember, membership().perform(detachOp()))
    }

    @Test
    fun detach_of_the_last_member_pauses_the_source_instead() = runTest {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":"dev-phone is the only host","code":"LAST_MEMBER"}"""))
        server.enqueue(MockResponse().setBody("""{"source":{"id":"photos:local","type":"photos","enabled":false}}"""))
        assertEquals(SourceMembership.Outcome.PausedInstead, membership().perform(detachOp()))
        server.takeRequest()
        val pause = server.takeRequest()
        assertEquals("PATCH", pause.method)
        assertEquals("/admin/sources/photos:local", pause.path)
        assertEquals("""{"enabled":false}""", pause.body.readUtf8())
    }

    @Test
    fun detach_whose_pause_fails_is_retried() = runTest {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":"last","code":"LAST_MEMBER"}"""))
        server.enqueue(MockResponse().setResponseCode(503).setBody("""{"error":"writer busy"}"""))
        assertTrue(membership().perform(detachOp()) is SourceMembership.Outcome.Retry)
    }

    @Test
    fun detach_answered_5xx_or_unreachable_is_retried() = runTest {
        server.enqueue(MockResponse().setResponseCode(500).setBody("""{"error":"boom"}"""))
        assertTrue(membership().perform(detachOp()) is SourceMembership.Outcome.Retry)

        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        assertTrue(membership().perform(detachOp()) is SourceMembership.Outcome.Retry)
    }

    @Test
    fun a_refused_pairing_is_retried_rather_than_forgotten() = runTest {
        server.enqueue(MockResponse().setResponseCode(401))
        assertTrue(membership().perform(detachOp()) is SourceMembership.Outcome.Retry)
    }

    @Test
    fun nothing_runs_while_unpaired() = runTest {
        assertTrue(membership(admin = null).perform(detachOp()) is SourceMembership.Outcome.Retry)
        assertEquals(0, server.requestCount)
    }

    // ── resume state machine ──────────────────────────────────────────

    @Test
    fun partitioned_activation_inspects_without_mutation_then_commits_after_permission() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"items":[{"id":"mobile-observations:local","type":"mobile-observations","deviceId":"dev-owner","enabled":true,"members":["dev-owner"],"multiDeviceMode":"exclusive"}]}""",
            ),
        )
        val membership = membership()
        assertEquals(
            ActivationOutcome.Ready,
            membership.inspectActivation(
                "mobile-observations:local",
                SourceMultiDeviceMode.PARTITIONED,
            ),
        )
        assertEquals(1, server.requestCount)
        server.takeRequest()
        server.enqueue(
            MockResponse().setBody(
                """{"items":[{"id":"mobile-observations:local","type":"mobile-observations","deviceId":"dev-owner","enabled":true,"members":["dev-owner"],"multiDeviceMode":"exclusive"}]}""",
            ),
        )
        server.enqueue(
            MockResponse().setBody(
                """{"source":{"id":"mobile-observations:local","type":"mobile-observations","deviceId":"dev-owner","enabled":true,"multiDeviceMode":"partitioned"}}""",
            ),
        )
        server.enqueue(
            MockResponse().setBody(
                """{"source":{"id":"mobile-observations:local","type":"mobile-observations","deviceId":"dev-owner","members":["dev-owner","dev-phone"],"multiDeviceMode":"partitioned"},"members":["dev-owner","dev-phone"]}""",
            ),
        )

        assertEquals(
            ActivationOutcome.Ready,
            membership.commitActivation(
                "mobile-observations:local",
                SourceMultiDeviceMode.PARTITIONED,
            ),
        )
        server.takeRequest()
        val mode = server.takeRequest()
        val join = server.takeRequest()
        assertEquals("PATCH", mode.method)
        assertEquals("""{"multiDeviceMode":"partitioned"}""", mode.body.readUtf8())
        assertEquals("POST", join.method)
        assertEquals("""{"deviceId":"dev-phone"}""", join.body.readUtf8())
    }

    @Test
    fun exclusive_activation_waits_for_a_phone_choice_without_requesting_access() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"items":[{"id":"photos:local","type":"photos","deviceId":"dev-owner","enabled":true,"members":["dev-owner"],"multiDeviceMode":"exclusive"}]}""",
            ),
        )
        assertEquals(
            ActivationOutcome.ChoiceRequired(SourceMultiDeviceMode.EXCLUSIVE),
            membership().inspectActivation("photos:local", SourceMultiDeviceMode.EXCLUSIVE),
        )
        assertEquals(1, server.requestCount)
    }

    @Test
    fun exclusive_takeover_is_only_committed_after_the_staged_choice() = runTest {
        val source =
            """{"items":[{"id":"photos:local","type":"photos","deviceId":"dev-owner","enabled":true,"members":["dev-owner"],"multiDeviceMode":"exclusive"}]}"""
        server.enqueue(MockResponse().setBody(source))
        val membership = membership()
        assertEquals(
            ActivationOutcome.Ready,
            membership.inspectActivation(
                "photos:local",
                SourceMultiDeviceMode.EXCLUSIVE,
                ActivationChoice.TAKE_OVER,
            ),
        )
        assertEquals(1, server.requestCount)
        server.takeRequest()

        server.enqueue(MockResponse().setBody(source))
        server.enqueue(
            MockResponse().setBody(
                """{"source":{"id":"photos:local","type":"photos","deviceId":"dev-phone","enabled":true,"members":["dev-phone"],"multiDeviceMode":"exclusive"}}""",
            ),
        )
        assertEquals(
            ActivationOutcome.Ready,
            membership.commitActivation(
                "photos:local",
                SourceMultiDeviceMode.EXCLUSIVE,
                ActivationChoice.TAKE_OVER,
            ),
        )
        server.takeRequest()
        val transfer = server.takeRequest()
        assertEquals("PATCH", transfer.method)
        assertEquals("""{"deviceId":"dev-phone"}""", transfer.body.readUtf8())
    }

    @Test
    fun resume_with_no_row_leaves_creation_to_registration() = runTest {
        server.enqueue(MockResponse().setBody("""{"items":[]}"""))
        assertEquals(SourceMembership.Outcome.NoRow, membership().perform(resumeOp()))
        assertEquals("/admin/sources", server.takeRequest().path)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun resume_rejoins_a_row_another_device_kept_alive() = runTest {
        server.enqueue(MockResponse().setBody("""{"items":[{"id":"photos:local","type":"photos","deviceId":"dev-owner","enabled":true,"members":["dev-owner"]}]}"""))
        server.enqueue(MockResponse().setBody("""{"source":{"id":"photos:local","type":"photos","deviceId":"dev-owner","members":["dev-owner","dev-phone"]},"members":["dev-owner","dev-phone"]}"""))
        assertEquals(SourceMembership.Outcome.Resumed, membership().perform(resumeOp()))
        server.takeRequest()
        val join = server.takeRequest()
        assertEquals("POST", join.method)
        assertEquals("/admin/sources/photos:local/members", join.path)
        assertEquals("""{"deviceId":"dev-phone"}""", join.body.readUtf8())
        assertEquals(2, server.requestCount)
    }

    @Test
    fun resume_waits_for_a_recent_detach_cleanup_then_rejoins() = runTest {
        server.enqueue(MockResponse().setBody("""{"items":[{"id":"photos:local","type":"photos","deviceId":"dev-owner","enabled":true,"members":["dev-owner"]}]}"""))
        server.enqueue(
            MockResponse()
                .setResponseCode(409)
                .setBody("""{"error":"the source stream is still being detached","code":"SOURCE_STREAM_CLEANUP_IN_PROGRESS"}"""),
        )
        server.enqueue(MockResponse().setBody("""{"source":{"id":"photos:local","type":"photos","deviceId":"dev-owner","members":["dev-owner","dev-phone"]},"members":["dev-owner","dev-phone"]}"""))

        assertEquals(SourceMembership.Outcome.Resumed, membership().perform(resumeOp()))

        assertEquals(3, server.requestCount)
        server.takeRequest()
        assertEquals("POST", server.takeRequest().method)
        assertEquals("POST", server.takeRequest().method)
    }

    @Test
    fun activation_waits_for_a_recent_detach_cleanup_then_joins() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"items":[{"id":"mobile-observations:local","type":"mobile-observations","deviceId":"dev-owner","enabled":true,"members":["dev-owner"],"multiDeviceMode":"partitioned"}]}""",
            ),
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(409)
                .setBody("""{"error":"the source stream is still being detached","code":"SOURCE_STREAM_CLEANUP_IN_PROGRESS"}"""),
        )
        server.enqueue(
            MockResponse().setBody(
                """{"source":{"id":"mobile-observations:local","type":"mobile-observations","deviceId":"dev-owner","members":["dev-owner","dev-phone"],"multiDeviceMode":"partitioned"},"members":["dev-owner","dev-phone"]}""",
            ),
        )

        assertEquals(
            ActivationOutcome.Ready,
            membership().commitActivation(
                "mobile-observations:local",
                SourceMultiDeviceMode.PARTITIONED,
            ),
        )

        assertEquals(3, server.requestCount)
    }

    @Test
    fun resume_unpauses_a_row_this_device_paused() = runTest {
        server.enqueue(MockResponse().setBody("""{"items":[{"id":"photos:local","type":"photos","deviceId":"dev-phone","enabled":false,"members":["dev-phone"]}]}"""))
        server.enqueue(MockResponse().setBody("""{"source":{"id":"photos:local","type":"photos","enabled":true}}"""))
        assertEquals(SourceMembership.Outcome.Resumed, membership().perform(resumeOp()))
        server.takeRequest()
        val patch = server.takeRequest()
        assertEquals("PATCH", patch.method)
        assertEquals("""{"enabled":true}""", patch.body.readUtf8())
        assertEquals(2, server.requestCount)
    }

    @Test
    fun resume_of_an_enabled_row_this_device_hosts_touches_nothing() = runTest {
        server.enqueue(MockResponse().setBody("""{"items":[{"id":"photos:local","type":"photos","deviceId":"dev-phone","enabled":true}]}"""))
        assertEquals(SourceMembership.Outcome.Resumed, membership().perform(resumeOp()))
        assertEquals(1, server.requestCount)
    }

    @Test
    fun resume_refused_for_good_is_dropped_rather_than_retried_forever() = runTest {
        // A source whose type takes one host at a time, held by another device:
        // every later pass would earn the same 409, so the intent is settled.
        server.enqueue(MockResponse().setBody("""{"items":[{"id":"photos:local","type":"photos","deviceId":"dev-owner","enabled":true,"members":["dev-owner"]}]}"""))
        server.enqueue(
            MockResponse()
                .setResponseCode(409)
                .setBody("""{"error":"photos:local is hosted by Studio Desktop","code":"SOURCE_ALREADY_HOSTED"}"""),
        )
        val outcome = membership().perform(resumeOp())
        assertEquals("SOURCE_ALREADY_HOSTED", (outcome as SourceMembership.Outcome.Refused).code)

        // The drain clears it: a queued intent that can never succeed is not
        // carried forward to the next foreground.
        server.enqueue(MockResponse().setBody("""{"items":[{"id":"photos:local","type":"photos","deviceId":"dev-owner","enabled":true,"members":["dev-owner"]}]}"""))
        server.enqueue(
            MockResponse()
                .setResponseCode(409)
                .setBody("""{"error":"photos:local is hosted by Studio Desktop","code":"SOURCE_ALREADY_HOSTED"}"""),
        )
        val m = membership()
        m.resumeContributing("photos:local")
        assertEquals(emptyList<MembershipOp>(), outbox.pending())
    }

    @Test
    fun resume_join_404_on_a_gateway_without_membership_is_done() = runTest {
        server.enqueue(MockResponse().setBody("""{"items":[{"id":"photos:local","type":"photos","deviceId":"dev-owner","enabled":true}]}"""))
        server.enqueue(MockResponse().setResponseCode(404))
        assertEquals(SourceMembership.Outcome.NoRow, membership().perform(resumeOp()))
    }

    // ── outbox + drain ────────────────────────────────────────────────

    @Test
    fun stop_contributing_queues_the_detach_before_asking_and_clears_it_once_answered() = runTest {
        server.enqueue(MockResponse().setBody("""{"source":{"id":"photos:local","type":"photos"},"members":[]}"""))
        val m = membership()
        val pass = m.stopContributing("photos:local")!!
        assertEquals(listOf(detachOp()), outbox.pending())
        pass.join()
        assertTrue(outbox.pending().isEmpty())
        assertEquals("/admin/sources/photos:local/members/dev-phone", server.takeRequest().path)
    }

    @Test
    fun an_unanswered_detach_stays_queued_and_is_retried_on_the_next_foreground() = runTest {
        server.enqueue(MockResponse().setResponseCode(503).setBody("""{"error":"writer busy"}"""))
        val m = membership()
        m.stopContributing("photos:local")!!.join()
        assertEquals(listOf(detachOp()), outbox.pending())

        server.enqueue(MockResponse().setBody("""{"source":{"id":"photos:local","type":"photos"},"members":[]}"""))
        m.retryPending()!!.join()
        assertTrue(outbox.pending().isEmpty())
        assertEquals(2, server.requestCount)
        assertEquals(null, m.retryPending())
    }

    @Test
    fun resume_supersedes_a_queued_detach_the_gateway_never_accepted() = runTest {
        server.enqueue(MockResponse().setResponseCode(503).setBody("""{"error":"writer busy"}"""))
        val m = membership()
        m.stopContributing("photos:local")!!.join()
        assertEquals(MembershipIntent.DETACH, outbox.pending().single().intent)

        server.enqueue(MockResponse().setBody("""{"items":[{"id":"photos:local","type":"photos","deviceId":"dev-phone","enabled":true}]}"""))
        m.resumeContributing("photos:local")
        assertTrue(outbox.pending().isEmpty())
        server.takeRequest()
        // The resume ran the list only; the detach was replaced, never re-sent.
        assertEquals("GET", server.takeRequest().method)
        assertEquals(2, server.requestCount)
    }

    @Test
    fun resume_then_sync_records_the_resume_before_it_asks_the_gateway() = runTest {
        // The user's tap is the only moment the intent exists, so it is
        // durable before the first call goes out: an app killed mid-request
        // must not be left off a source whose switch reads on.
        val queuedWhenAsked = mutableListOf<MembershipIntent>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                queuedWhenAsked += outbox.pending().map { it.intent }
                return MockResponse().setBody(
                    """{"items":[{"id":"photos:local","type":"photos","deviceId":"dev-phone","enabled":true}]}""",
                )
            }
        }
        var synced = 0
        membership().resumeThenSync("photos:local") { synced++ }.join()

        assertEquals(listOf(MembershipIntent.RESUME), queuedWhenAsked)
        assertEquals(1, synced)
        assertTrue(outbox.pending().isEmpty())
    }

    @Test
    fun resume_then_sync_does_not_sync_into_a_source_the_gateway_left_paused() = runTest {
        // The join lands, the unpause does not: the source is still paused, so
        // a page would be rejected and the screen would say "paused" a moment
        // after the user turned it on. The intent stays queued instead.
        server.enqueue(
            MockResponse().setBody(
                """{"items":[{"id":"photos:local","type":"photos","deviceId":"dev-owner","enabled":false,"members":["dev-owner"]}]}""",
            ),
        )
        server.enqueue(
            MockResponse().setBody(
                """{"source":{"id":"photos:local","type":"photos"},"members":["dev-owner","dev-phone"]}""",
            ),
        )
        server.enqueue(MockResponse().setResponseCode(503).setBody("""{"error":"writer busy"}"""))

        var synced = 0
        membership().resumeThenSync("photos:local") { synced++ }.join()

        assertEquals(0, synced)
        assertEquals(listOf(resumeOp()), outbox.pending())
    }

    @Test
    fun resume_then_sync_does_not_sync_a_source_this_phone_was_refused_as_a_host_of() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"items":[{"id":"photos:local","type":"photos","deviceId":"dev-owner","enabled":true,"members":["dev-owner"]}]}""",
            ),
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(409)
                .setBody("""{"error":"photos:local is hosted by Studio Desktop","code":"SOURCE_ALREADY_HOSTED"}"""),
        )

        var synced = 0
        val m = membership()
        m.resumeThenSync("photos:local") { synced++ }.join()

        assertEquals(0, synced)
        // …and the surface that asked is told, so the switch can go back off.
        assertEquals("SOURCE_ALREADY_HOSTED", m.refusals.value["photos:local"]?.code)
    }

    @Test
    fun a_refusal_stands_until_it_is_cleared() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"items":[{"id":"photos:local","type":"photos","deviceId":"dev-owner","enabled":true,"members":["dev-owner"]}]}""",
            ),
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(409)
                .setBody("""{"error":"refused","code":"DEVICE_CANNOT_HOST_TYPE"}"""),
        )
        val m = membership()
        m.resumeContributing("photos:local")

        val refused = m.refusals.value.getValue("photos:local")
        assertEquals("DEVICE_CANNOT_HOST_TYPE", refused.code)
        // The phone-side copy names neither the source nor a command line.
        assertTrue(refused.explain().isNotBlank())
        assertTrue(!refused.explain().contains("omnesis "))

        // Nothing but the taps that ask again, or turn the source off, drops
        // it: a refusal read by a screen has to survive that screen closing.
        m.clearRefusal("photos:local")
        assertTrue(m.refusals.value.isEmpty())
    }

    @Test
    fun the_revoked_copy_says_the_source_will_not_come_back_on_its_own() {
        // Re-pairing restores the pairing, not the opt-ins: every source this
        // phone hosted was turned off, and only the user turns one back on.
        val explained = SourceMembership.Outcome.Refused("DEVICE_REVOKED", "device revoked").explain()

        assertTrue(explained.contains("Re-pair"))
        assertTrue(explained.contains("turn this source back on"))
        assertTrue(explained.contains("won't resume on its own"))
    }

    @Test
    fun a_resume_is_not_queued_behind_another_sources_work() = runTest {
        // Queued work for an unrelated source must not hold the tap that asked
        // for this one: each source is carried out under its own lock, and the
        // op the caller is waiting on goes first.
        //
        // The paths are collected as the server answers them rather than read
        // off its queue afterwards: `takeRequest` blocks the caller's thread,
        // and that thread is the only one the pass carrying the other source's
        // op can run on — waiting there for a request that pass has yet to
        // make would deadlock the test rather than fail it.
        val paths = CopyOnWriteArrayList<String>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                paths += request.path.orEmpty()
                return when (request.path) {
                    "/admin/sources" -> MockResponse().setBody(
                        """{"items":[{"id":"photos:local","type":"photos","deviceId":"dev-phone","enabled":true}]}""",
                    )
                    else -> MockResponse().setBody(
                        """{"source":{"id":"notes:local","type":"notes"},"members":[]}""",
                    )
                }
            }
        }
        outbox.record(detachOp("notes:local"))

        val m = membership()
        assertEquals(SourceMembership.Outcome.Resumed, m.resumeContributing("photos:local"))
        // The caller waited on its own op alone — the queued detach did not go first.
        assertEquals(listOf("/admin/sources"), paths.toList())

        // …and it is still carried out, behind the resume rather than instead of it.
        m.drain()
        assertEquals("/admin/sources/notes:local/members/dev-phone", paths.last())
        assertTrue(outbox.pending().isEmpty())
    }

    @Test
    fun the_log_names_neither_the_source_nor_the_gateway_that_refused_it() = runTest {
        // logcat is readable by anything with an adb cable: what this phone
        // hosts, and which gateway hosts it, stay out of it.
        val lines = mutableListOf<String>()
        val here = this
        fun logged() =
            SourceMembership(
                admin = { admin() },
                deviceId = { "dev-phone" },
                outbox = outbox,
                scope = here,
                log = { lines += it },
            )

        // Unreachable: the cause would carry the gateway's host and port.
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        outbox.record(detachOp())
        logged().drain()

        // Refused for good: the gateway's own error body quotes the source.
        server.enqueue(MockResponse().setBody("""{"items":[{"id":"photos:local","type":"photos","deviceId":"dev-owner","enabled":true,"members":["dev-owner"]}]}"""))
        server.enqueue(
            MockResponse()
                .setResponseCode(409)
                .setBody("""{"error":"photos:local is hosted by Studio Desktop","code":"SOURCE_ALREADY_HOSTED"}"""),
        )
        outbox.record(resumeOp())
        logged().drain()

        // An op from a pairing the phone no longer holds.
        outbox.record(MembershipOp("photos:local", "dev-old-pairing", MembershipIntent.DETACH))
        logged().drain()

        assertTrue(lines.isNotEmpty())
        assertTrue(lines.none { it.contains("photos") })
        assertTrue(lines.none { it.contains("Studio Desktop") })
        assertTrue(lines.none { it.contains(server.hostName) || it.contains(server.port.toString()) })
        // The refusal's stable code is what a reader needs, and carries nothing personal.
        assertTrue(lines.any { it.contains("SOURCE_ALREADY_HOSTED") })
    }

    @Test
    fun an_unreadable_queue_is_reported_rather_than_dropped_in_silence() {
        val lines = mutableListOf<String>()
        val noisy = MembershipOutbox(
            read = { store[it] },
            write = { k, v -> if (v == null) store.remove(k) else store[k] = v },
            key = "queue",
            log = { lines += it },
        )
        noisy.record(detachOp())
        store["queue"] = "{ this is not the queue"

        // The queue is gone either way — but the user's tap was owed to the
        // gateway, so its loss is said out loud rather than swallowed.
        assertTrue(noisy.pending().isEmpty())
        assertEquals(1, lines.size)
        assertTrue(lines.single().contains("could not be read"))
        // …and the blob is gone, so a later read neither fails nor re-reports.
        assertTrue(!store.containsKey("queue"))
    }

    @Test
    fun stop_contributing_while_unpaired_records_nothing() = runTest {
        assertEquals(null, membership(deviceId = null).stopContributing("photos:local"))
        assertTrue(outbox.pending().isEmpty())
        assertEquals(0, server.requestCount)
    }

    @Test
    fun an_op_from_a_previous_pairing_is_dropped_not_replayed() = runTest {
        outbox.record(MembershipOp("photos:local", "dev-old-pairing", MembershipIntent.DETACH))
        membership(deviceId = "dev-phone").drain()
        assertTrue(outbox.pending().isEmpty())
        assertEquals(0, server.requestCount)
    }

    @Test
    fun outbox_keeps_one_op_per_source_survives_reload_and_only_clears_an_identical_op() {
        outbox.record(detachOp("photos:local"))
        outbox.record(detachOp("health-connect:local"))
        outbox.record(resumeOp("photos:local"))
        assertEquals(listOf(detachOp("health-connect:local"), resumeOp("photos:local")), outbox.pending())

        // A fresh outbox over the same store sees the same queue.
        val reloaded = MembershipOutbox(read = { store[it] }, write = { k, v -> if (v == null) store.remove(k) else store[k] = v })
        assertEquals(outbox.pending(), reloaded.pending())

        // Clearing the detach that was in flight must not lose the newer resume.
        outbox.clear(detachOp("photos:local"))
        assertEquals(listOf(detachOp("health-connect:local"), resumeOp("photos:local")), outbox.pending())
        outbox.clear(resumeOp("photos:local"))
        assertEquals(listOf(detachOp("health-connect:local")), outbox.pending())
    }
}
