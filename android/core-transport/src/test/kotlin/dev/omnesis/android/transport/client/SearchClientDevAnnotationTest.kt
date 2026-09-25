// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.dto.OmnesisJson
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

/** Route/shape contract for filing developer annotations (OkHttp MockWebServer). */
class SearchClientDevAnnotationTest {

    private lateinit var server: MockWebServer

    @Before fun setUp() { server = MockWebServer(); server.start() }

    @After fun tearDown() { server.shutdown() }

    private fun client() = SearchClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))

    @Test
    fun create_dev_annotation_posts_platform_and_version_context() = runTest {
        server.enqueue(MockResponse().setResponseCode(201).setBody("{}"))
        client().createDevAnnotation(
            targetType = "document",
            targetId = "doc-1",
            note = "Sender name mis-parsed.",
            contextLabel = "Document doc-1",
            deepLink = "document/doc-1",
            appVersion = "0.4.6",
            appBuild = "1",
        )
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/dev/annotations", req.path)
        assertEquals("Bearer tok", req.getHeader("Authorization"))
        val body = OmnesisJson.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals("document", body.getValue("targetType").jsonPrimitive.content)
        assertEquals("doc-1", body.getValue("targetId").jsonPrimitive.content)
        assertEquals("Sender name mis-parsed.", body.getValue("note").jsonPrimitive.content)
        assertEquals("android", body.getValue("client").jsonPrimitive.content)
        assertEquals("document/doc-1", body.getValue("deepLink").jsonPrimitive.content)
        val context = body.getValue("context").jsonObject
        assertEquals("android", context.getValue("platform").jsonPrimitive.content)
        assertEquals("Document doc-1", context.getValue("label").jsonPrimitive.content)
        assertEquals("0.4.6", context.getValue("appVersion").jsonPrimitive.content)
        assertEquals("1", context.getValue("appBuild").jsonPrimitive.content)
    }

    @Test
    fun create_dev_annotation_files_a_freeform_route_note_without_optional_keys() = runTest {
        server.enqueue(MockResponse().setResponseCode(201).setBody("{}"))
        client().createDevAnnotation(
            targetType = "route",
            targetId = null,
            note = "General note.",
            contextLabel = null,
            deepLink = null,
            appVersion = null,
            appBuild = null,
        )
        val req = server.takeRequest()
        assertEquals("/dev/annotations", req.path)
        val body = OmnesisJson.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals("route", body.getValue("targetType").jsonPrimitive.content)
        assertEquals("android", body.getValue("client").jsonPrimitive.content)
        val context = body.getValue("context").jsonObject
        assertEquals("android", context.getValue("platform").jsonPrimitive.content)
        // Absent label/version/build stay absent rather than serializing nulls.
        assertEquals(setOf("platform"), context.keys)
    }
}
