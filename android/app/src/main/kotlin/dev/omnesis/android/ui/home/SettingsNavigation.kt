// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import android.net.Uri
import androidx.navigation.NamedNavArgument
import androidx.navigation.NavController
import androidx.navigation.NavType
import androidx.navigation.navArgument
import dev.omnesis.android.access.AccessAuthorizationPairingIdentity
import dev.omnesis.android.setup.flow.PhoneSetupEntry
import dev.omnesis.android.ui.phonesetup.PHONE_SETUP_ENTRY_ARGUMENT
import dev.omnesis.android.ui.phonesetup.PHONE_SETUP_STEP_ARGUMENT

internal const val SETTINGS_ROUTE = "settings"
internal const val MODELS_ROUTE = "models"
internal const val DEVICES_ROUTE = "devices"

/**
 * The privacy policy families. A policy is a rule an answer is judged by, so it sits under
 * Settings beside the grants that name it rather than on the Privacy event feed.
 */
internal const val POLICIES_ROUTE = "policies"

/**
 * One policy family's document, beneath the list. The optional name is the caller's preset
 * for the title; the document route does not carry one.
 */
internal const val POLICY_ROUTE_PATTERN = "$POLICIES_ROUTE/{familyId}?name={name}"
internal const val ACCESS_AUTHORIZATION_ROUTE = "access/authorize"

/**
 * The phone setup flow. Opened from Settings it starts at Choose, or shows one
 * source's page when that source's card opens it; the first run hosts it
 * outside the shell.
 */
internal const val PHONE_SETUP_ROUTE = "phone-setup"
internal const val PHONE_SETUP_ROUTE_PATTERN =
    "$PHONE_SETUP_ROUTE?$PHONE_SETUP_ENTRY_ARGUMENT={$PHONE_SETUP_ENTRY_ARGUMENT}&$PHONE_SETUP_STEP_ARGUMENT={$PHONE_SETUP_STEP_ARGUMENT}"

/** The flow route's arguments; [defaultEntry] is how a route naming no entry opens it. */
internal fun phoneSetupArguments(defaultEntry: PhoneSetupEntry): List<NamedNavArgument> = listOf(
    navArgument(PHONE_SETUP_ENTRY_ARGUMENT) {
        type = NavType.StringType
        defaultValue = defaultEntry.name
    },
    navArgument(PHONE_SETUP_STEP_ARGUMENT) {
        type = NavType.StringType
        nullable = true
        defaultValue = null
    },
)

/** The flow on one step, as a source's Settings card opens it; the id is URL-encoded. */
internal fun phoneSetupStepRoute(stepId: String): String =
    "$PHONE_SETUP_ROUTE?$PHONE_SETUP_ENTRY_ARGUMENT=${PhoneSetupEntry.SOURCE.name}&$PHONE_SETUP_STEP_ARGUMENT=${Uri.encode(stepId)}"

/**
 * The wizard's route. `code` carries a delivered user code and `request` the id of a request
 * the main screen's banner named; a launch carries at most one of the two. `launch` is the
 * delivery's nonce and the `gateway`/`device`/`generation` triple the pairing it was made for.
 */
internal const val ACCESS_AUTHORIZATION_ROUTE_PATTERN =
    "$ACCESS_AUTHORIZATION_ROUTE?code={code}&request={request}&launch={launch}&gateway={gateway}" +
        "&device={device}&generation={generation}"

private val settingsChildRoutes =
    setOf(MODELS_ROUTE, DEVICES_ROUTE, POLICIES_ROUTE, ACCESS_AUTHORIZATION_ROUTE)

/**
 * Opens a Settings child with exactly one Settings entry beneath it. Existing child state is
 * discarded so switching Models -> Devices cannot grow a Settings/child sandwich.
 */
internal fun NavController.navigateToSettingsChild(route: String) {
    require(route in settingsChildRoutes) { "Not a Settings child route: $route" }

    val foundSettings = popToCanonicalSettings()
    if (!foundSettings) {
        if (currentDestination?.route.isSettingsLineage()) {
            replaceOrphanLineageWithSettings()
        } else {
            navigate(SETTINGS_ROUTE) { launchSingleTop = true }
        }
    }
    navigate(route) { launchSingleTop = true }
}

/** Returns to the canonical Settings parent, replacing an orphan child if necessary. */
internal fun NavController.returnToSettings() {
    if (popToCanonicalSettings()) {
        return
    }
    replaceOrphanLineageWithSettings()
}

/**
 * Pops through any stale Settings/child sandwiches and leaves the oldest contiguous Settings
 * parent current, keeping restored noncanonical stacks from exposing an orphan child later.
 */
private fun NavController.popToCanonicalSettings(): Boolean {
    var foundSettings =
        popBackStack(SETTINGS_ROUTE, inclusive = false) || currentDestination?.route == SETTINGS_ROUTE
    while (foundSettings && previousBackStackEntry?.destination?.route.isSettingsLineage()) {
        popBackStack()
        foundSettings =
            popBackStack(SETTINGS_ROUTE, inclusive = false) || currentDestination?.route == SETTINGS_ROUTE
    }
    return foundSettings
}

private fun String?.isSettingsLineage(): Boolean =
    this == SETTINGS_ROUTE || this in settingsChildRoutes ||
        this == ACCESS_AUTHORIZATION_ROUTE_PATTERN || this == POLICY_ROUTE_PATTERN ||
        this?.startsWith("$MODELS_ROUTE/") == true

/** Both segments are URL-encoded so an id or a name with `/`, `?` or `&` round-trips. */
internal fun policyRoute(familyId: String, name: String? = null): String {
    val base = "$POLICIES_ROUTE/${Uri.encode(familyId)}"
    return name?.takeIf { it.isNotBlank() }?.let { "$base?name=${Uri.encode(it)}" } ?: base
}

internal fun accessAuthorizationRoute(
    code: String?,
    nonce: Long,
    pairing: AccessAuthorizationPairingIdentity? = null,
    requestId: String? = null,
): String = buildString {
    require(code == null || requestId == null) { "A launch names a code or a request, not both" }
    append(ACCESS_AUTHORIZATION_ROUTE)
    when {
        code != null -> {
            append("?code=")
            append(Uri.encode(code))
            append("&launch=")
        }
        requestId != null -> {
            append("?request=")
            append(Uri.encode(requestId))
            append("&launch=")
        }
        else -> append("?launch=")
    }
    append(nonce)
    if (pairing != null) {
        append("&gateway=")
        append(Uri.encode(pairing.gatewayUrl))
        pairing.deviceId?.let {
            append("&device=")
            append(Uri.encode(it))
        }
        pairing.pairingGeneration?.let {
            append("&generation=")
            append(Uri.encode(it))
        }
    }
}

private fun NavController.replaceOrphanLineageWithSettings() {
    while (currentDestination?.route.isSettingsLineage()) {
        if (!popBackStack()) break
    }
    navigate(SETTINGS_ROUTE) { launchSingleTop = true }
}
