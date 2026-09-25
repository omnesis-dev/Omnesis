// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.notifications

import dev.omnesis.android.access.validAccessAuthorizationUserCode
import dev.omnesis.android.access.AccessAuthorizationPairingIdentity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/** Relays a generic notification deep link into the paired Compose nav graph. */
@Singleton
class NotificationLaunchBus @Inject constructor() {
    data class AccessAuthorization(
        val code: String? = null,
        val pairingIdentity: AccessAuthorizationPairingIdentity? = null,
        val nonce: Long = System.nanoTime(),
    )
    private val _accessAuthorization = MutableStateFlow<AccessAuthorization?>(null)
    val accessAuthorization = _accessAuthorization.asStateFlow()
    fun postAccessAuthorization(
        code: String? = null,
        pairingIdentity: AccessAuthorizationPairingIdentity? = null,
    ) {
        val validPush = code == null && pairingIdentity == null
        val validQr = code != null && pairingIdentity != null && validAccessAuthorizationUserCode(code)
        if (validPush || validQr) {
            _accessAuthorization.value = AccessAuthorization(code, pairingIdentity)
        }
    }
    fun consumeAccessAuthorization() { _accessAuthorization.value = null }

    data class SourcePermission(val sourceId: String, val nonce: Long = System.nanoTime())
    private val _sourcePermission = MutableStateFlow<SourcePermission?>(null)
    val sourcePermission = _sourcePermission.asStateFlow()
    fun postSourcePermission(sourceId: String) {
        if (sourceId.length in 1..512 && sourceId.none(Char::isISOControl)) _sourcePermission.value = SourcePermission(sourceId)
    }
    fun consumeSourcePermission() { _sourcePermission.value = null }

    data class RemoteSourcePermission(
        val sourceId: String,
        val deviceId: String,
        val sourceName: String?,
        val deviceName: String?,
        val nonce: Long = System.nanoTime(),
    )
    private val _remoteSourcePermission = MutableStateFlow<RemoteSourcePermission?>(null)
    val remoteSourcePermission = _remoteSourcePermission.asStateFlow()
    fun postRemoteSourcePermission(
        sourceId: String,
        deviceId: String,
        sourceName: String? = null,
        deviceName: String? = null,
    ) {
        if (validOpaqueNotificationValue(sourceId) && validOpaqueNotificationValue(deviceId)) {
            _remoteSourcePermission.value = RemoteSourcePermission(
                sourceId,
                deviceId,
                sourceName?.takeIf(::validOpaqueNotificationValue),
                deviceName?.takeIf(::validOpaqueNotificationValue),
            )
        }
    }
    fun consumeRemoteSourcePermission() { _remoteSourcePermission.value = null }

    data class PrivacyApproval(val approvalId: String, val nonce: Long = System.nanoTime())

    private val _privacyApproval = MutableStateFlow<PrivacyApproval?>(null)
    val privacyApproval = _privacyApproval.asStateFlow()

    fun postPrivacyApproval(approvalId: String) {
        if (validNotificationId(approvalId)) _privacyApproval.value = PrivacyApproval(approvalId)
    }

    fun consumePrivacyApproval() {
        _privacyApproval.value = null
    }

    data class AgentConversation(val conversationId: String, val nonce: Long = System.nanoTime())

    private val _agentConversation = MutableStateFlow<AgentConversation?>(null)
    val agentConversation = _agentConversation.asStateFlow()

    fun postAgentConversation(conversationId: String) {
        if (validNotificationId(conversationId)) {
            _agentConversation.value = AgentConversation(conversationId)
        }
    }

    fun consumeAgentConversation() {
        _agentConversation.value = null
    }

    data class WatchFiring(
        val watchId: String,
        val firingKey: String,
        val nonce: Long = System.nanoTime(),
    )

    private val _watchFiring = MutableStateFlow<WatchFiring?>(null)
    val watchFiring = _watchFiring.asStateFlow()

    fun postWatchFiring(watchId: String, firingKey: String) {
        if (validNotificationId(watchId) && firingKey.length in 1..512 &&
            firingKey.none(Char::isISOControl)
        ) {
            _watchFiring.value = WatchFiring(watchId, firingKey)
        }
    }

    fun consumeWatchFiring() {
        _watchFiring.value = null
    }
}

private fun validOpaqueNotificationValue(value: String): Boolean =
    value.length in 1..512 && value.none(Char::isISOControl)

/**
 * Guard for any gateway-minted identifier arriving in a push payload, before
 * it reaches an intent extra or a nav route. Bounded length, and no character
 * that could be read as path or query structure.
 */
internal fun validNotificationId(value: String): Boolean =
    value.length in 1..200 && value.all { it.isLetterOrDigit() || it == '_' || it == '-' }
