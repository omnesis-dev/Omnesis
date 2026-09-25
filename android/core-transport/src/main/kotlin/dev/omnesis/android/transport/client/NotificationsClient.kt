// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.dto.ClaimedNotificationDelivery
import dev.omnesis.android.transport.dto.ConfirmNotificationBody
import dev.omnesis.android.transport.dto.OkResponse
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.http.decodeBody
import dev.omnesis.android.transport.http.postJson
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

/** Device-scoped notification lease client. Notification text only crosses the paired channel. */
class NotificationsClient(private val http: GatewayHttp) {
    suspend fun claim(): ClaimedNotificationDelivery? {
        val request = http.newRequest(http.urlFor("notifications/claim"))
            .post("{}".toRequestBody(JSON_MEDIA))
            .build()
        val body = http.execute(request)
        return if (body.isBlank()) null else decodeBody(body)
    }

    suspend fun confirm(id: String) {
        http.postJson<ConfirmNotificationBody, OkResponse>(
            "notifications/confirm",
            ConfirmNotificationBody(id),
        )
    }

    private companion object {
        val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    }
}
