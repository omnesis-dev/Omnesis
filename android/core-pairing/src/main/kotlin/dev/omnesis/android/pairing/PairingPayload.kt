// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.dto.OmnesisJson
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.net.URI

/** Thrown when a scanned/typed pairing payload is malformed. */
class PairingPayloadException(message: String) : Exception(message)

/**
 * A decoded pairing QR / manual payload. Faithful port of the iOS `PairingPayload`:
 * V4 (explicit system or pinned-leaf trust), V3 (TLS-pinned), V2 (no pinning),
 * V1 (legacy pre-issued token). Same validation —
 * required fields, HTTPS transport, and a 64-char lowercase-hex
 * fingerprint for V3.
 */
sealed interface PairingPayload {

    sealed interface V4Tls {
        data object System : V4Tls
        data class PinnedLeaf(val fingerprint: String) : V4Tls
    }

    data class V4(val gatewayUrl: String, val pairingCode: String, val tls: V4Tls) : PairingPayload

    data class V3(val gatewayUrl: String, val pairingCode: String, val fingerprint: String) : PairingPayload
    data class V2(val gatewayUrl: String, val pairingCode: String) : PairingPayload
    data class V1(val url: String, val token: String, val accountId: String, val name: String) : PairingPayload

    companion object {
        fun decode(raw: String): PairingPayload {
            val obj = runCatching { OmnesisJson.parseToJsonElement(raw).jsonObject }
                .getOrElse { throw PairingPayloadException("invalid pairing payload: not JSON") }

            fun str(key: String): String = obj[key]?.jsonPrimitive?.contentOrNull.orEmpty()

            return when (val v = obj["v"]?.jsonPrimitive?.intOrNull) {
                4 -> {
                    val gatewayUrl = str("gatewayUrl")
                    val pairingCode = str("pairingCode")
                    requireNonEmpty(gatewayUrl, "gatewayUrl")
                    requireNonEmpty(pairingCode, "pairingCode")
                    requireHttpsUrl(gatewayUrl)
                    val tls = runCatching { obj["tls"]?.jsonObject }.getOrNull()
                        ?: throw PairingPayloadException("missing field 'tls'")
                    when (tls["mode"]?.jsonPrimitive?.contentOrNull) {
                        "system" -> {
                            requireHttpsOrigin(gatewayUrl)
                            V4(gatewayUrl, pairingCode, V4Tls.System)
                        }
                        "pinned-leaf" -> {
                            val fingerprint = tls["fingerprint"]?.jsonPrimitive?.contentOrNull.orEmpty()
                            requireNonEmpty(fingerprint, "tls.fingerprint")
                            requireValidFingerprint(fingerprint)
                            V4(gatewayUrl, pairingCode, V4Tls.PinnedLeaf(fingerprint))
                        }
                        else -> throw PairingPayloadException("invalid TLS trust mode")
                    }
                }

                3 -> {
                    val gatewayUrl = str("gatewayUrl")
                    val pairingCode = str("pairingCode")
                    val fingerprint = str("fingerprint")
                    requireNonEmpty(gatewayUrl, "gatewayUrl")
                    requireNonEmpty(pairingCode, "pairingCode")
                    requireNonEmpty(fingerprint, "fingerprint")
                    requireHttpsUrl(gatewayUrl)
                    requireValidFingerprint(fingerprint)
                    V3(gatewayUrl, pairingCode, fingerprint)
                }

                2 -> {
                    val gatewayUrl = str("gatewayUrl")
                    val pairingCode = str("pairingCode")
                    requireNonEmpty(gatewayUrl, "gatewayUrl")
                    requireNonEmpty(pairingCode, "pairingCode")
                    requireHttpsUrl(gatewayUrl)
                    V2(gatewayUrl, pairingCode)
                }

                1 -> {
                    val url = str("url")
                    val token = str("token")
                    val accountId = str("accountId")
                    requireNonEmpty(url, "url")
                    requireNonEmpty(token, "token")
                    requireNonEmpty(accountId, "accountId")
                    requireHttpsUrl(url)
                    V1(url, token, accountId, str("name"))
                }

                null -> throw PairingPayloadException("missing version field 'v'")
                else -> throw PairingPayloadException("unsupported pairing version: $v")
            }
        }

        private fun requireNonEmpty(value: String, field: String) {
            if (value.isEmpty()) throw PairingPayloadException("missing field '$field'")
        }

        /** Mobile gateway traffic is always encrypted; plaintext pairings are unsupported. */
        fun requireHttpsUrl(urlString: String): URI {
            val uri = runCatching { URI(urlString) }
                .getOrElse { throw PairingPayloadException("invalid gateway URL") }
            if (uri.scheme?.lowercase() != "https" || uri.host == null || uri.userInfo != null) {
                throw PairingPayloadException("gateway URL must use HTTPS")
            }
            return uri
        }

        /** Exact HTTPS origin used by explicit system-trust pairings. */
        fun requireHttpsOrigin(urlString: String): String {
            val uri = requireHttpsUrl(urlString)
            if (uri.scheme?.lowercase() != "https" || uri.host == null || uri.userInfo != null ||
                (uri.path.isNotEmpty() && uri.path != "/") || uri.query != null || uri.fragment != null
            ) {
                throw PairingPayloadException("system TLS trust requires an HTTPS origin")
            }
            val port = if (uri.port == -1) 443 else uri.port
            return "https://${uri.host.lowercase()}:$port"
        }

        /** 64 lowercase hex chars, matching the gateway's leaf-cert SHA-256. */
        fun requireValidFingerprint(fingerprint: String) {
            if (fingerprint.length != 64 || fingerprint.any { it !in '0'..'9' && it !in 'a'..'f' }) {
                throw PairingPayloadException("invalid TLS fingerprint")
            }
        }
    }
}
