// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.tls

import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.atomic.AtomicInteger

class LeafCertPinnerTest {

    @Test
    fun sha256Hex_matchesKnownVector() {
        // SHA-256 of the empty byte string.
        assertEquals(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            LeafCertPinner.sha256Hex(ByteArray(0)),
        )
    }

    @Test
    fun sha256Hex_isLowercaseHexNoSeparators() {
        val hex = LeafCertPinner.sha256Hex("omnesis".toByteArray())
        assertEquals(64, hex.length)
        assertTrue(hex.all { it in '0'..'9' || it in 'a'..'f' })
    }

    @Test
    fun isValidFingerprint_acceptsAndRejects() {
        assertTrue(LeafCertPinner.isValidFingerprint("a".repeat(64)))
        assertTrue(LeafCertPinner.isValidFingerprint("A".repeat(64)))
        assertFalse(LeafCertPinner.isValidFingerprint("a".repeat(63)))
        assertFalse(LeafCertPinner.isValidFingerprint("a".repeat(65)))
        assertFalse(LeafCertPinner.isValidFingerprint("g".repeat(64)))
        assertFalse(LeafCertPinner.isValidFingerprint(null))
        assertFalse(LeafCertPinner.isValidFingerprint(""))
    }

    // A private root stands in for the platform root store, so these cases decide
    // trust exactly as a device whose system trusts that root would.
    private val root = HeldCertificate.Builder().certificateAuthority(0).commonName("Example Root").build()
    private val systemTrust = HandshakeCertificates.Builder()
        .addTrustedCertificate(root.certificate)
        .build()
        .trustManager

    private fun leaf(name: String, issuer: HeldCertificate? = root): HeldCertificate =
        HeldCertificate.Builder()
            .addSubjectAlternativeName(name)
            .apply { if (issuer != null) signedBy(issuer) }
            .build()

    private fun pinner(pinned: HeldCertificate, host: String?, upgrades: AtomicInteger) = LeafCertPinner(
        LeafCertPinner.sha256Hex(pinned.certificate.encoded),
        host = host,
        onSystemTrustVerified = { upgrades.incrementAndGet() },
        systemTrust = systemTrust,
    )

    private fun LeafCertPinner.check(served: HeldCertificate) =
        trustManager.checkServerTrusted(arrayOf<X509Certificate>(served.certificate), "UNKNOWN")

    @Test
    fun pinnedChainAlsoTrustedForTheDnsHostReportsTheUpgradeOnce() {
        val current = leaf("gateway.example.com")
        val upgrades = AtomicInteger()
        val pinner = pinner(current, "gateway.example.com", upgrades)

        pinner.check(current)
        pinner.check(current)

        assertEquals(1, upgrades.get())
    }

    @Test
    fun pinnedChainOnAnIpHostIsAcceptedWithoutAnUpgrade() {
        val current = leaf("192.0.2.10")
        val upgrades = AtomicInteger()

        pinner(current, "192.0.2.10", upgrades).check(current)

        assertEquals(0, upgrades.get())
    }

    @Test
    fun pinnedSelfSignedChainIsAcceptedWithoutAnUpgrade() {
        val selfSigned = leaf("gateway.example.com", issuer = null)
        val upgrades = AtomicInteger()

        pinner(selfSigned, "gateway.example.com", upgrades).check(selfSigned)

        assertEquals(0, upgrades.get())
    }

    @Test
    fun rotatedLeafPubliclyTrustedForTheHostIsAcceptedAndReportsTheUpgrade() {
        val upgrades = AtomicInteger()
        val pinner = pinner(leaf("gateway.example.com"), "gateway.example.com", upgrades)

        pinner.check(leaf("gateway.example.com"))

        assertEquals(1, upgrades.get())
    }

    @Test
    fun rotatedLeafTrustedOnlyForAnotherNameIsRejected() {
        val upgrades = AtomicInteger()
        val pinner = pinner(leaf("gateway.example.com"), "gateway.example.com", upgrades)

        val error = assertThrows(CertificateException::class.java) {
            pinner.check(leaf("other.example.com"))
        }

        assertTrue(error.message!!.contains("no public trust for gateway.example.com"))
        assertEquals(0, upgrades.get())
    }

    @Test
    fun rotatedLeafFromAnUnknownRootIsRejected() {
        val otherRoot = HeldCertificate.Builder().certificateAuthority(0).commonName("Other Root").build()
        val upgrades = AtomicInteger()
        val pinner = pinner(leaf("gateway.example.com"), "gateway.example.com", upgrades)

        assertThrows(CertificateException::class.java) {
            pinner.check(leaf("gateway.example.com", issuer = otherRoot))
        }
        assertEquals(0, upgrades.get())
    }

    @Test
    fun rotatedLeafOnAnIpHostIsRejectedEvenWhenItsChainIsTrusted() {
        val upgrades = AtomicInteger()
        val pinner = pinner(leaf("192.0.2.10"), "192.0.2.10", upgrades)

        val error = assertThrows(CertificateException::class.java) {
            pinner.check(leaf("192.0.2.10"))
        }

        assertTrue(error.message!!.contains("fingerprint mismatch"))
        assertEquals(0, upgrades.get())
    }
}
