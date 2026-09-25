// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** Private claim response. Typed route data never crosses the carrier boundary. */
@Serializable
data class ClaimedNotificationDelivery(
    val id: String,
    val kind: String,
    val targetId: String,
    val title: String,
    val body: String,
    val collapseId: String,
    val remaining: Int = 0,
    val route: JsonObject? = null,
    /** Device whose source needs repair; absent on older gateways and non-source notifications. */
    val affectedDeviceId: String? = null,
    val sourceName: String? = null,
    val affectedDeviceName: String? = null,
)

@Serializable
data class ConfirmNotificationBody(val id: String)

/** `GET /admin/devices/:id/push-plan`. Unknown transports remain decodable. */
@Serializable
data class PushPlan(
    val transport: String,
    val relayUrl: String? = null,
    val reason: String? = null,
    val reasonCode: String? = null,
)

@Serializable
data class RelayPushConsentBody(
    val platform: String,
    val appId: String,
)

@Serializable
data class DirectFcmPushRegistrationBody(
    val transport: String,
    val registrationToken: String,
    val projectId: String,
)

@Serializable
data class RelayPushRegistrationBody(
    val transport: String,
    val relayUrl: String,
    val credential: String,
)
