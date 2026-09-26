// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.journeys

import androidx.test.platform.app.InstrumentationRegistry
import dev.omnesis.android.transport.tls.LeafCertPinner
import java.net.URI
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * The synthetic gateway a journey drives the app against.
 *
 * `scripts/run-mobile-journeys.sh android` boots it on the host and passes its
 * address as the emulator reaches it (`10.0.2.2`), its admin token and its TLS
 * leaf fingerprint as instrumentation arguments. The token belongs to that
 * throwaway gateway only. The helper talks to the gateway directly to set a
 * journey up — minting a pairing code, reading back what the app did — and
 * never stands in for the app itself.
 */
class JourneyGateway private constructor(
    val url: String,
    private val token: String,
    val fingerprint: String,
) {
    private val pinner = LeafCertPinner(fingerprint)
    private val http = OkHttpClient.Builder()
        .sslSocketFactory(pinner.socketFactory, pinner.trustManager)
        .hostnameVerifier(pinner.hostnameVerifier)
        .callTimeout(45, TimeUnit.SECONDS)
        .build()

    /** `host:port` as the pairing confirmation sheet shows it. */
    val hostAndPort: String
        get() = URI(url).let { "${it.host}:${it.port}" }

    /** Mints a one-time Android pairing code and returns it with the QR payload the gateway would show. */
    fun mintPairing(deviceName: String): Pairing {
        val pending = post(
            "/admin/devices/pair",
            buildJsonObject {
                put("kind", "android")
                put("name", deviceName)
            },
        )
        val code = pending.string("pairingCode")
        val qr = post(
            "/admin/devices/pair-qr",
            buildJsonObject {
                put("pairingCode", code)
                put("gatewayUrl", url)
                put("trustMode", "pinned-leaf")
            },
        )
        return Pairing(code = code, payload = qr.string("qrPayload"))
    }

    /** Whether the gateway lists a device of [kind] with this name. */
    fun hasDevice(name: String, kind: String): Boolean {
        val items: JsonArray = request(Request.Builder().url("$url/admin/devices").get())["items"]?.jsonArray
            ?: return false
        return items.any { item ->
            val device = item.jsonObject
            device["name"]?.jsonPrimitive?.content == name && device["kind"]?.jsonPrimitive?.content == kind
        }
    }

    data class Pairing(val code: String, val payload: String)

    private fun post(path: String, body: JsonObject): JsonObject =
        request(Request.Builder().url("$url$path").post(body.toString().toRequestBody(JSON)))

    private fun request(builder: Request.Builder): JsonObject {
        val request = builder.header("Authorization", "Bearer $token").build()
        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            check(response.isSuccessful) { "The gateway answered ${request.url.encodedPath} with HTTP ${response.code}: $text" }
            return Json.parseToJsonElement(text).jsonObject
        }
    }

    private fun JsonObject.string(key: String): String =
        checkNotNull(this[key]?.jsonPrimitive?.content) { "The gateway's answer has no $key" }

    companion object {
        private val JSON = "application/json".toMediaType()

        /**
         * Reads the instrumentation arguments the journey script supplies. A run
         * without them fails rather than skipping: a silent skip would read as a pass.
         */
        fun fromInstrumentationArguments(): JourneyGateway {
            val args = InstrumentationRegistry.getArguments()
            fun required(name: String): String = checkNotNull(args.getString(name)?.takeIf(String::isNotBlank)) {
                "Instrumentation argument $name is missing. Run the journeys through scripts/run-mobile-journeys.sh android."
            }
            return JourneyGateway(
                url = required("journeyGatewayUrl").trimEnd('/'),
                token = required("journeyToken"),
                fingerprint = required("journeyFingerprint").lowercase(),
            )
        }
    }
}
