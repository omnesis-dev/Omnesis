// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class WebhookClientTest {
    private lateinit var server: MockWebServer
    private val command = WebhookCommand("turn on the porch light", "hey_mycroft", "en-US", "2026-11-20T08:00:00Z")

    @Before fun setUp() {
        server = MockWebServer().apply { start() }
    }

    @After fun tearDown() = server.shutdown()

    private fun url() = server.url("/hook").toString()

    @Test fun theCommandIsPostedAsJsonWithTheSecretAsABearer() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(204))
        val outcome = WebhookClient(OkHttpClient()).send(url(), "s3cret", command)
        assertTrue(outcome is AssistOutcome.Done)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("Bearer s3cret", request.getHeader("Authorization"))
        assertTrue(request.getHeader("Content-Type")!!.startsWith("application/json"))
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("turn on the porch light", body["text"]!!.jsonPrimitive.content)
        assertEquals("hey_mycroft", body["wakeWord"]!!.jsonPrimitive.content)
        assertEquals("en-US", body["locale"]!!.jsonPrimitive.content)
        assertEquals("2026-11-20T08:00:00Z", body["at"]!!.jsonPrimitive.content)
    }

    @Test fun noSecretSendsNoAuthorization() = runBlocking {
        server.enqueue(MockResponse())
        WebhookClient(OkHttpClient()).send(url(), null, command)
        assertNull(server.takeRequest().getHeader("Authorization"))
    }

    @Test fun anErrorAnswerFails() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401))
        val outcome = WebhookClient(OkHttpClient()).send(url(), "wrong", command)
        assertEquals(AssistOutcome.Failed("HTTP 401"), outcome)
    }

    @Test fun noAnswerInTimeFailsAndIsNotRetried() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val outcome = WebhookClient(OkHttpClient(), timeoutMs = 300).send(url(), null, command)
        assertTrue(outcome is AssistOutcome.Failed)
        assertEquals(1, server.requestCount)
    }

    @Test fun anAddressThatIsNotHttpIsNeverCalled() = runBlocking {
        val outcome = WebhookClient(OkHttpClient()).send("ftp://hooks.example.com", null, command)
        assertTrue(outcome is AssistOutcome.Failed)
        assertEquals(0, server.requestCount)
    }

    @Test fun webhookAddresses() {
        assertTrue(isWebhookUrl("https://hooks.example.com/a?b=c"))
        assertTrue(isWebhookUrl(" http://192.0.2.4:1880/voice "))
        assertFalse(isWebhookUrl(""))
        assertFalse(isWebhookUrl("https://"))
        assertFalse(isWebhookUrl("hooks.example.com"))
        assertFalse(isWebhookUrl("https://bad host"))
    }
}
