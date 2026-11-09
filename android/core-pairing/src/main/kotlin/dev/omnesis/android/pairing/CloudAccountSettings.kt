// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.dto.CloudRelayStatus
import dev.omnesis.android.transport.dto.relayEpochMillis
import kotlinx.serialization.json.JsonElement
import java.net.URI
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * The one state the Omnesis account screen is in. The wording and the order of the checks
 * are the portal's (`relayPhase` in `packages/gateway/portal/js/views/relay.js`), so the app
 * and the portal never describe one gateway two ways.
 */
enum class CloudAccountPhase {
    Unavailable, NotConnected, Waiting, Registering, Linking, Failed, Off, Connected, Reconnecting, Disconnected;

    /** The gateway has an address: the account, remote access and new devices sections apply. */
    val established: Boolean get() = this == Connected || this == Reconnecting || this == Disconnected || this == Off

    /** A connect is under way and the gateway moves on by itself. */
    val inProgress: Boolean get() = this == Waiting || this == Registering || this == Linking
}

/** An active connect outranks everything, then a failure, then the connection. */
fun cloudAccountPhase(status: CloudRelayStatus): CloudAccountPhase {
    when (status.connect?.state) {
        "waiting" -> return CloudAccountPhase.Waiting
        "registering" -> return CloudAccountPhase.Registering
        "linking" -> return CloudAccountPhase.Linking
        "failed" -> return CloudAccountPhase.Failed
    }
    val enrolled = status.enrollment?.state == "enrolled"
    val enabled = status.enabled == true
    if (!enrolled && !enabled) {
        if (status.serviceConfigured != true) return CloudAccountPhase.Unavailable
        if (status.enrollment?.state == "failed") return CloudAccountPhase.Failed
        return CloudAccountPhase.NotConnected
    }
    if (!enabled) return CloudAccountPhase.Off
    if (!enrolled) return CloudAccountPhase.Registering
    return when (status.tunnel?.state) {
        "online" -> CloudAccountPhase.Connected
        "offline" -> CloudAccountPhase.Disconnected
        else -> CloudAccountPhase.Reconnecting
    }
}

/** How often the screen re-reads the status: closely while a connect is under way. */
fun cloudAccountPollMillis(status: CloudRelayStatus?): Long =
    if (status?.connect?.state in setOf("waiting", "registering", "linking")) 2_000 else 5_000

// This gateway watches public certificate logs for a certificate it did not ask for.
private const val CT_LATER =
    "The check for unexpected certificates could not finish. It runs again by itself. Nothing else is affected."
private const val CT_BROKEN =
    "The check for unexpected certificates is not working. Remote access keeps working. Copy the details and ask for help."

private val errorTexts = mapOf(
    "account-unavailable" to "Omnesis account sign-in is unavailable. Direct connections and QR pairing remain available.",
    "account-link-failed" to "Couldn't connect this gateway to your Omnesis account. Try again. Existing device access is unchanged.",
    "ct-configuration-invalid" to CT_BROKEN,
    "ct-provider-unavailable" to CT_LATER,
    "ct-provider-refused" to CT_BROKEN,
    "ct-provider-invalid" to CT_LATER,
    "ct-scan-incomplete" to CT_LATER,
    "ct-journal-invalid" to CT_BROKEN,
    "ct-journal-write-failed" to CT_BROKEN,
    "hostname-conflict" to "Choose a different public gateway hostname. This name is already covered by the direct/default certificate.",
    "hostname-required" to "This relay needs a public gateway hostname. Enter its HTTPS origin in custom domain settings.",
    "ca-terms-required" to "Accept the configured certificate authority’s terms before enabling public certificates.",
    "operation-in-progress" to "Another change is in progress. Wait for it to finish and try again.",
    "google-unavailable" to "Google sign-in is unavailable. Remote access and QR pairing work without it.",
    "google-link-failed" to "Couldn't connect with Google. Try again. Gateway access is unchanged.",
    "relay-service-unavailable" to "Omnesis account setup is unavailable. Ask the installation administrator to configure the relay service.",
    "relay-service-mismatch" to "The installation service configuration does not match this gateway. Ask the installation administrator to resolve it.",
    "configuration-invalid" to "Check the public gateway origin and certificate settings.",
    "relay-unreachable" to "Omnesis Relay could not be reached. Check this gateway's internet connection. It keeps trying by itself.",
    "invitation-required" to "This relay requires an invitation for this gateway ID.",
    "enrollment-refused" to "This gateway couldn't register with Omnesis Relay. It keeps trying by itself. If this message stays, try connecting again.",
    "tunnel-disconnected" to "Remote access was interrupted. Reconnect to try again.",
    "certificate-setup-failed" to "The certificate for this gateway's address could not be prepared. The gateway tries again by itself.",
    "certificate-renewal-failed" to "The certificate for this gateway's address could not be renewed. The gateway tries again by itself.",
    "public-endpoint-unreachable" to "This gateway's address does not answer from outside your home network. Check that this gateway is online. It checks again by itself.",
)

/** What the app says where only the portal's manual setup form can act. */
const val CLOUD_ACCOUNT_PORTAL_SENTENCE = "Open the portal on your gateway to finish this."

/** Failures whose remedy is a field of the portal's manual setup form, which the app does not have. */
private val manualSetupCodes = setOf(
    "hostname-conflict", "hostname-required", "ca-terms-required", "configuration-invalid", "invitation-required",
)

fun cloudAccountNeedsPortal(code: String?): Boolean = code in manualSetupCodes

/**
 * The portal's sentence for an error code the status carries, with where to go when only manual
 * setup fixes it. A code this build predates gets a general sentence.
 */
fun cloudAccountErrorText(code: String?): String? {
    if (code.isNullOrEmpty()) return null
    val text = errorTexts[code] ?: "An operation failed. Check settings and retry."
    return if (cloudAccountNeedsPortal(code)) "$text $CLOUD_ACCOUNT_PORTAL_SENTENCE" else text
}

/** The text for a code the portal names, or null. */
internal fun cloudAccountKnownErrorText(code: String?): String? = if (code in errorTexts) cloudAccountErrorText(code) else null

const val CLOUD_ACCOUNT_REQUEST_FAILED =
    "Couldn't load or update your Omnesis account settings. Check the connection and try again."

/** [value] when it is an HTTPS address without credentials, the only kind this screen opens or shows. */
fun cloudAccountHttpsUrl(value: String?): String? {
    if (value == null || value.length > 2048) return null
    val uri = runCatching { URI(value) }.getOrNull() ?: return null
    return value.takeIf { uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrEmpty() && uri.rawUserInfo == null }
}

/** An already checked HTTPS address without its scheme, so it reads like something to type. */
fun cloudAccountDisplayUrl(safe: String): String {
    val uri = URI(safe)
    val host = uri.host + if (uri.port == -1 || uri.port == 443) "" else ":${uri.port}"
    return host + (uri.rawPath.orEmpty().takeUnless { it == "/" } ?: "")
}

/** The relay's own account page, which "Manage your account" opens. */
fun cloudAccountPageUrl(relayUrl: String?): String? {
    val uri = URI(cloudAccountHttpsUrl(relayUrl) ?: return null)
    return "https://${uri.host}${if (uri.port == -1) "" else ":${uri.port}"}/_relay/account"
}

private val connectCode = Regex("^[A-Z0-9-]{4,16}$")

/** What the waiting state shows for finishing the sign-in on another device. */
data class CloudAccountElsewhere(val url: String, val shownAddress: String, val code: String, val expiresAtMillis: Long?)

fun cloudAccountElsewhere(status: CloudRelayStatus): CloudAccountElsewhere? {
    val connect = status.connect ?: return null
    val url = cloudAccountHttpsUrl(connect.connectUrl) ?: return null
    val code = connect.code?.takeIf(connectCode::matches) ?: return null
    // The relay's short address is only shown; the link itself stays on the relay's own page.
    val shown = cloudAccountHttpsUrl(connect.connectShortUrl) ?: url
    return CloudAccountElsewhere(url, cloudAccountDisplayUrl(shown), code, relayEpochMillis(connect.expiresAt))
}

/** Whether this gateway has an account row to show: an Omnesis account, or the older Google-only link. */
fun cloudAccountShown(status: CloudRelayStatus): Boolean {
    val account = status.account
    val google = status.google
    return account?.activated == true || account?.configured == true || account?.linked == true ||
        account?.pendingUnlink == true || google?.configured == true || google?.linked == true
}

/** Whether the account row describes an Omnesis account rather than the older Google-only link. */
fun cloudAccountUsesAccount(status: CloudRelayStatus): Boolean {
    val account = status.account
    return account?.activated == true || account?.configured == true || account?.linked == true || account?.pendingUnlink == true
}

/** Whether this gateway is on an account, by either kind of link. */
fun cloudAccountLinked(status: CloudRelayStatus): Boolean =
    if (cloudAccountUsesAccount(status)) status.account?.linked == true else status.google?.linked == true

fun cloudAccountLine(status: CloudRelayStatus): String {
    val linked = cloudAccountLinked(status)
    return if (cloudAccountUsesAccount(status)) {
        if (linked) "This gateway is linked to your Omnesis account." else "This gateway is not linked to an Omnesis account."
    } else {
        if (linked) "This gateway is connected with Google." else "This gateway is not connected with Google."
    }
}

/**
 * What to know while the gateway is not on an account. Linking a registered gateway ends on the
 * gateway's own page, in a browser that holds a portal session, so it stays in the portal.
 */
fun cloudAccountHints(status: CloudRelayStatus): List<String> {
    if (cloudAccountLinked(status)) return emptyList()
    if (!cloudAccountUsesAccount(status)) {
        val hint = "Connect with Google to find this gateway on your other devices. QR pairing works without it."
        return if (status.google?.canLink == true) listOf(hint, CLOUD_ACCOUNT_PORTAL_SENTENCE) else listOf(hint)
    }
    if (status.account?.pendingUnlink == true) {
        return listOf("Disconnected here. Your Omnesis account updates when the connection returns.")
    }
    val hint = "Connect it to find this gateway when you sign in on a new device. QR pairing works without an account."
    return if (status.account?.canLink == true) listOf(hint, CLOUD_ACCOUNT_PORTAL_SENTENCE) else listOf(hint)
}

const val CLOUD_ACCOUNT_MANAGE = "Manage your account"
const val CLOUD_ACCOUNT_UNLINK = "Unlink this gateway"
const val CLOUD_ACCOUNT_UNLINKING = "Unlinking…"
const val CLOUD_ACCOUNT_UNLINK_TITLE = "Unlink this gateway from your Omnesis account?"
const val CLOUD_ACCOUNT_UNLINK_CONFIRM = "Unlink"

/** The confirmation before a gateway leaves its account. */
const val CLOUD_ACCOUNT_UNLINK_TEXT =
    "This gateway leaves your Omnesis account. It can no longer be reached from outside your home network, " +
        "and devices can no longer join by signing in. Devices already paired keep working on your home network."

/** The footnotes under the remote access controls. A phone has no hover, so they are always shown. */
const val CLOUD_ACCOUNT_TURN_OFF_FOOTNOTE =
    "Turning it off stops access from outside your home network. This gateway keeps its address and stays in your Omnesis account."
const val CLOUD_ACCOUNT_TURN_ON_FOOTNOTE =
    "Turn it on to reach this gateway from outside your home network again, at the same address."

/**
 * One line on why the address cannot be used right now, or null once it answers (the portal's
 * `addressState`). The gateway reports `publicMcp.lastError` only after its re-checks kept
 * failing, so until then an address that is not ready is still being checked.
 */
fun cloudAccountAddressState(status: CloudRelayStatus): String? = when {
    status.enabled != true -> "Not reachable while remote access is off."
    status.publicMcp?.ready == true -> null
    status.tunnel?.state != "online" -> "Not reachable while this gateway is disconnected from the relay."
    !status.publicMcp?.lastError.isNullOrEmpty() -> "This address does not answer right now."
    else -> "Checking that this address answers. This takes up to a minute after the gateway connects."
}

/** Every error code the gateway reports, with where it came from. */
private fun reported(status: CloudRelayStatus): List<Pair<String, String>> = listOf(
    "connect" to status.connect?.error,
    "registration" to status.enrollment?.error,
    "tunnel" to status.tunnel?.lastError,
    "certificate" to status.certificate?.lastError,
    "address" to status.publicMcp?.lastError,
    "certificate monitor" to status.certificateMonitor?.lastError,
    "service" to status.serviceError,
    "account" to status.account?.lastError,
    "google" to status.google?.lastError,
).mapNotNull { (source, code) -> code?.takeIf { it.isNotEmpty() }?.let { source to it } }

/**
 * The sentences of the problems box (the portal's `relayProblems`). A problem the headline
 * already states is not repeated, and one sentence is said once however many parts of the
 * status report it.
 */
fun cloudAccountProblems(status: CloudRelayStatus, phase: CloudAccountPhase, date: (Long) -> String): List<String> {
    val inHeadline = when (phase) {
        CloudAccountPhase.Failed -> setOf("connect", "registration")
        CloudAccountPhase.Disconnected -> setOf("tunnel")
        CloudAccountPhase.Unavailable -> setOf("service")
        else -> emptySet()
    }
    val messages = reported(status).filter { it.first !in inHeadline }.mapNotNull { cloudAccountErrorText(it.second) }.toMutableList()
    val certificate = status.certificate?.state
    if (status.enabled == true && certificate == "expired") {
        messages += "The certificate for this gateway's address has expired, so devices away from home cannot connect. " +
            "The gateway keeps trying to renew it."
    }
    if (status.enabled == true && certificate == "expiring") {
        val day = relayEpochMillis(status.certificate?.expiresAt)?.let(date) ?: "a date soon"
        messages += "The certificate for this gateway's address expires on $day. The gateway renews it by itself. " +
            "If this message stays for more than a day, ask for help."
    }
    if (!status.certificateMonitor?.incidents.isNullOrEmpty()) {
        messages += "A certificate for this gateway's address was issued with a key this gateway does not hold. " +
            "Someone else may be able to pose as this gateway. Copy the details and ask for help before you add new devices."
    }
    return messages.distinct()
}

fun cloudAccountProblemsTitle(count: Int): String =
    if (count > 1) "Some things need your attention" else "Something needs your attention"

const val CLOUD_ACCOUNT_PROBLEMS_HELP =
    "Need help? Copy the details and paste them to an assistant or a help forum. They contain no passwords or keys. " +
        "Running omnesis cloud status on this gateway prints the same details."

/** Whether the problems box is shown. A failed connect or a dropped connection is said in the headline; the details still help. */
fun cloudAccountTroubled(problems: List<String>, phase: CloudAccountPhase): Boolean =
    problems.isNotEmpty() || phase == CloudAccountPhase.Failed || phase == CloudAccountPhase.Disconnected

/** An instant with milliseconds, always: `2027-01-10T16:42:00.000Z`. */
private val isoMillis = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

private fun iso(millis: Long?): String = millis?.let { isoMillis.format(Instant.ofEpochMilli(it)) } ?: "not recorded"

private fun iso(value: JsonElement?): String = iso(relayEpochMillis(value))

private val unprintable = Regex("[^\\x20-\\x7e]+")

/** One printable line: status values are data from the gateway, never layout. */
private fun plain(value: String?, fallback: String = "unknown"): String =
    if (value.isNullOrEmpty()) fallback else value.replace(unprintable, " ").take(300)

private val phaseNames = mapOf(
    CloudAccountPhase.Unavailable to "unavailable",
    CloudAccountPhase.NotConnected to "not-connected",
    CloudAccountPhase.Waiting to "waiting",
    CloudAccountPhase.Registering to "registering",
    CloudAccountPhase.Linking to "linking",
    CloudAccountPhase.Failed to "failed",
    CloudAccountPhase.Off to "off",
    CloudAccountPhase.Connected to "connected",
    CloudAccountPhase.Reconnecting to "reconnecting",
    CloudAccountPhase.Disconnected to "disconnected",
)

/**
 * The plain-text block "Copy details" puts on the clipboard, for pasting to an assistant or a
 * forum. Line for line the iOS app's block (`CloudRelayPresentation.diagnostics`). It carries public facts only: addresses, states,
 * dates and error codes. No token, key or sign-in identifier is written here.
 */
fun cloudAccountDiagnostics(status: CloudRelayStatus, phase: CloudAccountPhase, nowMillis: Long): String {
    val codes = reported(status).map { (source, code) -> "${plain(code)} ($source)" }.toMutableList()
    if (status.certificate?.state == "expired") codes += "certificate-expired (certificate)"
    if (status.certificate?.state == "expiring") codes += "certificate-expiring (certificate)"
    val monitor = status.certificateMonitor
    val incidents = monitor?.incidents.orEmpty()
    if (incidents.isNotEmpty()) codes += "unexpected-certificate (certificate monitor)"
    val address = status.publicMcp
    val answering = when {
        address?.ready == true -> "answering"
        address?.lastError != null -> "not answering"
        else -> "not confirmed"
    }
    val linked = when {
        cloudAccountLinked(status) -> "connected"
        status.account?.pendingUnlink == true -> "disconnected here, account not updated yet"
        else -> "not connected"
    }
    val lines = buildList {
        add("Omnesis account details")
        add("Time: ${iso(nowMillis)}")
        add("Page state: ${phaseNames.getValue(phase)}")
        add("Error codes: ${codes.joinToString(", ").ifEmpty { "none" }}")
        add("Remote access: ${if (status.enabled == true) "on" else "off"}")
        add("Address: ${plain(cloudAccountHttpsUrl(address?.url), "none")} ($answering)")
        add("Registration: ${plain(status.enrollment?.state)}, gateway ID ${plain(status.gatewayId, "none")}")
        add("Tunnel: ${plain(status.tunnel?.state)}, last connected ${iso(status.tunnel?.lastConnectedAt)}")
        add(
            "Public certificate: ${plain(status.certificate?.state)}, expires ${iso(status.certificate?.expiresAt)}, " +
                "last renewed ${iso(status.certificate?.lastRenewedAt)}",
        )
        add("Certificate monitor: ${plain(monitor?.state, "not reported")}, last checked ${iso(monitor?.lastCompletedAt)}")
        for (incident in incidents) {
            add(
                "Unexpected certificate: name ${plain(incident.hostname)}, public key ${plain(incident.spkiFingerprint)}, " +
                    "certificate ${plain(incident.certificateFingerprint)}, issuer ${plain(incident.issuer)}, " +
                    "serial ${plain(incident.serial)}, valid ${iso(incident.validFrom)} to ${iso(incident.validTo)}, " +
                    "seen ${iso(incident.observedAt)}, log entry ${plain(incident.providerEntryId)}",
            )
        }
        add("Account: $linked")
        add("New devices: ${plain(status.deviceEnrollment?.policy, "not reported")}")
        add("Relay: ${plain(cloudAccountHttpsUrl(status.config?.relayUrl), "none")}")
    }
    return lines.joinToString("\n") + "\n"
}
