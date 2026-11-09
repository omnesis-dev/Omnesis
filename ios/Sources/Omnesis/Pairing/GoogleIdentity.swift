// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Foundation
import Security

public enum CloudIdentityError: Error, Equatable {
    case invalidToken, invalidKey, signature, claims, expired, nonce, account, gateway, configuration
}

public struct VerifiedGoogleIdentity: Equatable, Sendable {
    public let subject: String
    public let expiresAt: TimeInterval

    public let accountId: String

    init(subject: String, expiresAt: TimeInterval) throws {
        self.subject = subject
        self.expiresAt = expiresAt
        let digest = try SHA256.hash(data: cloudTranscript(["https://accounts.google.com", subject]))
        accountId = digest.map { String(format: "%02x", $0) }.joined()
    }
}

/// Verifies Google's signature locally. A relay's verification result is never a trust anchor.
public struct GoogleIdentityVerifier: Sendable {
    private struct Keys: Decodable { let keys: [GoogleSigningKey] }
    private struct Header: Decodable { let alg: String
        let kid: String
    }

    private struct Audience: Decodable {
        let values: [String]
        init(from decoder: Decoder) throws {
            let value = try decoder.singleValueContainer()
            if let string = try? value.decode(String.self) {
                values = [string]
            } else {
                values = try value.decode([String].self)
            }
        }
    }

    private struct Claims: Decodable {
        let iss: String
        let sub: String
        let aud: Audience
        let exp: Double
        let iat: Double
        let nonce: String
        let azp: String?
    }

    private let keys: [GoogleSigningKey]
    private let clientIds: Set<String>
    private let presenterClientIds: Set<String>

    public init(jwks: Data, clientIds: [String], presenterClientIds: [String]? = nil) throws {
        let presenters = presenterClientIds ?? clientIds
        guard jwks.count <= 65536, !clientIds.isEmpty, clientIds.count <= 16,
              clientIds.allSatisfy({ !$0.isEmpty }), !presenters.isEmpty, presenters.count <= 16,
              presenters.allSatisfy({ !$0.isEmpty }) else { throw CloudIdentityError.configuration }
        guard let parsed = try? JSONDecoder().decode(Keys.self, from: jwks),
              !parsed.keys.isEmpty, parsed.keys.count <= 32 else { throw CloudIdentityError.invalidKey }
        keys = parsed.keys
        self.clientIds = Set(clientIds)
        self.presenterClientIds = Set(presenters)
    }

    public func verify(_ token: String, nonce expectedNonce: String, now: TimeInterval = Date().timeIntervalSince1970)
        throws -> VerifiedGoogleIdentity {
        guard token.utf8.count <= 16384 else { throw CloudIdentityError.invalidToken }
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, let headerBytes = cloudBase64URL(String(parts[0])),
              let payloadBytes = cloudBase64URL(String(parts[1])), let signature = cloudBase64URL(String(parts[2])),
              let header = try? JSONDecoder().decode(Header.self, from: headerBytes),
              header.alg == "RS256", !header.kid.isEmpty,
              keys.filter({ $0.kid == header.kid }).count == 1,
              let key = keys.first(where: { $0.kid == header.kid }), key.kty == "RSA",
              key.alg.map({ $0 == "RS256" }) ?? true, key.use.map({ $0 == "sig" }) ?? true,
              let modulus = key.modulus.flatMap(cloudBase64URL), let exponent = key.exponent.flatMap(cloudBase64URL),
              (256 ... 512).contains(modulus.count), (1 ... 8).contains(exponent.count), exponent.last.map({ $0 & 1 == 1 }) == true
        else { throw CloudIdentityError.invalidToken }
        let der = Self.der(0x30, Self.derInteger(modulus) + Self.derInteger(exponent))
        let attributes: [CFString: Any] = [
            kSecAttrKeyType: kSecAttrKeyTypeRSA,
            kSecAttrKeyClass: kSecAttrKeyClassPublic,
            kSecAttrKeySizeInBits: modulus.count * 8,
        ]
        guard let publicKey = SecKeyCreateWithData(der as CFData, attributes as CFDictionary, nil)
        else { throw CloudIdentityError.invalidKey }
        let message = Data("\(parts[0]).\(parts[1])".utf8)
        guard SecKeyVerifySignature(
            publicKey,
            .rsaSignatureMessagePKCS1v15SHA256,
            message as CFData,
            signature as CFData,
            nil
        )
        else { throw CloudIdentityError.signature }
        guard let claims = try? JSONDecoder().decode(Claims.self, from: payloadBytes),
              ["https://accounts.google.com", "accounts.google.com"].contains(claims.iss),
              !claims.sub.isEmpty, claims.sub.utf8.count <= 255,
              claims.aud.values.contains(where: clientIds.contains),
              claims.azp.map(presenterClientIds.contains) ?? true
        else { throw CloudIdentityError.claims }
        guard claims.exp.isFinite, claims.iat.isFinite, claims.exp > now,
              claims.iat <= now, claims.iat >= now - 3600 else { throw CloudIdentityError.expired }
        guard claims.nonce == expectedNonce else { throw CloudIdentityError.nonce }
        return try VerifiedGoogleIdentity(subject: claims.sub, expiresAt: claims.exp)
    }

    private static func derInteger(_ bytes: Data) -> Data {
        der(0x02, bytes.first.map { $0 & 0x80 != 0 } == true ? Data([0]) + bytes : bytes)
    }

    private static func der(_ tag: UInt8, _ value: Data) -> Data {
        let count = value.count
        if count < 128 { return Data([tag, UInt8(count)]) + value }
        var remaining = count
        var length: [UInt8] = []
        while remaining > 0 {
            length.insert(UInt8(remaining & 255), at: 0)
            remaining >>= 8
        }
        return Data([tag, 0x80 | UInt8(length.count)] + length) + value
    }
}

public struct GoogleGatewayBinding: Codable, Equatable, Sendable {
    public let gatewayId: String
    public let publicOrigin: String
    public let certificate: String
    public let identityToken: String

    public func verifiedFingerprint(
        owner: VerifiedGoogleIdentity,
        verifier: GoogleIdentityVerifier,
        now: TimeInterval = Date().timeIntervalSince1970
    ) throws
        -> String {
        let fingerprint = try candidateFingerprint(now: now)
        let origin = try candidateOrigin()
        let nonce = try cloudDigestURL(cloudTranscript([
            "omnesis-gateway-tls-v2",
            gatewayId,
            origin.absoluteString,
            fingerprint,
        ]))
        let gatewayOwner = try verifier.verify(identityToken, nonce: nonce, now: now)
        guard gatewayOwner.subject == owner.subject else { throw CloudIdentityError.account }
        return fingerprint
    }

    /// A directory entry is an untrusted candidate until the independently displayed codes match.
    public func candidateOrigin() throws -> URL {
        guard certificate.utf8.count <= 16384, publicOrigin.utf8.count <= 2048,
              UUID(uuidString: gatewayId) != nil, let components = URLComponents(string: publicOrigin),
              components.scheme == "https", components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil, ["", "/"].contains(components.path),
              let host = components.host?.lowercased(), host.contains("."), host.utf8.count <= 253,
              host.range(of: "^[0-9.]+$", options: .regularExpression) == nil,
              host.split(separator: ".", omittingEmptySubsequences: false).allSatisfy({ label in
                  label.range(of: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", options: .regularExpression) != nil
              }), components.port.map({ (1 ... 65535).contains($0) }) ?? true
        else { throw CloudIdentityError.gateway }
        let port = components.port.flatMap { $0 == 443 ? nil : ":\($0)" } ?? ""
        // The validated ASCII DNS labels and bounded numeric port always form an absolute HTTPS URL.
        return URL(string: "https://\(host)\(port)")!
    }

    /// Parsing proves neither ownership nor identity. Only SAS confirmation establishes this pin.
    public func candidateFingerprint(now: TimeInterval = Date().timeIntervalSince1970) throws -> String {
        try validatedCertificateDER(now: now).sha256Hex
    }

    public func candidateSPKIFingerprint(now: TimeInterval = Date().timeIntervalSince1970) throws -> String {
        try GatewayKeyFingerprint.spki(validatedCertificateDER(now: now))
    }

    private func validatedCertificateDER(now: TimeInterval) throws -> Data {
        let origin = try candidateOrigin()
        let prefix = "-----BEGIN CERTIFICATE-----", suffix = "-----END CERTIFICATE-----"
        let pem = certificate.trimmingCharacters(in: .whitespacesAndNewlines)
        guard pem.hasPrefix(prefix), pem.hasSuffix(suffix) else { throw CloudIdentityError.gateway }
        let encoded = String(pem.dropFirst(prefix.count).dropLast(suffix.count))
            .components(separatedBy: .whitespacesAndNewlines).joined()
        guard now.isFinite, let der = Data(base64Encoded: encoded),
              let certificate = SecCertificateCreateWithData(nil, der as CFData)
        else { throw CloudIdentityError.gateway }
        guard (SecCertificateCopyData(certificate) as Data) == der else { throw CloudIdentityError.gateway }
        // The pin anchors this exact certificate; SSL policy still checks the name and validity.
        var trust: SecTrust?
        guard SecTrustCreateWithCertificates(certificate, SecPolicyCreateSSL(true, origin.host.map { $0 as CFString }), &trust) ==
            errSecSuccess,
            let trust, SecTrustSetAnchorCertificates(trust, [certificate] as CFArray) == errSecSuccess,
            SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
            SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess,
            SecTrustSetVerifyDate(trust, Date(timeIntervalSince1970: now) as CFDate) == errSecSuccess,
            SecTrustEvaluateWithError(trust, nil) else { throw CloudIdentityError.gateway }
        return der
    }
}

func cloudTranscript(_ values: [String]) throws -> Data {
    // These bounded protocol fields contain no non-JSON data. Never escape URL slashes.
    try JSONSerialization.data(withJSONObject: values, options: [.withoutEscapingSlashes])
}

func cloudDigestURL(_ data: Data) -> String {
    let base64 = Data(SHA256.hash(data: data)).base64EncodedString()
    let urlAlphabet = base64.replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
    return urlAlphabet.replacingOccurrences(of: "=", with: "")
}

func cloudBase64URL(_ value: String) -> Data? {
    guard !value.isEmpty, value.utf8.count <= 32768,
          value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil,
          value.count % 4 != 1 else { return nil }
    let padded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") +
        String(repeating: "=", count: (4 - value.count % 4) % 4)
    return Data(base64Encoded: padded)
}

private struct GoogleSigningKey: Decodable, Sendable {
    let kty: String
    let kid: String
    let modulus: String?
    let exponent: String?
    let alg: String?
    let use: String?

    private enum CodingKeys: String, CodingKey {
        case kty, kid, alg, use
        case modulus = "n"
        case exponent = "e"
    }
}
