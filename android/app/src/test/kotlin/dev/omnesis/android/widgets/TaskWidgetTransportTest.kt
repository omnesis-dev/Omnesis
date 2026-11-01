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
}
