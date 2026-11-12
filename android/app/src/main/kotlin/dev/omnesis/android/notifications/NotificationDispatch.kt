// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.notifications

import dev.omnesis.android.BuildConfig
import dev.omnesis.android.transport.dto.ClaimedNotificationDelivery
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

internal sealed interface NotificationTarget {
    data class AgentConversation(val conversationId: String) : NotificationTarget
    data class PrivacyApproval(val approvalId: String) : NotificationTarget
    data object AccessAuthorization : NotificationTarget
    data class WatchFiring(val watchId: String, val firingKey: String) : NotificationTarget
    data class SourcePermission(val sourceId: String) : NotificationTarget
    data class RemoteSourcePermission(
        val sourceId: String,
        val deviceId: String,
        val sourceName: String?,
        val deviceName: String?,
    ) : NotificationTarget
    /** The Devices screen, on the device a notification names when that device is listed. */
    data class Devices(val deviceId: String?) : NotificationTarget
    /** The Pairing requests list, where a device that signed in waits for approval. */
    data object PairingRequests : NotificationTarget
    data object App : NotificationTarget
}

internal data class ClaimedPushAction(
    val kind: String,
    val target: NotificationTarget,
)

/** Stable OS identity: a new lease for the same collapsed item replaces it. */
internal fun claimedNotificationIdentity(notification: ClaimedNotificationDelivery): String =
    notification.collapseId

internal enum class NotificationRenderOutcome(val shouldConfirm: Boolean) {
    Rendered(true),
    DeferredNotificationsDisabled(false),
    RejectedInvalid(true),
    DeferredUnknownKind(false),
}

private val cloudNotificationKinds = setOf("device-pairing", "device-joined")

/** A build without cloud connectivity defers the cloud kinds like any kind it has never heard of. */
internal fun knownNotificationKind(kind: String, cloudEnabled: Boolean = BuildConfig.CLOUD_RELAY_ENABLED): Boolean = kind in setOf(
    "diagnostic", "agent-answer", "conversation", "watch", "needs-auth", "privacy-approval",
    "source-permission",
    "access-authorization",
) || (cloudEnabled && kind in cloudNotificationKinds)

/** Strict local routing for shared notification kinds. Unknown/malformed content is ignored. */
internal fun notificationAction(
    notification: ClaimedNotificationDelivery,
    localDeviceId: String? = null,
    cloudEnabled: Boolean = BuildConfig.CLOUD_RELAY_ENABLED,
): ClaimedPushAction? {
    if (!cloudEnabled && notification.kind in cloudNotificationKinds) return null
    val route = notification.route?.takeIf {
        it.string("kind") == notification.kind
    }
    return when (notification.kind) {
        "diagnostic" -> ClaimedPushAction(notification.kind, NotificationTarget.App)
        "device-pairing" -> if (notification.targetId == "pairing") {
            ClaimedPushAction(notification.kind, NotificationTarget.PairingRequests)
        } else null
        "device-joined" -> ClaimedPushAction(
            notification.kind,
            NotificationTarget.Devices(route?.string("deviceId")?.takeIf(::validOpaqueTarget)),
        )
        "agent-answer", "conversation" ->
            (route?.string("conversationId") ?: notification.targetId)
                .takeIf(::validNotificationId)?.let {
                ClaimedPushAction(notification.kind, NotificationTarget.AgentConversation(it))
            }
        "watch" -> {
            val watchId = route?.string("watchId")
            val firingKey = route?.string("firingKey")
            // A firing the agent opened a thread about lands in the thread,
            // whose opening sentence this banner is quoting. It outranks the
            // ledger line: the thread holds the account, and this app has no
            // watch ledger to show anyway.
            val conversationId = route?.string("conversationId")?.takeIf(::validNotificationId)
            if (conversationId != null) {
                ClaimedPushAction(
                    notification.kind,
                    NotificationTarget.AgentConversation(conversationId),
                )
            } else if (watchId != null && firingKey != null && validNotificationId(watchId) &&
                validOpaqueTarget(firingKey)
            ) {
                ClaimedPushAction(
                    notification.kind,
                    NotificationTarget.WatchFiring(watchId, firingKey),
                )
            } else {
                notification.targetId.takeIf(::validNotificationId)?.let {
                    ClaimedPushAction(notification.kind, NotificationTarget.App)
                }
            }
        }
        // A needs-auth target is a source identity rather than a navigation
        // path segment. Source ids legitimately contain separators such as
        // `:` and `@`; keep it bounded and printable without applying the
        // stricter deep-link identifier grammar.
        "needs-auth" -> notification.targetId.takeIf(::validOpaqueTarget)?.let {
            ClaimedPushAction(notification.kind, NotificationTarget.App)
        }
        "source-permission" -> notification.targetId.takeIf(::validOpaqueTarget)?.let {
            val affectedDeviceId = notification.affectedDeviceId
            if (affectedDeviceId != null && !validOpaqueTarget(affectedDeviceId)) return null
            val isRemote = affectedDeviceId != null && affectedDeviceId != localDeviceId
            ClaimedPushAction(
                notification.kind,
                if (isRemote) {
                    NotificationTarget.RemoteSourcePermission(
                        sourceId = it,
                        deviceId = affectedDeviceId,
                        sourceName = notification.sourceName,
                        deviceName = notification.affectedDeviceName,
                    )
                } else {
                    NotificationTarget.SourcePermission(it)
                },
            )
        }
        "privacy-approval" ->
            (route?.string("approvalId") ?: notification.targetId)
                .takeIf(::validNotificationId)?.let {
                ClaimedPushAction(notification.kind, NotificationTarget.PrivacyApproval(it))
            }
        "access-authorization" -> if (
            notification.targetId == "access" &&
            (route == null || route.string("kind") == "access-authorization")
        ) {
            ClaimedPushAction(notification.kind, NotificationTarget.AccessAuthorization)
        } else {
            null
        }
        else -> null
    }
}

private fun JsonObject.string(key: String): String? =
    (get(key) as? JsonPrimitive)?.contentOrNull

private fun validOpaqueTarget(value: String): Boolean =
    value.length in 1..512 && value.none(Char::isISOControl)

internal fun isContentFreeWake(data: Map<String, String>): Boolean = data == mapOf("wake" to "1")

internal fun relayChallengeNonce(data: Map<String, String>): String? =
    if (data["kind"] == "relay-enrol-challenge") {
        data["nonce"]?.takeIf { it.isNotBlank() && it.length <= 4096 }
    } else null
