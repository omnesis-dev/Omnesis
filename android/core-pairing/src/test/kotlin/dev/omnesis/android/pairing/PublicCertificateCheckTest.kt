// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import org.junit.Assert.*
import org.junit.Test
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.Principal
import java.security.PublicKey
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Date
import javax.net.ssl.X509TrustManager

class PublicCertificateCheckTest {
    private val sctOid = "1.3.6.1.4.1.11129.2.4.2"
    private val ecKey = KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair().public

    private inner class Leaf(val sct: ByteArray? = byteArrayOf(4, 2, 0, 0), val names: List<String> = listOf("gateway.example.test")) : X509Certificate() {
        override fun getExtensionValue(oid: String?) = if (oid == sctOid) sct else null
        override fun getSubjectAlternativeNames(): Collection<List<*>> = names.map { listOf(2, it) }
        override fun getPublicKey(): PublicKey = ecKey
        override fun hasUnsupportedCriticalExtension() = false
        override fun getCriticalExtensionOIDs() = emptySet<String>()
        override fun getNonCriticalExtensionOIDs() = emptySet<String>()
        override fun checkValidity() {}
        override fun checkValidity(date: Date?) {}
        override fun getVersion() = 3
        override fun getSerialNumber(): BigInteger = BigInteger.ONE
        override fun getIssuerDN(): Principal = Principal { "CN=Fictional" }
        override fun getSubjectDN(): Principal = Principal { "CN=Fictional" }
        override fun getNotBefore() = Date(0)
        override fun getNotAfter() = Date(0)
        override fun getTBSCertificate() = ByteArray(0)
        override fun getSignature() = ByteArray(0)
        override fun getSigAlgName() = "SHA256withECDSA"
        override fun getSigAlgOID() = "1.2.840.10045.4.3.2"
        override fun getSigAlgParams() = null
        override fun getIssuerUniqueID() = null
        override fun getSubjectUniqueID() = null
        override fun getKeyUsage() = null
        override fun getBasicConstraints() = -1
        override fun getEncoded() = ByteArray(0)
        override fun verify(key: PublicKey?) {}
        override fun verify(key: PublicKey?, sigProvider: String?) {}
        override fun toString() = "Fictional leaf"
    }

    private class Trust(val trusted: Boolean) : X509TrustManager {
        var chainSize = 0
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            chainSize = chain!!.size
            assertEquals("ECDHE_ECDSA", authType)
            if (!trusted) throw CertificateException("not public")
        }
        override fun getAcceptedIssuers() = emptyArray<X509Certificate>()
    }

    @Test fun `a publicly trusted logged certificate for the hostname passes`() {
        val trust = Trust(true)
        assertTrue(PublicCertificateCheck(trust).accepts(listOf(Leaf()), "gateway.example.test"))
        assertEquals(1, trust.chainSize)
    }

    @Test fun `each missing property fails the check without throwing`() {
        assertFalse(PublicCertificateCheck(Trust(false)).accepts(listOf(Leaf()), "gateway.example.test"))
        assertFalse(PublicCertificateCheck(Trust(true)).accepts(listOf(Leaf(sct = null)), "gateway.example.test"))
        assertFalse(PublicCertificateCheck(Trust(true)).accepts(listOf(Leaf(sct = ByteArray(0))), "gateway.example.test"))
        assertFalse(PublicCertificateCheck(Trust(true)).accepts(listOf(Leaf()), "other.example.test"))
        assertFalse(PublicCertificateCheck(Trust(true)).accepts(emptyList(), "gateway.example.test"))
    }
}
