// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.dto.StatusSnapshot
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.decodeFromString
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class TranscriptionVocabularyClientTest {
    @Test fun sendsSelfLocaleAndPurposeAndDecodesSnapshot() = runTest {
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(MockResponse().setBody("""{"enabled":true,"entries":[{"text":"Veltrio","score":2}],"refreshAfterSeconds":1800,"expiresAfterSeconds":86400}"""))
            val client = TranscriptionVocabularyClient(GatewayHttp(OkHttpClient(), server.url("/"), "fictional-token"))
            val reply = client.fetch("agent", "fr-FR")
            assertTrue(reply.enabled)
            assertEquals("Veltrio", reply.entries.single().text)
            val request = server.takeRequest()
            assertEquals("/inference/transcription-vocabulary", request.path)
            assertEquals("Bearer fictional-token", request.getHeader("Authorization"))
            assertEquals("""{"purpose":"agent","speaker":{"isSelf":true},"languageHints":["fr-FR"]}""", request.body.readUtf8())
        } finally { server.shutdown() }
    }

    @Test fun olderStatusDefaultsOff() {
        assertFalse(OmnesisJson.decodeFromString<StatusSnapshot>("{}").transcriptionVocabulary)
        assertTrue(OmnesisJson.decodeFromString<StatusSnapshot>("""{"transcriptionVocabulary":true}""").transcriptionVocabulary)
    }
}
