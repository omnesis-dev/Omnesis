// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import Security
import XCTest

final class GoogleIdentityTests: XCTestCase {
    private struct Vectors: Decodable {
        let clock: Double
        let clientIds: [String]
        let gatewayClientIds: [String]
        let subject: String
        let clientNonce: String
        let fingerprint: String
        let gateway: GoogleGatewayBinding
        let tokens: [String: String]
        let accountId: String
        let verificationCode: String
        let request: Request
        let nonceVectors: [NonceVector]
    }

    private struct Request: Decodable {
        let requestId: String
        let name: String
        let secret: String
    }

    private struct NonceVector: Decodable {
        let kind: String
        let name: String
        let nonce: String
    }

    private func fixtures() throws -> (Vectors, Data) {
        #if SWIFT_PACKAGE
        let bundle = Bundle.module
        #else
        let bundle = Bundle(for: Self.self)
        #endif
        let url = try XCTUnwrap(bundle.url(forResource: "cloud-identity-vectors", withExtension: "json", subdirectory: "Fixtures") ??
            bundle.url(forResource: "cloud-identity-vectors", withExtension: "json"))
        let data = try Data(contentsOf: url)
        let vectors = try JSONDecoder().decode(Vectors.self, from: data)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let jwks = try JSONSerialization.data(withJSONObject: XCTUnwrap(root["jwks"]))
        return (vectors, jwks)
    }

    func testVerifiesGoogleSignatureAndSeparatesGatewayAttestationsFromWebLogin() throws {
        let (vectors, keys) = try fixtures()
        let client = try GoogleIdentityVerifier(jwks: keys, clientIds: vectors.clientIds)
        let owner = try client.verify(XCTUnwrap(vectors.tokens["validClient"]), nonce: vectors.clientNonce, now: vectors.clock)
        XCTAssertEqual(owner.subject, vectors.subject)
        XCTAssertEqual(owner.accountId, vectors.accountId)
        let challenge = try CloudPairingChallenge(
            name: vectors.request.name,
            requestId: vectors.request.requestId,
            secret: vectors.request.secret
        )
        XCTAssertEqual(try challenge.nonce, vectors.clientNonce)
        XCTAssertEqual(try challenge.verificationCode(fingerprint: vectors.fingerprint), vectors.verificationCode)
        for vector in vectors.nonceVectors where vector.kind == "ios" {
            XCTAssertEqual(
                try CloudPairingChallenge(name: vector.name, requestId: vectors.request.requestId, secret: vectors.request.secret).nonce,
                vector.nonce,
                vector.name
            )
        }
        let gateway = try GoogleIdentityVerifier(jwks: keys, clientIds: vectors.gatewayClientIds)
        XCTAssertEqual(try vectors.gateway.verifiedFingerprint(owner: owner, verifier: gateway, now: vectors.clock), vectors.fingerprint)
        XCTAssertThrowsError(try vectors.gateway.verifiedFingerprint(owner: owner, verifier: client, now: vectors.clock))
        XCTAssertThrowsError(try gateway.verify(XCTUnwrap(vectors.tokens["validClient"]), nonce: vectors.clientNonce, now: vectors.clock))
        _ = try client.verify(XCTUnwrap(vectors.tokens["multipleAudiences"]), nonce: vectors.clientNonce, now: vectors.clock)
    }

    func testRefusesExpiredReplayWrongAudienceSubjectAndNonce() throws {
        let (vectors, keys) = try fixtures()
        let verifier = try GoogleIdentityVerifier(jwks: keys, clientIds: vectors.clientIds)
        for name in [
            "wrongIssuer",
            "wrongAudience",
            "wrongNonce",
            "expired",
            "futureIssued",
            "oldIssued",
            "missingSubject",
            "missingNonce",
            "unauthorizedParty",
        ] {
            XCTAssertThrowsError(try verifier.verify(XCTUnwrap(vectors.tokens[name]), nonce: vectors.clientNonce, now: vectors.clock), name)
        }
        let owner = try verifier.verify(XCTUnwrap(vectors.tokens["validClient"]), nonce: vectors.clientNonce, now: vectors.clock)
        let gateway = try GoogleIdentityVerifier(jwks: keys, clientIds: vectors.gatewayClientIds)
        let wrong = try GoogleGatewayBinding(
            gatewayId: vectors.gateway.gatewayId,
            publicOrigin: vectors.gateway.publicOrigin,
            certificate: vectors.gateway.certificate,
            identityToken: XCTUnwrap(vectors.tokens["wrongGatewayOwner"])
        )
        XCTAssertThrowsError(try wrong.verifiedFingerprint(owner: owner, verifier: gateway, now: vectors.clock))
    }

    func testCertificateAndRouteSubstitutionCannotReuseTheSignedBinding() throws {
        let (vectors, keys) = try fixtures()
        let owner = try GoogleIdentityVerifier(jwks: keys, clientIds: vectors.clientIds)
            .verify(XCTUnwrap(vectors.tokens["validClient"]), nonce: vectors.clientNonce, now: vectors.clock)
        let verifier = try GoogleIdentityVerifier(jwks: keys, clientIds: vectors.gatewayClientIds)
        for origin in [
            vectors.gateway.publicOrigin + ":8443",
            "http://gateway.example.test",
            "https://user@gateway.example.test",
            "https://gateway.example.test/path",
            "https://gateway.example.test?query",
            "https://gateway.example.test#fragment",
            "https://bad_.example.test",
            "https://localhost",
            "https://a..example.test",
            "invalid",
        ] {
            let candidate = GoogleGatewayBinding(
                gatewayId: vectors.gateway.gatewayId,
                publicOrigin: origin,
                certificate: vectors.gateway.certificate,
                identityToken: vectors.gateway.identityToken
            )
            XCTAssertThrowsError(try candidate.verifiedFingerprint(owner: owner, verifier: verifier, now: vectors.clock), origin)
        }
        for certificate in ["invalid", "-----BEGIN CERTIFICATE-----invalid-----END CERTIFICATE-----", String(
            repeating: "x",
            count: 17000
        )] {
            let candidate = GoogleGatewayBinding(
                gatewayId: vectors.gateway.gatewayId,
                publicOrigin: vectors.gateway.publicOrigin,
                certificate: certificate,
                identityToken: vectors.gateway.identityToken
            )
            XCTAssertThrowsError(try candidate.verifiedFingerprint(owner: owner, verifier: verifier, now: vectors.clock))
        }
        let changedId = GoogleGatewayBinding(
            gatewayId: UUID().uuidString,
            publicOrigin: vectors.gateway.publicOrigin,
            certificate: vectors.gateway.certificate,
            identityToken: vectors.gateway.identityToken
        )
        XCTAssertThrowsError(try changedId.verifiedFingerprint(owner: owner, verifier: verifier, now: vectors.clock))
    }

    func testMalformedAndUnsignedTokensNeverAuthenticate() throws {
        let (vectors, keys) = try fixtures()
        let verifier = try GoogleIdentityVerifier(jwks: keys, clientIds: vectors.clientIds)
        let valid = try XCTUnwrap(vectors.tokens["validClient"])
        for token in [
            "",
            "a.b",
            "a.b.c.d",
            "a..c",
            "***.x.x",
            String(repeating: "a", count: 17000),
            String(valid.dropLast(4)) + "AAAA",
        ] {
            XCTAssertThrowsError(try verifier.verify(token, nonce: vectors.clientNonce, now: vectors.clock))
        }
        XCTAssertThrowsError(try GoogleIdentityVerifier(jwks: keys, clientIds: []))
        XCTAssertThrowsError(try GoogleIdentityVerifier(jwks: keys, clientIds: [""]))
        XCTAssertThrowsError(try GoogleIdentityVerifier(jwks: Data("{}".utf8), clientIds: vectors.clientIds))
        XCTAssertThrowsError(try GoogleIdentityVerifier(jwks: Data("{\"keys\":[]}".utf8), clientIds: vectors.clientIds))
        XCTAssertThrowsError(try GoogleIdentityVerifier(jwks: Data(repeating: 32, count: 65537), clientIds: vectors.clientIds))
        XCTAssertNil(cloudBase64URL("a"))
        XCTAssertNil(cloudBase64URL("a="))
    }

    func testDuplicateSigningKeysAndCertificatesOutsideTheirValidityOrHostnameAreRejected() throws {
        let (vectors, keys) = try fixtures()
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: keys) as? [String: Any])
        let list = try XCTUnwrap(parsed["keys"] as? [[String: Any]])
        let duplicate = try JSONSerialization.data(withJSONObject: ["keys": list + list])
        let verifier = try GoogleIdentityVerifier(jwks: duplicate, clientIds: vectors.clientIds)
        XCTAssertThrowsError(try verifier.verify(XCTUnwrap(vectors.tokens["validClient"]), nonce: vectors.clientNonce, now: vectors.clock))
        XCTAssertThrowsError(try vectors.gateway.candidateFingerprint(now: vectors.clock - 86400))
        XCTAssertThrowsError(try vectors.gateway.candidateFingerprint(now: vectors.clock + 20 * 365 * 86400))
        XCTAssertThrowsError(try vectors.gateway.candidateFingerprint(now: .nan))
        let wrongHost = GoogleGatewayBinding(
            gatewayId: vectors.gateway.gatewayId,
            publicOrigin: "https://other.example.test",
            certificate: vectors.gateway.certificate,
            identityToken: vectors.gateway.identityToken
        )
        XCTAssertThrowsError(try wrongHost.candidateFingerprint(now: vectors.clock))
    }

    func testFixtureCertificateHasAUsableTLSIdentity() throws {
        let (vectors, _) = try fixtures()
        let der = try certificateData(vectors.gateway.certificate)
        let certificate = try XCTUnwrap(SecCertificateCreateWithData(nil, der as CFData))
        let host = try XCTUnwrap(URL(string: vectors.gateway.publicOrigin)?.host)
        var trust: SecTrust?
        XCTAssertEqual(SecTrustCreateWithCertificates(certificate, SecPolicyCreateSSL(true, host as CFString), &trust), errSecSuccess)
        let value = try XCTUnwrap(trust)
        XCTAssertEqual(SecTrustSetAnchorCertificates(value, [certificate] as CFArray), errSecSuccess)
        XCTAssertEqual(SecTrustSetAnchorCertificatesOnly(value, true), errSecSuccess)
        XCTAssertEqual(SecTrustSetNetworkFetchAllowed(value, false), errSecSuccess)
        XCTAssertEqual(SecTrustSetVerifyDate(value, Date(timeIntervalSince1970: vectors.clock) as CFDate), errSecSuccess)
        var error: CFError?
        XCTAssertTrue(SecTrustEvaluateWithError(value, &error), "\(String(describing: error))")
    }

    func testMalformedSigningKeysCannotReplaceTheIndependentlyVerifiedGoogleKey() throws {
        let (vectors, keys) = try fixtures()
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: keys) as? [String: Any])
        let key = try XCTUnwrap((root["keys"] as? [[String: Any]])?.first)
        let token = try XCTUnwrap(vectors.tokens["validClient"])
        let fields: [(String, Any)] = [
            ("kty", "EC"), ("alg", "HS256"), ("use", "enc"), ("kid", "foreign-key"),
            ("n", "***"), ("e", "***"), ("n", 1), ("e", 1),
            ("n", Self.encode(Data(repeating: 0, count: 255))), ("n", Self.encode(Data(repeating: 0, count: 513))),
            ("n", Self.encode(Data(repeating: 0, count: 256))),
            ("e", Self.encode(Data([2]))), ("e", Self.encode(Data([1]))),
            ("e", Self.encode(Data(repeating: 1, count: 9))),
        ]
        for (field, value) in fields {
            var candidate = key
            candidate[field] = value
            XCTAssertThrowsError(
                try GoogleIdentityVerifier(
                    jwks: JSONSerialization.data(withJSONObject: ["keys": [candidate]]),
                    clientIds: vectors.clientIds
                ).verify(token, nonce: vectors.clientNonce, now: vectors.clock),
                field
            )
        }
        for field in ["n", "e"] {
            var candidate = key
            candidate.removeValue(forKey: field)
            XCTAssertThrowsError(try GoogleIdentityVerifier(
                jwks: JSONSerialization.data(withJSONObject: ["keys": [candidate]]),
                clientIds: vectors.clientIds
            ).verify(token, nonce: vectors.clientNonce, now: vectors.clock))
        }
        var optional = key
        optional.removeValue(forKey: "alg")
        optional.removeValue(forKey: "use")
        _ = try GoogleIdentityVerifier(jwks: JSONSerialization.data(withJSONObject: ["keys": [optional]]), clientIds: vectors.clientIds)
            .verify(token, nonce: vectors.clientNonce, now: vectors.clock)
        XCTAssertThrowsError(try GoogleIdentityVerifier(
            jwks: JSONSerialization.data(withJSONObject: ["keys": Array(repeating: key, count: 33)]),
            clientIds: vectors.clientIds
        ))
        XCTAssertThrowsError(try GoogleIdentityVerifier(jwks: keys, clientIds: (0 ... 16).map { "fictional-\($0)" }))
        for presenters in [[], [""], (0 ... 16).map { "fictional-\($0)" }] {
            XCTAssertThrowsError(try GoogleIdentityVerifier(jwks: keys, clientIds: vectors.clientIds, presenterClientIds: presenters))
        }
        XCTAssertNil(cloudBase64URL(""))
        XCTAssertNil(cloudBase64URL(String(repeating: "a", count: 32769)))
    }

    func testSignedInvalidClaimsAndHeaderTypesNeverAuthenticate() throws {
        let signer = try TestIdentitySigner()
        let clock = floor(Date().timeIntervalSince1970), nonce = "fictional-private-challenge"
        let verifier = try GoogleIdentityVerifier(
            jwks: signer.jwks,
            clientIds: ["fictional-web"],
            presenterClientIds: ["fictional-web", "fictional-android"]
        )
        let claims: [String: Any] = [
            "iss": "https://accounts.google.com",
            "sub": "fictional-owner",
            "aud": "fictional-web",
            "iat": clock,
            "exp": clock + 3600,
            "nonce": nonce,
        ]
        let identity = try verifier.verify(signer.sign(claims), nonce: nonce)
        XCTAssertEqual(identity.subject, "fictional-owner")
        XCTAssertEqual(identity.expiresAt, clock + 3600)
        var android = claims
        android["azp"] = "fictional-android"
        _ = try verifier.verify(signer.sign(android), nonce: nonce, now: clock)
        let variants: [(String, Any)] = [
            ("iss", 1), ("iss", "foreign-issuer"), ("sub", ""), ("sub", String(repeating: "x", count: 256)),
            ("aud", 1), ("aud", ["fictional-web", 1] as [Any]), ("aud", [String]()), ("aud", "fictional-android"),
            ("azp", "foreign-android"), ("azp", 1), ("exp", true), ("exp", "tomorrow"), ("iat", "now"), ("nonce", 1),
        ]
        for (field, value) in variants {
            var candidate = claims
            candidate[field] = value
            XCTAssertThrowsError(try verifier.verify(signer.sign(candidate), nonce: nonce, now: clock), field)
        }
        for field in ["iss", "sub", "aud", "exp", "iat", "nonce"] {
            var candidate = claims
            candidate.removeValue(forKey: field)
            XCTAssertThrowsError(try verifier.verify(signer.sign(candidate), nonce: nonce, now: clock), field)
        }
        for header in try [
            Data("invalid".utf8),
            Data("[]".utf8),
            Data("{}".utf8),
            JSONSerialization.data(withJSONObject: ["alg": "HS256", "kid": "test-key"]),
            JSONSerialization.data(withJSONObject: ["alg": "RS256", "kid": ""]),
        ] {
            XCTAssertThrowsError(try verifier.verify(signer.sign(claims, header: header), nonce: nonce, now: clock))
        }
    }

    func testCandidateOriginsAreCanonicalAndRejectNumericHostsInvalidPortsAndCertificateBundles() throws {
        let (vectors, _) = try fixtures()
        let host = try XCTUnwrap(URL(string: vectors.gateway.publicOrigin)?.host)
        let canonical = GoogleGatewayBinding(
            gatewayId: vectors.gateway.gatewayId,
            publicOrigin: "https://\(host.uppercased()):443/",
            certificate: vectors.gateway.certificate,
            identityToken: vectors.gateway.identityToken
        )
        XCTAssertEqual(try canonical.candidateOrigin().absoluteString, vectors.gateway.publicOrigin)
        XCTAssertEqual(try vectors.gateway.candidateFingerprint(now: vectors.clock), vectors.fingerprint)
        let longHost = Array(repeating: String(repeating: "a", count: 60), count: 5).joined(separator: ".")
        let longLabel = String(repeating: "a", count: 64)
        let longPath = String(repeating: "a", count: 2048)
        let origins: [String] = [
            "https://127.0.0.1",
            "https://\(host):0",
            "https://\(host):65536",
            "https://\(longHost)",
            "https://\(longLabel).test",
            "https://x.test/\(longPath)",
        ]
        for origin in origins {
            let candidate = GoogleGatewayBinding(
                gatewayId: vectors.gateway.gatewayId,
                publicOrigin: origin,
                certificate: vectors.gateway.certificate,
                identityToken: vectors.gateway.identityToken
            )
            XCTAssertThrowsError(try candidate.candidateOrigin(), origin)
        }
        for certificate in [
            "-----BEGIN CERTIFICATE-----AA==",
            "AA==-----END CERTIFICATE-----",
            vectors.gateway.certificate + vectors.gateway.certificate,
            "-----BEGIN CERTIFICATE-----AA==-----END CERTIFICATE-----",
        ] {
            let candidate = GoogleGatewayBinding(
                gatewayId: vectors.gateway.gatewayId,
                publicOrigin: vectors.gateway.publicOrigin,
                certificate: certificate,
                identityToken: vectors.gateway.identityToken
            )
            XCTAssertThrowsError(try candidate.candidateFingerprint(now: vectors.clock))
        }
    }

    func testTrailingCertificateBytesCannotChangeTheCandidatePin() throws {
        let (vectors, _) = try fixtures()
        var trailing = try certificateData(vectors.gateway.certificate)
        trailing.append(0)
        let certificate = "-----BEGIN CERTIFICATE-----\n\(trailing.base64EncodedString())\n-----END CERTIFICATE-----"
        let candidate = GoogleGatewayBinding(
            gatewayId: vectors.gateway.gatewayId,
            publicOrigin: vectors.gateway.publicOrigin,
            certificate: certificate,
            identityToken: vectors.gateway.identityToken
        )
        let fingerprint: String
        do {
            fingerprint = try candidate.candidateFingerprint(now: vectors.clock)
        } catch {
            XCTAssertEqual(error as? CloudIdentityError, .gateway)
            return
        }
        if fingerprint == vectors.fingerprint {
            XCTAssertEqual(try candidate.candidateFingerprint(now: vectors.clock), vectors.fingerprint)
            return
        }
        let originalData = try certificateData(vectors.gateway.certificate)
        let original = try XCTUnwrap(SecCertificateCreateWithData(nil, originalData as CFData))
        let host = try XCTUnwrap(URL(string: vectors.gateway.publicOrigin)?.host)
        var trust: SecTrust?
        XCTAssertEqual(SecTrustCreateWithCertificates(original, SecPolicyCreateSSL(true, host as CFString), &trust), errSecSuccess)
        let strict = PinnedSession(
            fingerprintHex: fingerprint,
            requireCertificateValidity: true,
            verificationDate: Date(timeIntervalSince1970: vectors.clock)
        )
        XCTAssertEqual(try strict.resolve(XCTUnwrap(trust), challengeHost: host), .rejected)
        var flow = try CloudPairingConfirmation(
            challenge: CloudPairingChallenge(
                name: vectors.request.name,
                requestId: vectors.request.requestId,
                secret: vectors.request.secret
            ),
            candidate: candidate,
            now: vectors.clock
        )
        flow.confirmComparison()
        let approved = CloudPairingProgress(
            status: "approved",
            verificationCode: vectors.verificationCode,
            expiresAt: (vectors.clock + 100) * 1000,
            pairingCode: "SYNTHETIC-CODE"
        )
        XCTAssertThrowsError(try flow.receive(approved, now: vectors.clock))
        XCTAssertThrowsError(try flow.pairingPayload(now: vectors.clock))
    }

    private func certificateData(_ pem: String) throws -> Data {
        let noHeader = pem.replacingOccurrences(of: "-----BEGIN CERTIFICATE-----", with: "")
        let noFooter = noHeader.replacingOccurrences(of: "-----END CERTIFICATE-----", with: "")
        let encoded = noFooter.components(separatedBy: .whitespacesAndNewlines).joined()
        return try XCTUnwrap(Data(base64Encoded: encoded))
    }

    private static func encode(_ value: Data) -> String {
        value.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(
            of: "=",
            with: ""
        )
    }
}

/// Generated in memory so signed negative claims do not require retaining a private fixture key.
private struct TestIdentitySigner {
    let key: SecKey
    let jwks: Data
    init() throws {
        key = try XCTUnwrap(SecKeyCreateRandomKey([kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeySizeInBits: 2048] as CFDictionary, nil))
        let publicKey = try XCTUnwrap(SecKeyCopyPublicKey(key))
        let der = try Array(XCTUnwrap(SecKeyCopyExternalRepresentation(publicKey, nil)) as Data)
        func element(_ input: [UInt8], _ offset: inout Int) -> [UInt8] {
            offset += 1
            let size = Int(input[offset])
            offset += 1
            var length = size
            if size & 128 != 0 {
                length = 0
                for _ in 0 ..< (size & 127) {
                    length = length * 256 + Int(input[offset])
                    offset += 1
                }
            }
            let bytes = Array(input[offset ..< offset + length])
            offset += length
            return bytes
        }
        var outer = 0
        let sequence = element(der, &outer)
        var position = 0
        let modulus = element(sequence, &position).drop(while: { $0 == 0 })
        let exponent = element(sequence, &position).drop(while: { $0 == 0 })
        jwks = try JSONSerialization.data(withJSONObject: ["keys": [[
            "kty": "RSA",
            "kid": "test-key",
            "alg": "RS256",
            "use": "sig",
            "n": Self.encode(Data(modulus)),
            "e": Self.encode(Data(exponent)),
        ]]])
    }

    func sign(_ claims: [String: Any], header: Data = Data("{\"alg\":\"RS256\",\"kid\":\"test-key\"}".utf8)) throws -> String {
        let message = try Self.encode(header) + "." + Self.encode(JSONSerialization.data(withJSONObject: claims))
        let signature = try XCTUnwrap(SecKeyCreateSignature(
            key,
            .rsaSignatureMessagePKCS1v15SHA256,
            Data(message.utf8) as CFData,
            nil
        )) as Data
        return message + "." + Self.encode(signature)
    }

    private static func encode(_ value: Data) -> String {
        value.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(
            of: "=",
            with: ""
        )
    }
}
