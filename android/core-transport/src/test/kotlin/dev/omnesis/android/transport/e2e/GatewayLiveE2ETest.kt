// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.e2e

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.client.AgentClient
import dev.omnesis.android.transport.client.GatewayClient
import dev.omnesis.android.transport.client.SearchClient
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.tls.PinnedOkHttp
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.File

/**
 * Live-gateway E2E — the Android port of `GatewayLiveE2ETests.swift`. Runs the REAL
 * transport clients against a spawned synthetic gateway over HTTPS with the REAL
 * [LeafCertPinner] pinned to the gateway's self-signed leaf fingerprint.
 *
 * Boot the gateway and run via `scripts/run-android-e2e.sh`. Without the config file
 * (normal `./gradlew test`) every case self-skips, so this never breaks the unit lane.
 */
class GatewayLiveE2ETest {

    @Serializable
    private data class Config(
        val gatewayURL: String,
        val apiToken: String,
        val tlsFingerprint: String? = null,
    )

    private lateinit var gateway: GatewayClient
    private lateinit var search: SearchClient
    private lateinit var admin: AdminClient
    private lateinit var agent: AgentClient

    @Before
    fun setUp() {
        // Only runs under scripts/run-android-e2e.sh, which boots a synth gateway and
        // passes -PomnesisE2e. Plain `./gradlew test` skips it (a stale config file
        // must never make it run against an unrelated gateway).
        assumeTrue(
            "live-gateway E2E not enabled — run via scripts/run-android-e2e.sh",
            System.getProperty("omnesis.android.e2e") == "1",
        )
        val file = File(CONFIG_PATH)
        assumeTrue("no live-gateway config at $CONFIG_PATH", file.exists())
        val cfg = OmnesisJson.decodeFromString<Config>(file.readText())
        val http = GatewayHttp(PinnedOkHttp.build(cfg.tlsFingerprint), cfg.gatewayURL, cfg.apiToken)
        gateway = GatewayClient(http)
        search = SearchClient(http)
        admin = AdminClient(http)
        agent = AgentClient(http)
    }

    @Test
    fun health_is_reachable_over_pinned_tls() = runBlocking {
        assertTrue("gateway /health should succeed over pinned TLS", gateway.health())
    }

    @Test
    fun status_decodes() = runBlocking {
        val status = gateway.status()
        assertTrue("documents.total should be present", status.documents.total >= 0)
    }

    @Test
    fun whoami_returns_scopes() = runBlocking {
        val who = gateway.whoami()
        assertTrue("bootstrap token should carry scopes", who.scopes.isNotEmpty())
    }

    /**
     * The descriptors decode is the highest-value contract check: the exact iOS
     * analogue once caught a real optional-field decode bug. Every descriptor must
     * carry the fields the generic renderer relies on.
     */
    @Test
    fun source_descriptors_decode() = runBlocking {
        val descriptors = admin.descriptors()
        assertTrue("expected at least one source descriptor", descriptors.isNotEmpty())
        descriptors.forEach {
            assertTrue("descriptor typeId must be non-blank", it.typeId.isNotBlank())
            assertTrue("descriptor name must be non-blank", it.name.isNotBlank())
        }
    }

    /** Phase-2 read surface: every endpoint the Sources screen uses must decode. */
    @Test
    fun sources_index_meta_decode() = runBlocking {
        val sources = admin.sources()
        admin.syncStatus()
        admin.devices()
        admin.sourceMeta()
        gateway.indexStats()
        sources.firstOrNull()?.let { search.recent(it.id) }
        assertTrue("all Phase-2 read endpoints decoded without throwing", true)
    }

    @Test
    fun people_decode() = runBlocking {
        val people = search.people(limit = 50)
        people.firstOrNull()?.let { p ->
            search.person(p.id)
            search.personDocuments(p.id, limit = 5, offset = 0)
        }
        assertTrue("people endpoints decoded without throwing", true)
    }

    /**
     * Phase-4 agent control surface. A synth gateway with no configured LLM backend
     * returns 503 on every agent route — the exact `fatalError` path the UI handles. So
     * each call must EITHER decode cleanly (when the harness is enabled) OR surface a
     * classified [GatewayException.ServerError]; a decode/transport corruption
     * (`GatewayException.Decoding`) is NOT tolerated and fails the test. The full
     * event/tool-result decode contract is covered by the unit-level AgentDtoDecodeTest.
     */
    @Test
    fun agent_control_endpoints_decode() = runBlocking {
        suspend fun tolerateUnavailable(call: suspend () -> Unit) {
            try {
                call()
            } catch (e: GatewayException.ServerError) {
                // agent harness not configured on the synth gateway — acceptable.
            }
        }
        tolerateUnavailable { agent.conversations() } // GET /agent/conversations
        tolerateUnavailable { agent.model() } // GET /agent/model
        tolerateUnavailable {
            val session = agent.createSession()
            assertTrue("created session id should be non-blank", session.sessionId.isNotBlank())
        }
        assertTrue("agent control endpoints wired + classified cleanly", true)
    }

    /** Model assignments decode from `GET /admin/models`. */
    @Test
    fun models_decode() = runBlocking {
        admin.modelOverview() // GET /admin/models → full overview (displays + inference + catalog)
        assertTrue("models read surface decoded without throwing", true)
    }

    @Test
    fun access_grant_choices_decode() = runBlocking {
        val overview = admin.accessOverview()
        assertTrue("access source identities should be non-blank", overview.sources.all { it.id.isNotBlank() })
    }

    @Test
    fun search_and_document_detail_decode() = runBlocking {
        val response = search.search(text = "the", limit = 5, verbose = true)
        // The e2e-minimal universe carries content; if a hit comes back, open it.
        val first = response.results.firstOrNull()
        if (first != null) {
            val doc = search.document(first.documentId)
            assertTrue("document detail id should be non-blank", doc.id.isNotBlank())
            assertTrue("document sourceId should be non-blank", doc.sourceId.isNotBlank())
        }
    }

    private companion object {
        const val CONFIG_PATH = "/tmp/omnesis-android-e2e-config.json"
    }
}
