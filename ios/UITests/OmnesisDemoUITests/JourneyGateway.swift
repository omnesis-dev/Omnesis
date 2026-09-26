// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Foundation
import XCTest

/// The synthetic gateway a journey drives the app against.
///
/// `scripts/run-mobile-journeys.sh ios` boots it and hands its address, admin
/// token and TLS leaf fingerprint to the on-simulator test runner through
/// `TEST_RUNNER_OMNESIS_JOURNEY_CONFIG` (xcodebuild strips the prefix). The
/// token only ever belongs to that throwaway gateway. The helper talks to the
/// gateway directly to set a journey up — minting a pairing code, reading back
/// what the app did — and never stands in for the app itself.
struct JourneyGateway {
    let url: URL
    let token: String
    let fingerprint: String

    private struct Config: Decodable {
        let gatewayURL: String
        let token: String
        let fingerprint: String
    }

    /// Reads the configuration the journey script supplies. A journey run
    /// without it fails rather than skipping: the journeys exist to be run
    /// against a gateway, and a silent skip would read as a pass.
    static func fromEnvironment() throws -> JourneyGateway {
        guard let raw = ProcessInfo.processInfo.environment["OMNESIS_JOURNEY_CONFIG"],
              let data = raw.data(using: .utf8)
        else {
            throw JourneyGatewayError.missingConfiguration
        }
        let config = try JSONDecoder().decode(Config.self, from: data)
        guard let url = URL(string: config.gatewayURL) else {
            throw JourneyGatewayError.invalidConfiguration(config.gatewayURL)
        }
        return JourneyGateway(url: url, token: config.token, fingerprint: config.fingerprint.lowercased())
    }

    /// `host:port` as the pairing confirmation sheet shows it.
    var hostAndPort: String {
        "\(url.host ?? ""):\(url.port ?? 443)"
    }

    /// The launch-environment pairing the DEBUG app seeds into its Keychain
    /// (`DEMO_PAIRING_JSON`), for journeys that start from a paired app.
    var automationPairingJSON: String {
        let object: [String: String] = [
            "url": url.absoluteString,
            "token": token,
            "fingerprint": fingerprint,
            "name": "Journey Gateway",
        ]
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    /// Mints a one-time iPhone pairing code and returns the QR payload the
    /// gateway would show for it, pinned to the gateway's own certificate.
    func mintPairingPayload(deviceName: String) throws -> String {
        let pending = try post("/admin/devices/pair", body: ["kind": "ios", "name": deviceName])
        guard let code = pending["pairingCode"] as? String else {
            throw JourneyGatewayError.unexpectedResponse("/admin/devices/pair")
        }
        let qr = try post(
            "/admin/devices/pair-qr",
            body: ["pairingCode": code, "gatewayUrl": url.absoluteString, "trustMode": "pinned-leaf"]
        )
        guard let payload = qr["qrPayload"] as? String else {
            throw JourneyGatewayError.unexpectedResponse("/admin/devices/pair-qr")
        }
        return payload
    }

    /// Whether the gateway lists a live device of `kind` with this name.
    func hasDevice(named name: String, kind: String) throws -> Bool {
        let page = try request("GET", "/admin/devices", body: nil)
        let items = page["items"] as? [[String: Any]] ?? []
        return items.contains { item in
            item["name"] as? String == name && item["kind"] as? String == kind
        }
    }

    private func post(_ path: String, body: [String: String]) throws -> [String: Any] {
        try request("POST", path, body: body)
    }

    private func request(_ method: String, _ path: String, body: [String: String]?) throws -> [String: Any] {
        var request = URLRequest(url: url.appendingPathComponent(path))
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let session = URLSession(
            configuration: .ephemeral,
            delegate: PinnedLeafDelegate(fingerprint: fingerprint),
            delegateQueue: nil
        )
        defer { session.finishTasksAndInvalidate() }

        var outcome: Result<(Data, URLResponse), Error>?
        let done = DispatchSemaphore(value: 0)
        session.dataTask(with: request) { data, response, error in
            if let data, let response {
                outcome = .success((data, response))
            } else {
                outcome = .failure(error ?? JourneyGatewayError.unexpectedResponse(path))
            }
            done.signal()
        }.resume()
        guard done.wait(timeout: .now() + 45) == .success, let outcome else {
            throw JourneyGatewayError.timedOut(path)
        }
        let (data, response) = try outcome.get()
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200 ..< 300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw JourneyGatewayError.httpStatus(path, status, text)
        }
        return (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }
}

enum JourneyGatewayError: Error, CustomStringConvertible {
    case missingConfiguration
    case invalidConfiguration(String)
    case unexpectedResponse(String)
    case timedOut(String)
    case httpStatus(String, Int, String)

    var description: String {
        switch self {
        case .missingConfiguration:
            "OMNESIS_JOURNEY_CONFIG is not set. Run the journeys through scripts/run-mobile-journeys.sh ios."
        case .invalidConfiguration(let url):
            "The journey configuration names an invalid gateway URL: \(url)"
        case .unexpectedResponse(let path):
            "The gateway answered \(path) without the expected fields."
        case .timedOut(let path):
            "The gateway did not answer \(path) in time."
        case .httpStatus(let path, let status, let body):
            "The gateway answered \(path) with HTTP \(status): \(body)"
        }
    }
}

/// Trusts exactly the gateway's self-signed leaf certificate, the way a
/// paired app does, so the setup calls never disable certificate checks.
private final class PinnedLeafDelegate: NSObject, URLSessionDelegate {
    private let fingerprint: String

    init(fingerprint: String) {
        self.fingerprint = fingerprint
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first
        else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let digest = SHA256.hash(data: SecCertificateCopyData(leaf) as Data)
            .map { String(format: "%02x", $0) }
            .joined()
        if digest == fingerprint {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}
