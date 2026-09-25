// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.access

import android.content.Intent
import android.net.Uri
import dev.omnesis.android.pairing.Pairing

internal const val ACCESS_AUTHORIZATION_DEEP_LINK_SCHEME = "omnesis"
internal const val ACCESS_AUTHORIZATION_DEEP_LINK_HOST = "access-authorization"

/** Non-secret identity of the pairing active when a QR was opened. */
data class AccessAuthorizationPairingIdentity(
    val gatewayUrl: String,
    val deviceId: String?,
    val pairingGeneration: String?,
)

internal fun Pairing.accessAuthorizationIdentity() = AccessAuthorizationPairingIdentity(
    gatewayUrl = url,
    deviceId = deviceId,
    pairingGeneration = pairingGeneration,
)

internal fun accessAuthorizationPairingMatches(
    expected: AccessAuthorizationPairingIdentity?,
    current: AccessAuthorizationPairingIdentity?,
): Boolean = expected == null || expected == current

private const val ACCESS_AUTHORIZATION_USER_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
private val ACCESS_AUTHORIZATION_USER_CODE = Regex(
    "[$ACCESS_AUTHORIZATION_USER_CODE_ALPHABET]{4}-[$ACCESS_AUTHORIZATION_USER_CODE_ALPHABET]{4}",
)

/** The only value a public authorization deep link is allowed to carry. */
internal fun validAccessAuthorizationUserCode(code: String): Boolean =
    ACCESS_AUTHORIZATION_USER_CODE.matches(code)

/**
 * Decodes the versioned, code-only handoff emitted by the OAuth consent page.
 *
 * The link deliberately cannot name or change a gateway. The code is always
 * resolved through the session already paired with this phone, and opening the
 * link only starts the existing review flow; it never approves the request.
 */
internal fun accessAuthorizationCode(intent: Intent?): String? {
    if (intent?.action != Intent.ACTION_VIEW) return null
    val uri = intent.data ?: return null
    return runCatching { accessAuthorizationCode(uri) }.getOrNull()
}

private fun accessAuthorizationCode(uri: Uri): String? {
    if (!uri.isHierarchical ||
        uri.scheme != ACCESS_AUTHORIZATION_DEEP_LINK_SCHEME ||
        uri.host != ACCESS_AUTHORIZATION_DEEP_LINK_HOST ||
        uri.userInfo != null ||
        uri.port != -1 ||
        !uri.path.isNullOrEmpty() ||
        uri.fragment != null ||
        uri.queryParameterNames != setOf("v", "code") ||
        uri.getQueryParameters("v").size != 1 ||
        uri.getQueryParameters("code").size != 1 ||
        uri.getQueryParameter("v") != "1"
    ) {
        return null
    }
    return uri.getQueryParameter("code")?.takeIf(::validAccessAuthorizationUserCode)
}

/** Routes a fresh activity delivery into the paired Compose navigation graph. */
internal fun routeAccessAuthorizationDeepLink(
    intent: Intent?,
    freshDelivery: Boolean,
    pairingIdentity: AccessAuthorizationPairingIdentity?,
    onLaunch: (String, AccessAuthorizationPairingIdentity) -> Unit,
): Boolean {
    if (!freshDelivery) return false
    val code = accessAuthorizationCode(intent) ?: return false
    pairingIdentity?.let { identity -> onLaunch(code, identity) }
    return true
}

/** Removes a handled public URI so an Activity recreation cannot replay it. */
internal fun consumedAccessAuthorizationIntent(intent: Intent): Intent = Intent(intent).apply {
    action = null
    data = null
}
