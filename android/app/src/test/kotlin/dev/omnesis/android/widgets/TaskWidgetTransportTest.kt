// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.widgets

import dev.omnesis.android.pairing.Pairing
import dev.omnesis.android.pairing.PairingTlsMode
import dev.omnesis.android.transport.client.TaskView
import dev.omnesis.android.transport.tls.LeafCertPinner
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

class TaskWidgetTransportTest {
    @Test fun paired_widget_fetch_and_completion_keep_tls_pin_auth_and_opaque_identifier() = runTest {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        MockWebServer().use { server ->
            server.useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
            server.enqueue(MockResponse().setBody("""{"tasks":[{"id":"one","title":"Read a new chapter"}]}"""))
            server.enqueue(MockResponse().setBody("{}"))
            server.start()
            val client = PairedWidgetTasksGateway(Pairing(
                url = server.url("/").toString(), token = "test-token", pairingGeneration = "test-generation",
                deviceId = "test-phone", gatewayName = "Example gateway",
                tlsMode = PairingTlsMode.PINNED_LEAF,
                fingerprint = LeafCertPinner.sha256Hex(certificate.certificate.encoded),
            ))
            assertEquals(listOf("one"), client.tasks(TaskView.TODAY, "2026-10-14").map { it.id })
            val read = server.takeRequest()
            assertEquals("/tasks?view=today&date=2026-10-14", read.path)
            assertEquals("Bearer test-token", read.getHeader("Authorization"))
            assertEquals("test-generation", read.getHeader("Omnesis-Pairing-Generation"))
            client.complete("task/with?#fragment")
            val complete = server.takeRequest()
            assertEquals("/tasks/task%2Fwith%3F%23fragment/actions", complete.path)
            assertEquals("POST", complete.method)
            assertEquals("""{"action":"complete"}""", complete.body.readUtf8())
        }
    }
    @Test fun key_paired_widget_keeps_strict_key_host_and_bearer_on_real_https() = runTest {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        MockWebServer().use { server ->
            server.useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
            server.enqueue(MockResponse().setBody("{\"tasks\":[]}"))
            server.start()
            val paired = Pairing(url = server.url("/").toString(), token = "widget-test-token", pairingGeneration = "widget-generation",
                deviceId = "widget-device", gatewayName = "Test gateway", tlsMode = PairingTlsMode.PINNED_KEY_STRICT,
                spkiFingerprint = LeafCertPinner.sha256Hex(certificate.certificate.publicKey.encoded))
            assertTrue(PairedWidgetTasksGateway(paired).tasks(TaskView.TODAY, "2026-10-14").isEmpty())
            assertEquals("Bearer widget-test-token", server.takeRequest().getHeader("Authorization"))
            try {
                PairedWidgetTasksGateway(paired.copy(spkiFingerprint = "0".repeat(64))).tasks(TaskView.TODAY, "2026-10-14")
                fail("Replacement key released a widget credential")
            } catch (_: Exception) { }
            assertEquals(1, server.requestCount)
        }
    }

    @Test fun legacy_status_keeps_widget_tasks_and_explicit_lab_off_clears_its_cache() = runTest {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        MockWebServer().use { server ->
            server.useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
            server.enqueue(MockResponse().setBody("""{"experimental":false,"tasks":{"available":true}}"""))
            repeat(4) { server.enqueue(MockResponse().setBody("""{"tasks":[{"id":"one","title":"Read a new chapter"}]}""")) }
            server.enqueue(MockResponse().setBody("""{"experimental":true,"tasks":{"available":true},"lab":{"brain":false,"tasks":false,"watches":false}}"""))
            server.enqueue(MockResponse().setBody("""{"experimental":true,"tasks":{"available":true},"lab":{"tasks":false}}"""))
            server.start()
            val paired = Pairing(url = server.url("/").toString(), token = "widget-test-token", pairingGeneration = "widget-generation",
                deviceId = "widget-device", gatewayName = "Test gateway", tlsMode = PairingTlsMode.PINNED_LEAF,
                fingerprint = LeafCertPinner.sha256Hex(certificate.certificate.encoded))
            var saved: TaskWidgetSnapshot? = null
            val cache = object : WidgetSnapshotStore {
                override fun read(authority: String) = saved
                override fun save(authority: String, snapshot: TaskWidgetSnapshot) { saved = snapshot }
                override fun clear() { saved = null }
            }
            val repository = TaskWidgetRepository({ paired }, cache)
            val legacy = repository.refresh()
            assertEquals(TaskWidgetStatus.READY, legacy.status)
            assertEquals(listOf("one"), legacy.snapshot!!.tasks.map { it.id })
            repeat(5) { server.takeRequest() }

            val disabled = repository.refresh()
            assertEquals(TaskWidgetStatus.DISABLED, disabled.status)
            assertNull(disabled.snapshot)
            assertNull(saved)
            assertEquals("/status", server.takeRequest().path)
            try {
                repository.complete("one", TaskWidgetRepository.authority(paired))
                fail("Disabled Tasks accepted a widget completion")
            } catch (_: WidgetTasksDisabled) { }
            val denied = server.takeRequest()
            assertEquals("/status", denied.path)
            assertEquals("Bearer widget-test-token", denied.getHeader("Authorization"))
            assertEquals(7, server.requestCount)
        }
    }

}
