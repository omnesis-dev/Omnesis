// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Foundation
import Security

public struct GoogleNativeAuthorization: Sendable {
    public let clientId: String
    public let callbackScheme: String
    public let redirectURI: String
    public let state: String
    public let verifier: String
    public let nonce: String
    public let url: URL
    public let expiresAt: TimeInterval

    public init(clientId: String, nonce: String, now: TimeInterval = Date().timeIntervalSince1970) throws {
        guard clientId.hasSuffix(".apps.googleusercontent.com"), clientId.count <= 512,
              clientId.range(of: "^[A-Za-z0-9.-]+$", options: .regularExpression) != nil,
              !nonce.isEmpty, nonce.utf8.count <= 256 else { throw CloudPairingError.configuration }
        self.clientId = clientId
        callbackScheme = clientId.split(separator: ".").reversed().joined(separator: ".")
        redirectURI = "\(callbackScheme):/oauthredirect"
        state = try cloudSecureRandomBytes().cloudBase64URL
        verifier = try cloudSecureRandomBytes().cloudBase64URL
        self.nonce = nonce
        expiresAt = now + 300
        var components = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        components.queryItems = [
            "client_id": clientId,
            "redirect_uri": redirectURI,
            "response_type": "code",
            "scope": "openid",
            "state": state,
            "nonce": nonce,
            "code_challenge": cloudDigestURL(Data(verifier.utf8)),
            "code_challenge_method": "S256",
        ]
        .sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        // The fixed HTTPS endpoint and URLQueryItems encode every validated string.
        url = components.url!
    }

    public func tokenRequest(callback: URL, now: TimeInterval = Date().timeIntervalSince1970) throws -> Data {
        guard now < expiresAt, let components = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              components.scheme == callbackScheme, components.host == nil, components.path == "/oauthredirect",
              components.fragment == nil, components.user == nil, components.password == nil else { throw CloudPairingError.refused }
        let values = components.queryItems ?? []
        guard values.filter({ $0.name == "state" }).count == 1,
              values.first(where: { $0.name == "state" })?.value == state,
              !values.contains(where: { $0.name == "error" }),
              values.filter({ $0.name == "code" }).count == 1,
              let code = values.first(where: { $0.name == "code" })?.value,
              !code.isEmpty, code.utf8.count <= 8192 else { throw CloudPairingError.refused }
        // OAuth form values escape spaces as %20, which application/x-www-form-urlencoded also accepts.
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        let fields = [
            "client_id": clientId,
            "redirect_uri": redirectURI,
            "code": code,
            "code_verifier": verifier,
            "grant_type": "authorization_code",
        ]
        let sorted = fields.sorted { $0.key < $1.key }
        let encoded = sorted.map { key, value in
            "\(key)=\(value.addingPercentEncoding(withAllowedCharacters: allowed)!)"
        }
        return Data(encoded.joined(separator: "&").utf8)
    }

    public func exchange(
        callback: URL,
        transport: any CloudPairingTransport,
        now: TimeInterval = Date().timeIntervalSince1970
    ) async throws
        -> String {
        let data = try await transport.requestData(
            url: URL(string: "https://oauth2.googleapis.com/token")!,
            method: "POST",
            body: tokenRequest(callback: callback, now: now),
            bearer: nil,
            form: true
        )
        let tokens = try JSONDecoder().decode(GoogleAuthorizationTokens.self, from: data)
        guard tokens.tokenType == "Bearer", !tokens.idToken.isEmpty,
              tokens.idToken.utf8.count <= 16384 else { throw CloudPairingError.response }
        return tokens.idToken
    }
}

/// The platform RNG boundary is injectable internally so an OS entropy failure is tested fail-closed.
func cloudSecureRandomBytes(
    fill: (UnsafeMutableRawPointer) -> OSStatus = { SecRandomCopyBytes(kSecRandomDefault, 32, $0) }
) throws
    -> Data {
    var bytes = [UInt8](repeating: 0, count: 32)
    let status = bytes.withUnsafeMutableBytes { fill($0.baseAddress!) }
    guard status == errSecSuccess else { throw CloudPairingError.configuration }
    return Data(bytes)
}

extension Data {
    fileprivate var cloudBase64URL: String {
        let encoded = base64EncodedString()
        let urlAlphabet = encoded.replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        return urlAlphabet.replacingOccurrences(of: "=", with: "")
    }
}

private struct GoogleAuthorizationTokens: Decodable {
    let idToken: String
    let tokenType: String
    private enum CodingKeys: String, CodingKey {
        case idToken = "id_token"
        case tokenType = "token_type"
    }
}
