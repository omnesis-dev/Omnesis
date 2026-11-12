// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.dto.CloudRelayStatus
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.dto.relayEpochMillis
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Status bodies as the gateway's `CloudRelayManager.status()` writes them, one per state of
 * the screen. Every name, address and key is invented.
 */
internal object CloudAccountFixtures {
    const val RELAY = "https://relay.example.com"
    const val HOSTNAME = "g-7f3a91.relay.example.com"
    private const val MONITOR = """"certificateMonitor":{"enabled":false,"provider":"certspotter","state":"disabled","incidents":[]}"""
    private const val DIRECT = """{"id":"direct","names":["gateway.example.test"],"label":"Self-signed","kind":"self-signed","state":"valid","expiresAt":"2027-03-01T00:00:00.000Z","pinPolicy":"existing-device-policy"}"""

    /** A gateway that has never connected: no settings, so no identity, address or abilities. */
    fun fresh(
        serviceConfigured: Boolean = true,
        enrollment: String = """{"state":"unconfigured"}""",
        connect: String? = null,
    ): String = """{$MONITOR,"revision":1,"enabled":false,"configured":false,"serviceConfigured":$serviceConfigured,
        ${if (serviceConfigured) "" else """"serviceError":"relay-service-unavailable","""}
        "identities":[$DIRECT,{"id":"cloud","names":[],"kind":"unconfigured","state":"unconfigured","pinPolicy":"strict-key-pin-or-public-pki"}],
        "directCertificate":{"state":"valid","expiresAt":"2027-03-01T00:00:00.000Z"},
        "config":{"relayUrl":"$RELAY","acmeDirectoryUrl":"https://acme.example.org/directory","acmeTermsUrl":"https://acme.example.org/terms","termsAccepted":false,"invitationRequired":true},
        "enrollment":$enrollment,"tunnel":{"state":"disabled"},"certificate":{"state":"unconfigured"},
        "publicMcp":{"ready":false},"google":{"configured":false,"linked":false,"canLink":false,"canUnlink":false},
        "account":{"activated":false,"configured":true,"linked":false,"canLink":false,"canUnlink":false,"pendingUnlink":false},
        ${connect?.let { """"connect":$it,""" } ?: ""}
        "deviceEnrollment":{"policy":"automatic","trustedSignIns":[]},
        "can":{"configure":$serviceConfigured,"enable":false,"disable":false,"reconnect":false,"renew":false}}"""

    /** A gateway with an address. [tunnel] and [enabled] decide which of the settled states it is in. */
    fun settled(
        tunnel: String = """{"state":"online","lastConnectedAt":"2026-11-10T08:15:00.000Z"}""",
        enabled: Boolean = true,
        enrolled: Boolean = true,
        linked: Boolean = true,
        connect: String? = null,
        deviceEnrollment: String = """{"policy":"automatic","trustedSignIns":[]}""",
        publicMcp: String = """{"ready":${enabled && enrolled},"url":"https://$HOSTNAME/mcp"}""",
        certificate: String = """{"state":"valid","expiresAt":"2027-02-08T10:00:00.000Z","lastRenewedAt":"2026-11-10T08:14:00.000Z"}""",
    ): String = """{$MONITOR,"recovery":{"receipt":"present","expiresAt":"2027-11-10T00:00:00.000Z"},"revision":7,
        "enabled":$enabled,"configured":true,"serviceConfigured":true,"gatewayId":"gw_7f3a91c2","hostname":"$HOSTNAME",
        "publicOrigin":"https://$HOSTNAME",
        "identities":[$DIRECT,{"id":"cloud","names":["$HOSTNAME"],"kind":"public-ca","state":"valid","expiresAt":"2027-02-08T10:00:00.000Z","pinPolicy":"strict-key-pin-or-public-pki"}],
        "directCertificate":{"state":"valid","expiresAt":"2027-03-01T00:00:00.000Z"},
        "config":{"relayUrl":"$RELAY","publicOrigin":"https://$HOSTNAME","acmeDirectoryUrl":"https://acme.example.org/directory","termsAccepted":true,"invitationRequired":false},
        "enrollment":{"state":"${if (enrolled) "enrolled" else "pending"}"},"tunnel":$tunnel,"certificate":$certificate,
        "publicMcp":$publicMcp,
        "google":{"configured":false,"linked":false,"canLink":false,"canUnlink":false},
        "account":{"activated":true,"configured":true,"linked":$linked,"canLink":${!linked && enabled},"canUnlink":$linked,"pendingUnlink":false},
        ${connect?.let { """"connect":$it,""" } ?: ""}
        "deviceEnrollment":$deviceEnrollment,
        "can":{"configure":${!enabled},"enable":${!enabled},"disable":$enabled,"reconnect":$enabled,"renew":$enabled}}"""

    const val WAITING_CONNECT =
        """{"state":"waiting","authorizeUrl":"https://relay.example.com/_relay/v3/signup/begin?request=req-1","connectUrl":"https://relay.example.com/_relay/connect","connectShortUrl":"https://example.org/connect","code":"KXTP-4M9Q","expiresAt":1794300000}"""

    /** The gateway still lists its trusted sign-ins; the app reads the policy only. */
    val ASK =
        """{"policy":"ask","trustedSignIns":[{"type":"google","id":"${"b2".repeat(32)}","addedAt":1794240000,"source":"link-page"}]}"""

    val notConnected = fresh()
    val unavailable = fresh(serviceConfigured = false)
    val waiting = fresh(connect = WAITING_CONNECT)
    val registering = settled(tunnel = """{"state":"connecting"}""", enrolled = false, linked = false, connect = """{"state":"registering"}""")
    val linking = settled(linked = false, connect = """{"state":"linking"}""")
    val connectFailed = fresh(connect = """{"state":"failed","error":"expired"}""")
    val enrollmentFailed = fresh(enrollment = """{"state":"failed","error":"invitation-required"}""")
    val connected = settled(connect = """{"state":"done"}""", deviceEnrollment = ASK)
    val reconnecting = settled(tunnel = """{"state":"connecting","lastConnectedAt":"2026-11-10T08:15:00.000Z"}""")
    val disconnected = settled(tunnel = """{"state":"offline","lastConnectedAt":"2026-11-10T08:15:00.000Z","lastError":"relay-unreachable"}""")
    val off = settled(tunnel = """{"state":"disabled"}""", enabled = false)

    fun decode(body: String): CloudRelayStatus = OmnesisJson.decodeFromString(body)
}

class CloudAccountSettingsTest {
    private fun status(body: String) = CloudAccountFixtures.decode(body)
    private val day = { millis: Long -> "day-$millis" }

    @Test fun `each state the gateway reports decodes and lands on its phase`() {
        val expected = listOf(
            CloudAccountFixtures.notConnected to CloudAccountPhase.NotConnected,
            CloudAccountFixtures.unavailable to CloudAccountPhase.Unavailable,
            CloudAccountFixtures.waiting to CloudAccountPhase.Waiting,
            CloudAccountFixtures.registering to CloudAccountPhase.Registering,
            CloudAccountFixtures.linking to CloudAccountPhase.Linking,
            CloudAccountFixtures.connectFailed to CloudAccountPhase.Failed,
            CloudAccountFixtures.enrollmentFailed to CloudAccountPhase.Failed,
            CloudAccountFixtures.connected to CloudAccountPhase.Connected,
            CloudAccountFixtures.reconnecting to CloudAccountPhase.Reconnecting,
            CloudAccountFixtures.disconnected to CloudAccountPhase.Disconnected,
            CloudAccountFixtures.off to CloudAccountPhase.Off,
        )
        for ((body, phase) in expected) assertEquals(body, phase, cloudAccountPhase(status(body)))
        assertEquals(CloudAccountPhase.entries.toSet(), expected.map { it.second }.toSet())
    }

    @Test fun `the connected status carries what the screen shows`() {
        val connected = status(CloudAccountFixtures.connected)
        assertEquals(CloudAccountFixtures.HOSTNAME, connected.hostname)
        assertEquals("https://${CloudAccountFixtures.HOSTNAME}/mcp", connected.publicMcp?.url)
        assertEquals(true, connected.publicMcp?.ready)
        assertEquals(true, connected.account?.linked)
        assertEquals(true, connected.can?.disable)
        assertEquals("ask", connected.deviceEnrollment?.policy)
        // An address that answers needs no line under it.
        assertNull(cloudAccountAddressState(connected))
        assertEquals(emptyList<String>(), cloudAccountProblems(connected, CloudAccountPhase.Connected, day))
        assertEquals("https://relay.example.com/_relay/account", cloudAccountPageUrl(connected.config?.relayUrl))
        assertTrue(cloudAccountShown(connected) && cloudAccountUsesAccount(connected))
    }

    /** `relayPhase` in the portal, input by input: an active connect first, then a failure, then the connection. */
    @Test fun `the phase follows the portal's order of checks`() {
        fun phase(
            connect: String? = null,
            enrollment: String? = null,
            enabled: Boolean? = null,
            serviceConfigured: Boolean? = null,
            tunnel: String? = null,
        ): CloudAccountPhase {
            val fields = listOfNotNull(
                connect?.let { """"connect":{"state":"$it"}""" },
                enrollment?.let { """"enrollment":{"state":"$it"}""" },
                enabled?.let { """"enabled":$it""" },
                serviceConfigured?.let { """"serviceConfigured":$it""" },
                tunnel?.let { """"tunnel":{"state":"$it"}""" },
            )
            return cloudAccountPhase(status("{${fields.joinToString(",")}}"))
        }
        // An active connect outranks an established connection.
        val active = listOf(
            "waiting" to CloudAccountPhase.Waiting,
            "registering" to CloudAccountPhase.Registering,
            "linking" to CloudAccountPhase.Linking,
            "failed" to CloudAccountPhase.Failed,
        )
        for ((state, expected) in active) {
            assertEquals(expected, phase(connect = state, enrollment = "enrolled", enabled = true, serviceConfigured = true, tunnel = "online"))
        }
        // A finished, idle or unknown connect state decides nothing.
        for (state in listOf("done", "idle", "a-state-from-the-future")) {
            assertEquals(CloudAccountPhase.Connected, phase(connect = state, enrollment = "enrolled", enabled = true, tunnel = "online"))
        }
        assertEquals(CloudAccountPhase.Unavailable, phase())
        assertEquals(CloudAccountPhase.Unavailable, phase(serviceConfigured = false, enrollment = "failed"))
        assertEquals(CloudAccountPhase.Failed, phase(serviceConfigured = true, enrollment = "failed"))
        assertEquals(CloudAccountPhase.NotConnected, phase(serviceConfigured = true))
        assertEquals(CloudAccountPhase.NotConnected, phase(serviceConfigured = true, enrollment = "pending"))
        assertEquals(CloudAccountPhase.Off, phase(enrollment = "enrolled", enabled = false))
        assertEquals(CloudAccountPhase.Off, phase(enrollment = "enrolled"))
        assertEquals(CloudAccountPhase.Registering, phase(enabled = true))
        assertEquals(CloudAccountPhase.Registering, phase(enabled = true, enrollment = "failed", tunnel = "online"))
        assertEquals(CloudAccountPhase.Connected, phase(enabled = true, enrollment = "enrolled", tunnel = "online"))
        assertEquals(CloudAccountPhase.Disconnected, phase(enabled = true, enrollment = "enrolled", tunnel = "offline"))
        assertEquals(CloudAccountPhase.Reconnecting, phase(enabled = true, enrollment = "enrolled", tunnel = "connecting"))
        assertEquals(CloudAccountPhase.Reconnecting, phase(enabled = true, enrollment = "enrolled"))
        assertEquals(CloudAccountPhase.Reconnecting, phase(enabled = true, enrollment = "enrolled", tunnel = "a-state-from-the-future"))
    }

    @Test fun `unknown fields, states and nulls never break decoding`() {
        val odd = status(
            """{"enabled":null,"futureField":{"a":[1,2]},"config":null,"enrollment":{"state":"paused","error":"brand-new-code","more":1},
            "tunnel":{"state":"warp"},"certificate":{"state":"valid","expiresAt":1802080800},"connect":{"state":"waiting","expiresAt":"soon","code":"lowercase"},
            "deviceEnrollment":{"policy":"vote","trustedSignIns":[{"type":"hardware-key","id":"k","source":"carrier-pigeon"},{"type":"passkey","id":"p","addedAt":1794240000}]},
            "identities":[{"id":"mesh"}],"certificateMonitor":{"state":"incident","incidents":[{"hostname":"gateway.example.org","extra":true}]},"can":{}}""",
        )
        assertEquals(CloudAccountPhase.Waiting, cloudAccountPhase(odd))
        assertNull(cloudAccountElsewhere(odd))
        assertEquals("An operation failed. Check settings and retry.", cloudAccountErrorText(odd.enrollment?.error))
        assertEquals("vote", odd.deviceEnrollment?.policy)
        assertTrue(cloudAccountProblems(odd, CloudAccountPhase.Waiting, day).any { "a key this gateway does not hold" in it })
        assertTrue("Tunnel: warp, last connected not recorded" in cloudAccountDiagnostics(odd, CloudAccountPhase.Waiting, 0))
        assertEquals(CloudAccountPhase.Unavailable, cloudAccountPhase(status("{}")))
    }

    @Test fun `moments decode from ISO strings, seconds and milliseconds`() {
        assertEquals(1_802_080_800_000, relayEpochMillis(JsonPrimitive("2027-02-08T10:00:00.000Z")))
        assertEquals(1_802_080_800_000, relayEpochMillis(JsonPrimitive(1_802_080_800)))
        assertEquals(1_802_080_800_000, relayEpochMillis(JsonPrimitive(1_802_080_800_000)))
        assertNull(relayEpochMillis(JsonPrimitive("tomorrow")))
        assertNull(relayEpochMillis(JsonNull))
        assertNull(relayEpochMillis(null))
    }

    @Test fun `the poll follows a connect closely and idles otherwise`() {
        assertEquals(2_000L, cloudAccountPollMillis(status(CloudAccountFixtures.waiting)))
        assertEquals(2_000L, cloudAccountPollMillis(status(CloudAccountFixtures.registering)))
        assertEquals(2_000L, cloudAccountPollMillis(status(CloudAccountFixtures.linking)))
        assertEquals(5_000L, cloudAccountPollMillis(status(CloudAccountFixtures.connected)))
        assertEquals(5_000L, cloudAccountPollMillis(status(CloudAccountFixtures.connectFailed)))
        assertEquals(5_000L, cloudAccountPollMillis(null))
    }

    @Test fun `the waiting state offers the short address, the code and its expiry`() {
        val elsewhere = cloudAccountElsewhere(status(CloudAccountFixtures.waiting))!!
        assertEquals("https://relay.example.com/_relay/connect", elsewhere.url)
        assertEquals("example.org/connect", elsewhere.shownAddress)
        assertEquals("KXTP-4M9Q", elsewhere.code)
        assertEquals(1_794_300_000_000, elsewhere.expiresAtMillis)
        val plain = status(CloudAccountFixtures.fresh(connect = """{"state":"waiting","connectUrl":"https://relay.example.com/","code":"ABCD"}"""))
        assertEquals("relay.example.com", cloudAccountElsewhere(plain)!!.shownAddress)
        val unsafe = status(CloudAccountFixtures.fresh(connect = """{"state":"waiting","connectUrl":"http://relay.example.com/connect","code":"ABCD"}"""))
        assertNull(cloudAccountElsewhere(unsafe))
    }

    @Test fun `only HTTPS addresses without credentials are opened`() {
        assertEquals("https://relay.example.com/x?y=1", cloudAccountHttpsUrl("https://relay.example.com/x?y=1"))
        val refused = listOf(
            null, "", "http://relay.example.com", "https://user:secret@relay.example.com", "javascript:alert(1)",
            "intent://relay.example.com", "https://", "not a url", "https://relay.example.com/" + "a".repeat(2048),
        )
        for (address in refused) assertNull(address, cloudAccountHttpsUrl(address))
        assertNull(cloudAccountPageUrl("http://relay.example.com"))
        assertEquals("https://relay.example.com:8443/_relay/account", cloudAccountPageUrl("https://relay.example.com:8443/base?x=1"))
    }

    @Test fun `error codes read as the portal words them`() {
        assertEquals(
            "Omnesis Relay could not be reached. Check this gateway's internet connection. It keeps trying by itself.",
            cloudAccountErrorText("relay-unreachable"),
        )
        assertEquals(
            "Omnesis account sign-in is unavailable. Direct connections and QR pairing remain available.",
            cloudAccountErrorText("account-unavailable"),
        )
        assertEquals("An operation failed. Check settings and retry.", cloudAccountErrorText("capacity"))
        assertNull(cloudAccountErrorText(null))
        assertNull(cloudAccountErrorText(""))
        assertTrue(cloudAccountNeedsPortal("invitation-required"))
        assertTrue(cloudAccountNeedsPortal("hostname-required"))
        assertFalse(cloudAccountNeedsPortal("relay-unreachable"))
        assertFalse(cloudAccountNeedsPortal("enrollment-refused"))
        assertFalse(cloudAccountNeedsPortal(null))
        // A failure only the portal's manual setup form can fix says where to go, in the same sentence.
        assertEquals(
            "This relay requires an invitation for this gateway ID. Open the portal on your gateway to finish this.",
            cloudAccountErrorText("invitation-required"),
        )
    }

    @Test fun `problems leave out what the headline already says and never repeat`() {
        val unreachable = "Omnesis Relay could not be reached. Check this gateway's internet connection. It keeps trying by itself."
        val disconnected = status(CloudAccountFixtures.disconnected)
        assertEquals(emptyList<String>(), cloudAccountProblems(disconnected, CloudAccountPhase.Disconnected, day))
        // The headline says it, and the details are still offered.
        assertTrue(cloudAccountTroubled(emptyList(), CloudAccountPhase.Disconnected))
        assertTrue(cloudAccountTroubled(emptyList(), CloudAccountPhase.Failed))
        assertFalse(cloudAccountTroubled(emptyList(), CloudAccountPhase.Connected))
        assertFalse(cloudAccountTroubled(emptyList(), CloudAccountPhase.Off))
        assertEquals(listOf(unreachable), cloudAccountProblems(disconnected, CloudAccountPhase.Reconnecting, day))
        val doubled = status(
            """{"enabled":true,"tunnel":{"lastError":"relay-unreachable"},"enrollment":{"error":"relay-unreachable"},
            "certificate":{"state":"expiring","expiresAt":"2027-02-08T10:00:00.000Z","lastError":"certificate-renewal-failed"},
            "account":{"lastError":"account-link-failed"}}""",
        )
        assertEquals(
            listOf(
                unreachable,
                "The certificate for this gateway's address could not be renewed. The gateway tries again by itself.",
                "Couldn't connect this gateway to your Omnesis account. Try again. Existing device access is unchanged.",
                "The certificate for this gateway's address expires on day-1802080800000. The gateway renews it by itself. If this message stays for more than a day, ask for help.",
            ),
            cloudAccountProblems(doubled, CloudAccountPhase.Connected, day),
        )
        // A certificate that lapsed while remote access is off stops nothing.
        assertEquals(emptyList<String>(), cloudAccountProblems(status("""{"certificate":{"state":"expired"}}"""), CloudAccountPhase.Off, day))
        assertEquals(
            listOf("The certificate for this gateway's address has expired, so devices away from home cannot connect. The gateway keeps trying to renew it."),
            cloudAccountProblems(status("""{"enabled":true,"certificate":{"state":"expired"}}"""), CloudAccountPhase.Connected, day),
        )
        assertEquals(emptyList<String>(), cloudAccountProblems(status(CloudAccountFixtures.unavailable), CloudAccountPhase.Unavailable, day))
        assertEquals(emptyList<String>(), cloudAccountProblems(status(CloudAccountFixtures.enrollmentFailed), CloudAccountPhase.Failed, day))
    }

    @Test fun `the address line says checking until the gateway reports that the address does not answer`() {
        fun line(body: String) = cloudAccountAddressState(status(body))
        val checking = "Checking that this address answers. This takes up to a minute after the gateway connects."
        val pending = CloudAccountFixtures.settled(publicMcp = """{"ready":false,"url":"https://g-7f3a91.relay.example.com/mcp"}""")
        assertEquals(checking, line(pending))
        // Nothing is wrong yet, so nothing is reported as a problem either.
        assertEquals(emptyList<String>(), cloudAccountProblems(status(pending), CloudAccountPhase.Connected, day))
        val failing = CloudAccountFixtures.settled(publicMcp = """{"ready":false,"url":"https://g-7f3a91.relay.example.com/mcp","lastError":"public-endpoint-unreachable"}""")
        assertEquals("This address does not answer right now.", line(failing))
        assertEquals(
            listOf("This gateway's address does not answer from outside your home network. Check that this gateway is online. It checks again by itself."),
            cloudAccountProblems(status(failing), CloudAccountPhase.Connected, day),
        )
        assertNull(line(CloudAccountFixtures.connected))
        assertEquals("Not reachable while this gateway is disconnected from the relay.", line(CloudAccountFixtures.disconnected.replace(""""ready":true""", """"ready":false""")))
        assertEquals("Not reachable while this gateway is disconnected from the relay.", line(CloudAccountFixtures.reconnecting.replace(""""ready":true""", """"ready":false""")))
        assertEquals("Not reachable while remote access is off.", line(CloudAccountFixtures.off))
    }

    @Test fun `the footnotes under the remote access controls say what each control does`() {
        assertEquals(
            "Turning it off stops access from outside your home network. This gateway keeps its address and stays in your Omnesis account.",
            CLOUD_ACCOUNT_TURN_OFF_FOOTNOTE,
        )
        assertEquals(
            "Turn it on to reach this gateway from outside your home network again, at the same address.",
            CLOUD_ACCOUNT_TURN_ON_FOOTNOTE,
        )
    }

    @Test fun `the account section says linked, and unlinking is worded the same everywhere`() {
        val linked = status(CloudAccountFixtures.connected)
        assertTrue(cloudAccountLinked(linked))
        assertEquals("This gateway is linked to your Omnesis account.", cloudAccountLine(linked))
        assertEquals(emptyList<String>(), cloudAccountHints(linked))
        val unlinked = status("""{"account":{"activated":true,"configured":true,"linked":false,"canLink":true}}""")
        assertEquals("This gateway is not linked to an Omnesis account.", cloudAccountLine(unlinked))
        assertEquals(
            listOf(
                "Connect it to find this gateway when you sign in on a new device. QR pairing works without an account.",
                "Open the portal on your gateway to finish this.",
            ),
            cloudAccountHints(unlinked),
        )
        assertEquals(
            listOf("Disconnected here. Your Omnesis account updates when the connection returns."),
            cloudAccountHints(status("""{"account":{"activated":true,"pendingUnlink":true}}""")),
        )
        assertEquals("Unlink this gateway", CLOUD_ACCOUNT_UNLINK)
        assertEquals("Unlink this gateway from your Omnesis account?", CLOUD_ACCOUNT_UNLINK_TITLE)
        assertEquals("Unlink", CLOUD_ACCOUNT_UNLINK_CONFIRM)
        assertEquals("Unlinking…", CLOUD_ACCOUNT_UNLINKING)
        assertEquals(
            "This gateway leaves your Omnesis account. It can no longer be reached from outside your home network, " +
                "and devices can no longer join by signing in. Devices already paired keep working on your home network.",
            CLOUD_ACCOUNT_UNLINK_TEXT,
        )
        assertEquals(
            "Need help? Copy the details and paste them to an assistant or a help forum. They contain no passwords or keys. " +
                "Running omnesis cloud status on this gateway prints the same details.",
            CLOUD_ACCOUNT_PROBLEMS_HELP,
        )
    }

    @Test fun `the details to copy carry codes, states and dates, and nothing that signs anyone in`() {
        val troubled = status(
            CloudAccountFixtures.settled(
                tunnel = """{"state":"offline","lastConnectedAt":"2026-11-10T08:15:00.000Z","lastError":"relay-unreachable"}""",
                certificate = """{"state":"expiring","expiresAt":"2027-02-08T10:00:00.000Z","lastRenewedAt":"2026-11-10T08:14:00.000Z","lastError":"certificate-renewal-failed"}""",
                publicMcp = """{"ready":false,"url":"https://g-7f3a91.relay.example.com/mcp","lastError":"public-endpoint-unreachable"}""",
                deviceEnrollment = CloudAccountFixtures.ASK,
            ),
        )
        assertEquals(
            """
            Omnesis account details
            Time: 2026-11-11T09:00:00.000Z
            Page state: disconnected
            Error codes: relay-unreachable (tunnel), certificate-renewal-failed (certificate), public-endpoint-unreachable (address), certificate-expiring (certificate)
            Remote access: on
            Address: https://g-7f3a91.relay.example.com/mcp (not answering)
            Registration: enrolled, gateway ID gw_7f3a91c2
            Tunnel: offline, last connected 2026-11-10T08:15:00.000Z
            Public certificate: expiring, expires 2027-02-08T10:00:00.000Z, last renewed 2026-11-10T08:14:00.000Z
            Certificate monitor: disabled, last checked not recorded
            Account: connected
            New devices: ask
            Relay: https://relay.example.com
            """.trimIndent() + "\n",
            cloudAccountDiagnostics(troubled, CloudAccountPhase.Disconnected, 1_794_387_600_000),
        )
        // The trusted sign-in's identifier is in the status the gateway sent, and never in the block.
        assertFalse("b2b2" in cloudAccountDiagnostics(troubled, CloudAccountPhase.Disconnected, 0))
        val incident = status(
            """{"certificateMonitor":{"state":"incident","incidents":[{"hostname":"gateway.example.org","issuer":"Example\nCA","serial":"0a"}]}}""",
        )
        val block = cloudAccountDiagnostics(incident, CloudAccountPhase.Unavailable, 0)
        assertTrue("Error codes: unexpected-certificate (certificate monitor)" in block)
        // A value from the gateway never starts a line of its own.
        assertTrue("Unexpected certificate: name gateway.example.org, public key unknown, certificate unknown, issuer Example CA, serial 0a," in block)
        assertTrue("Address: none (not confirmed)" in block)
    }
}
